// Lighting: API routes and live updates under /api/lighting/…, on the app's shared connection.
import { Store } from './store.js';
import { Engine, UserError } from './engine.js';
import { History } from './history.js';
import { normalizeWeek } from './schedule.js';

export function createLighting({ client, dataDir, log, house }) {
  const store = new Store(dataDir, log);
  const engine = new Engine({ ha: client, store, log });
  const history = new History({ ha: client, engine });
  // Away automatically is shared with the heating now, so lighting's own presence check is off.
  store.data.settings.autoAway = false;

  const snapshot = () => {
    const s = engine.snapshot();
    // While paused nothing is sent, so don't show what the schedule would be doing.
    if (store.data.paused) s.groups = s.groups.map((g) => ({ ...g, target: null, status: { text: 'Paused. Nothing is sent to these until you switch over.', tone: 'quiet' } }));
    return { ...s, paused: !!store.data.paused, house: house?.view() ?? null };
  };

  // ---------- live updates ----------
  const clients = new Set();
  let pushTimer = null; let lastPush = 0;
  engine.on('change', () => {
    if (pushTimer) return;
    const wait = Math.max(0, 300 - (Date.now() - lastPush));
    pushTimer = setTimeout(() => {
      pushTimer = null;
      lastPush = Date.now();
      if (!clients.size) return;
      const payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of clients) res.write(payload);
    }, wait);
  });
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1024 * 1024) throw new UserError('That request was too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError('That request wasn\'t valid JSON'); }
  }
  const requireConnected = () => {
    if (!engine.ready) throw Object.assign(new UserError('Not connected to Home Assistant yet. Try again in a moment.'), { status: 503 });
  };
  const requireRunning = () => {
    if (store.data.paused) throw new UserError('Lighting is paused while you switch over from the old Lighting Control app. Finish switching over on the Lights page.');
    requireConnected();
  };

  // ---------- bringing settings across from the old Lighting Control app ----------
  function importSetup(body) {
    const groups = Array.isArray(body?.groups) ? body.groups : [];
    if (!groups.length) throw new UserError('That didn\'t contain any lighting groups');
    // Paused first: both apps would otherwise drive the same lights, and nothing may happen mid-import.
    store.data.paused = true;
    // replace what's here
    store.data.groups = [];
    store.data.schedules = {};
    store.data.overrides = {};
    store.data.scenes = [];
    store.data.scenesSeeded = true;
    const idMap = {};
    for (const g of groups) {
      try {
        const { group } = engine.saveGroup({ ...g, livedIn: !!g.livedIn });
        idMap[g.id] = group.id;
      } catch (err) { log.warn?.(`Skipped a group while importing: ${err.message}`); }
    }
    for (const [oldId, week] of Object.entries(body.schedules || {})) {
      if (idMap[oldId]) store.data.schedules[idMap[oldId]] = normalizeWeek(week);
    }
    let scenes = 0;
    for (const sc of Array.isArray(body.scenes) ? body.scenes : []) {
      const mapped = {};
      for (const [gid, e] of Object.entries(sc.groups || {})) if (idMap[gid]) mapped[idMap[gid]] = e;
      try { engine.saveScene({ ...sc, groups: mapped }); scenes++; } catch (err) { log.warn?.(`Skipped a scene while importing: ${err.message}`); }
    }
    if (body.settings && typeof body.settings === 'object') {
      const { autoAway, autoAwayPeople, autoAwayDelay, ...rest } = body.settings;
      engine.saveSettings(rest);
    }
    store.data.activity = [];
    engine.addActivity(`Brought across ${groups.length} ${groups.length === 1 ? 'group' : 'groups'} and ${scenes} ${scenes === 1 ? 'scene' : 'scenes'} from Lighting Control. Paused until the old app is stopped.`);
    store.flush();
    engine.changed();
    return { groups: Object.keys(idMap).length, scenes };
  }

  function setPaused(paused) {
    if (!paused && store.data.paused) {
      // taking over from the old app: change nothing now, each group follows its schedule from its next change
      for (const g of store.data.groups) engine.leaveAsIsUntilNext(g);
    }
    store.data.paused = !!paused;
    engine.addActivity(paused ? 'Lighting paused.' : 'Lighting started here. This app now controls your lights and sockets.');
    store.flush();
    engine.tick();
  }

  const routes = [
    ['GET', /^\/api\/lighting\/state$/, () => snapshot()],
    ['GET', /^\/api\/lighting\/config$/, () => engine.configSnapshot()],
    ['GET', /^\/api\/lighting\/schedules$/, () => engine.schedulesSnapshot()],
    ['GET', /^\/api\/lighting\/activity$/, () => ({ items: [...engine.data.activity].reverse(), groups: engine.data.groups.map((g) => ({ id: g.id, name: g.name })) })],
    ['GET', /^\/api\/lighting\/history\/([\w-]+)$/, async (m) => { requireConnected(); return history.forGroup(m[1]); }],
    ['GET', /^\/api\/lighting\/export$/, () => ({ groups: store.data.groups, schedules: store.data.schedules, scenes: store.data.scenes, settings: store.data.settings })],
    ['POST', /^\/api\/lighting\/import$/, (m, b) => ({ imported: importSetup(b), ...snapshot() })],
    ['POST', /^\/api\/lighting\/paused$/, (m, b) => { setPaused(b.paused); return snapshot(); }],
    ['POST', /^\/api\/lighting\/mode$/, (m, b) => { requireRunning(); house.setFromLighting(b.mode); return snapshot(); }],
    ['POST', /^\/api\/lighting\/groups\/([\w-]+)\/set$/, (m, b) => { requireRunning(); engine.setGroup(m[1], b); return snapshot(); }],
    ['POST', /^\/api\/lighting\/groups\/([\w-]+)\/resume$/, (m) => { engine.resume(m[1]); return snapshot(); }],
    ['POST', /^\/api\/lighting\/groups$/, (m, b) => engine.saveGroup(b)],
    ['PUT', /^\/api\/lighting\/groups\/([\w-]+)$/, (m, b) => engine.saveGroup(b, m[1])],
    ['DELETE', /^\/api\/lighting\/groups\/([\w-]+)$/, (m) => { engine.deleteGroup(m[1]); return { ok: true }; }],
    ['POST', /^\/api\/lighting\/groups-order$/, (m, b) => { engine.reorderGroups(b.ids); return { ok: true }; }],
    ['PUT', /^\/api\/lighting\/schedules\/([\w-]+)$/, (m, b) => { engine.setSchedule(m[1], b.week); return engine.schedulesSnapshot(); }],
    ['POST', /^\/api\/lighting\/schedules\/([\w-]+)\/copy$/, (m, b) => { const n = engine.copySchedule(m[1], b.to); return { copied: n, ...engine.schedulesSnapshot() }; }],
    ['PUT', /^\/api\/lighting\/settings$/, (m, b) => { const { autoAway, autoAwayPeople, autoAwayDelay, ...rest } = b || {}; return { settings: engine.saveSettings(rest) }; }],
    ['POST', /^\/api\/lighting\/scenes$/, (m, b) => ({ scene: engine.saveScene(b) })],
    ['PUT', /^\/api\/lighting\/scenes\/([\w-]+)$/, (m, b) => ({ scene: engine.saveScene(b, m[1]) })],
    ['DELETE', /^\/api\/lighting\/scenes\/([\w-]+)$/, (m) => { engine.deleteScene(m[1]); return { ok: true }; }],
    ['POST', /^\/api\/lighting\/scenes\/([\w-]+)\/run$/, (m) => { requireRunning(); const n = engine.runScene(m[1]); return { changed: n, ...snapshot() }; }],
  ];

  /** Handle a lighting request. Returns false if the path isn't a lighting route. */
  async function handle(req, res, url, p) {
    if (p === '/api/lighting/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return true;
    }
    for (const [method, re, fn] of routes) {
      const m = re.exec(p);
      if (!m || req.method !== method) continue;
      try {
        const body = ['POST', 'PUT'].includes(method) ? await readBody(req) : {};
        send(res, 200, await fn(m, body));
      } catch (err) {
        if (err instanceof UserError || err.status) send(res, err.status || 400, { error: err.message });
        else { log.error?.(err.stack || String(err)); send(res, 500, { error: `Something went wrong: ${err.message}` }); }
      }
      return true;
    }
    if (p.startsWith('/api/lighting/')) { send(res, 404, { error: 'Unknown request' }); return true; }
    return false;
  }

  function start() { engine.start(); }
  function shutdown() { try { engine.stop(); } catch (err) { log.error?.(err.message); } for (const res of clients) res.end(); }

  return { engine, store, handle, start, shutdown, snapshot };
}
