// Heating: API routes and live updates. Same URLs and behaviour as the standalone Heating Control
// app (/api/state, /api/events, /api/zones/…), so the heating screens are unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { HaClient } from './ha.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { TargetLog, CallLog, buildToday, detectCostEntity, detectOutsideEntity, readOutside } from './history.js';
import { DailyLog, buildInsights } from './insights.js';

export function createHeating({ client, dataDir, log, lightingSummary = () => null }) {
  const store = new Store(dataDir);
  const ha = new HaClient({ client, log });
  const engine = new Engine(ha, store, log);
  engine.targetLog = new TargetLog(dataDir);
  engine.dailyLog = new DailyLog(dataDir);
  engine.callLog = new CallLog(dataDir);
  // how long each of the app's own logs is kept (Settings → History)
  const keep = (k, d) => () => store.data.settings.retention?.[k] ?? d;
  engine.targetLog.keepDays = keep('detailDays', 7);
  engine.callLog.keepDays = keep('detailDays', 7);
  engine.dailyLog.keepDays = keep('dailyDays', 400);
  store.pruneLog();
  let insightsCache = { at: 0, data: null };
  let todayCache = { at: 0, hours: 0, data: null };

  function extras() {
    const s = store.data.settings;
    const outsideId = s.outsideEntity || detectOutsideEntity(ha);
    const costId = s.costEntity || detectCostEntity(ha);
    const c = costId && ha.get(costId);
    const cv = c ? parseFloat(c.state) : NaN;
    return {
      outside: outsideId ? { entity: outsideId, auto: !s.outsideEntity, now: readOutside(ha, outsideId) } : null,
      cost: costId ? { entity: costId, auto: !s.costEntity, today: Number.isFinite(cv) ? cv : null, unit: c?.attributes?.unit_of_measurement || 'GBP' } : null,
    };
  }

  function snapshot() {
    const { settings, zones, runtime } = store.data;
    const entries = store.log;
    return {
      haConnected: ha.connected,
      timeZone: ha.timeZone,
      now: Date.now(),
      mode: runtime.mode,
      houseBoost: runtime.houseBoost && runtime.houseBoost.until > Date.now() && Object.values(runtime.overrides).some((o) => o?.group === 'house') ? runtime.houseBoost : null,
      awayUntil: runtime.awayUntil,
      boiler: engine.boilerView(),
      zones: engine.views,
      schedules: Object.fromEntries(zones.map((z) => [z.id, z.schedule])),
      zoneConfig: zones.map(({ schedule, ...z }) => z),
      settings,
      extras: extras(),
      attention: engine.attention,
      presence: store.data.settings.presence?.enabled ? { people: engine.presenceView(), auto: !!runtime.presenceAway } : null,
      lighting: lightingSummary(),
      log: entries.slice(0, 60),
      logTotal: entries.length,
    };
  }

  // ---- live updates over Server-Sent Events ----
  const clients = new Set();
  let pushTimer = null;
  const push = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const body = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of clients) res.write(body);
    }, 300);
  };
  engine.on('change', push);
  // heartbeat as a named event (comments are invisible to EventSource), so the GUI can spot a dead stream
  setInterval(() => { for (const res of clients) res.write('event: ping\ndata: 1\n\n'); }, 25000);

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
  });

  function entityList() {
    const out = [];
    for (const s of ha.states.values()) {
      const [domain] = s.entity_id.split('.');
      const a = s.attributes || {};
      const isTempSensor = domain === 'sensor' && a.device_class === 'temperature';
      const isMoney = domain === 'sensor' && (a.device_class === 'monetary' || /^(GBP|£|EUR|€|USD|\$)$/.test(a.unit_of_measurement || ''));
      if (domain === 'climate' || isTempSensor || isMoney || domain === 'weather' || domain === 'switch' || domain === 'input_boolean') {
        out.push({
          entity_id: s.entity_id, domain, name: a.friendly_name || s.entity_id, state: s.state,
          kind: isTempSensor ? 'temperature' : isMoney ? 'money' : domain, unit: a.unit_of_measurement || null,
          current: a.current_temperature ?? (isTempSensor ? s.state : undefined),
          integration: a.attribution || null,
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Handle a heating request. Returns false if the path isn't a heating route. */
  async function handle(req, res, url, p) {
    try {
      if (p === '/api/state' && req.method === 'GET') return json(res, 200, snapshot()), true;
      if (p === '/api/entities' && req.method === 'GET') return json(res, 200, entityList()), true;
      if (p === '/api/notify-targets' && req.method === 'GET') {
        let list = [];
        try {
          const services = await ha.send({ type: 'get_services' });
          list = Object.keys(services.notify || {})
            .filter((n) => !['send_message', 'persistent_notification'].includes(n))
            .map((n) => {
              const raw = n.replace(/^mobile_app_/, '').replace(/_s_/g, "'s_").replace(/_/g, ' ');
              return { service: `notify.${n}`, name: raw.charAt(0).toUpperCase() + raw.slice(1), mobile: n.startsWith('mobile_app_') };
            })
            .sort((a, b) => (b.mobile - a.mobile) || a.name.localeCompare(b.name));
        } catch { /* fall back to typing it */ }
        return json(res, 200, list), true;
      }
      if (p === '/api/people' && req.method === 'GET') return json(res, 200, engine.presenceView(true)), true;
      if (p === '/api/insights' && req.method === 'GET') {
        if (!insightsCache.data || Date.now() - insightsCache.at > 5 * 60000 || url.searchParams.has('fresh')) {
          insightsCache = { at: Date.now(), data: await buildInsights(engine, { days: 30 }) };
        }
        return json(res, 200, insightsCache.data), true;
      }
      if (p === '/api/log' && req.method === 'GET') {
        const before = Number(url.searchParams.get('before')) || Date.now();
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        return json(res, 200, { entries: store.logBefore(before, limit), total: store.log.length }), true;
      }
      if (p === '/api/storage' && req.method === 'GET') {
        const files = ['heating.json', 'activity.json', 'daily.json', 'targets.json', 'calls.json', 'lighting.json'].map((name) => {
          try { return { name, bytes: fs.statSync(path.join(dataDir, name)).size }; } catch { return { name, bytes: 0 }; }
        });
        const days = Object.keys(engine.dailyLog.days || {}).sort();
        return json(res, 200, {
          files,
          activity: { entries: store.log.length, oldest: store.log[store.log.length - 1]?.at ?? null },
          daily: { days: days.length, oldest: days[0] || null },
        }), true;
      }
      if (p === '/api/today' && req.method === 'GET') {
        const hours = Math.min(48, Math.max(6, Number(url.searchParams.get('hours')) || 24));
        if (!todayCache.data || Date.now() - todayCache.at > 60000 || todayCache.hours !== hours || url.searchParams.has('fresh')) {
          todayCache = { at: Date.now(), hours, data: await buildToday(engine, { hours }) };
        }
        return json(res, 200, todayCache.data), true;
      }
      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return true;
      }

      let m;
      const route = (method, re) => req.method === method && (m = typeof re === 'string' ? (p === re ? [] : null) : p.match(re));
      const known = route('POST', '/api/mode') || route('PUT', '/api/settings') || route('POST', '/api/zones')
        || route('PUT', /^\/api\/zones\/([\w-]+)$/) || route('DELETE', /^\/api\/zones\/([\w-]+)$/)
        || route('PUT', /^\/api\/zones\/([\w-]+)\/schedule$/) || route('POST', /^\/api\/zones\/([\w-]+)\/override$/)
        || route('DELETE', /^\/api\/zones\/([\w-]+)\/override$/) || route('DELETE', /^\/api\/zones\/([\w-]+)\/learn$/)
        || route('DELETE', /^\/api\/zones\/([\w-]+)\/window$/) || route('POST', '/api/boost') || route('DELETE', '/api/boost')
        || route('POST', '/api/notify/test') || route('POST', '/api/childlock');
      if (!known) return false;
      if (engine.disabled && (/^\/api\/(mode|boost|childlock|notify\/test)$/.test(p) || /\/override$/.test(p))) {
        return json(res, 409, { error: 'Heating is turned off in Home Control\'s settings.' }), true;
      }

      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      if (p === '/api/mode' && req.method === 'POST') engine.setMode(body.mode, body.until);
      else if (p === '/api/settings' && req.method === 'PUT') engine.updateSettings(body);
      else if (p === '/api/zones' && req.method === 'POST') { const z = engine.upsertZone(body); await engine.tick(); return json(res, 200, { id: z.id, state: snapshot() }), true; }
      else if ((m = p.match(/^\/api\/zones\/([\w-]+)$/)) && req.method === 'PUT') engine.upsertZone({ ...body, id: m[1] });
      else if ((m = p.match(/^\/api\/zones\/([\w-]+)$/)) && req.method === 'DELETE') engine.deleteZone(m[1]);
      else if ((m = p.match(/^\/api\/zones\/([\w-]+)\/schedule$/)) && req.method === 'PUT') engine.setSchedule(m[1], body);
      else if ((m = p.match(/^\/api\/zones\/([\w-]+)\/override$/)) && req.method === 'POST') engine.setOverride(m[1], body);
      else if ((m = p.match(/^\/api\/zones\/([\w-]+)\/override$/)) && req.method === 'DELETE') engine.clearOverride(m[1]);
      else if ((m = p.match(/^\/api\/zones\/([\w-]+)\/learn$/)) && req.method === 'DELETE') engine.resetLearning(m[1]);
      else if ((m = p.match(/^\/api\/zones\/([\w-]+)\/window$/)) && req.method === 'DELETE') engine.resumeWindow(m[1]);
      else if (p === '/api/boost' && req.method === 'POST') engine.boostHouse(body);
      else if (p === '/api/boost' && req.method === 'DELETE') engine.stopHouseBoost();
      else if (p === '/api/notify/test' && req.method === 'POST') engine.sendTestAlert(String(body.which));
      else if (p === '/api/childlock' && req.method === 'POST') await engine.setChildLock(body.all ? 'all' : [String(body.entity_id || '')], !!body.on);

      await engine.tick();
      json(res, 200, snapshot());
      return true;
    } catch (e) {
      json(res, 400, { error: e.message });
      return true;
    }
  }

  function start() { engine.start(); }

  async function shutdown() {
    try { store.flush(); } catch {}
    try { store.flushLog(); } catch {}
    try { engine.targetLog.flush(); } catch {}
    try { engine.dailyLog.flush(); } catch {}
    try { engine.callLog.flush(); } catch {}
    try { await engine.handBack(); } catch {}
  }

  // Today's boiler run time and starts, worked out from Home Assistant's history like the app's
  // "Boiler today" card. Kept for two minutes, as it's a history query.
  // Worked out again sooner when the boiler starts or stops, or a different boiler is chosen.
  let boilerCache = { at: 0, key: null, data: null };
  async function boilerToday(fresh = false) {
    const key = `${store.data.settings.boiler?.entity || ''}|${store.data.runtime.boiler?.on ? 1 : 0}`;
    if (fresh || !boilerCache.data || boilerCache.key !== key || Date.now() - boilerCache.at > 120000) {
      try {
        const d = await buildToday(engine, { hours: 24 });
        boilerCache = { at: Date.now(), key, data: { minutes: d.boilerTodayMinutes ?? 0, fires: d.boilerFiresToday ?? 0 } };
      } catch { boilerCache.at = Date.now(); } // try again later; keep what we had
    }
    return boilerCache.data;
  }

  return { engine, store, ha, handle, start, shutdown, snapshot, push, boilerToday };
}
