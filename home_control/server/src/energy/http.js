// Energy: API routes and live updates under /api/energy/…, on the app's shared connection.
import { Store } from './store.js';
import { Engine, UserError } from './engine.js';

export function createEnergy({ client, dataDir, log, house }) {
  const store = new Store(dataDir, log);

  // the phones Home Assistant can send to (its notify services), the Home Assistant app's first
  async function notifyTargets() {
    try {
      const services = await client.send('get_services');
      return Object.keys(services.notify || {})
        .filter((n) => !['send_message', 'persistent_notification', 'notify'].includes(n))
        .map((n) => {
          const raw = n.replace(/^mobile_app_/, '').replace(/_s_/g, '\'s_').replace(/_/g, ' ');
          return { service: `notify.${n}`, name: raw.charAt(0).toUpperCase() + raw.slice(1), phone: n.startsWith('mobile_app_') };
        })
        .sort((a, b) => (b.phone - a.phone) || a.name.localeCompare(b.name));
    } catch { return []; }
  }

  const engine = new Engine({ ha: client, store, log, notifyTargets });
  engine.panel = () => house?.view?.()?.panel || null;
  const snapshot = () => ({ ...engine.snapshot(), dashboardPath: house?.view?.()?.dashboardPath || '/' });

  // ---------- live updates ----------
  const clients = new Set();
  let pushTimer = null; let lastPush = 0;
  engine.on('change', () => {
    if (pushTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastPush));
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
      if (size > 64 * 1024) throw new UserError('That request was too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError('That request wasn\'t valid JSON'); }
  }

  const routes = [
    ['GET', /^\/api\/energy\/state$/, () => snapshot()],
    ['GET', /^\/api\/energy\/settings$/, () => engine.settingsView()],
    ['PUT', /^\/api\/energy\/settings$/, (m, b) => { engine.updateSettings(b || {}); return engine.settingsView(); }],
    ['POST', /^\/api\/energy\/plans$/, (m, b) => { engine.addPlan(b || {}); return snapshot(); }],
    ['PUT', /^\/api\/energy\/plans\/([\w-]+)$/, (m, b) => { engine.updatePlan(m[1], b || {}); return snapshot(); }],
    ['DELETE', /^\/api\/energy\/plans\/([\w-]+)$/, (m) => { engine.deletePlan(m[1]); return snapshot(); }],
    ['POST', /^\/api\/energy\/plans\/([\w-]+)\/skip$/, (m) => { engine.skipPlan(m[1]); return snapshot(); }],
    ['POST', /^\/api\/energy\/ev$/, async (m, b) => { await engine.evSet(String(b.what || ''), b.value); return snapshot(); }],
    ['POST', /^\/api\/energy\/alerts\/test$/, async () => ({ sent: await engine.testAlert() })],
    ['POST', /^\/api\/energy\/refresh$/, async () => { await engine.loadPrefs(); await engine.refreshUsage().catch(() => {}); engine.changed(); return snapshot(); }],
  ];

  async function handle(req, res, url, p) {
    if (!p.startsWith('/api/energy/')) return false;
    try {
      if (p === '/api/energy/live' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return true;
      }
      if (p === '/api/energy/activity' && req.method === 'GET') {
        const before = Number(url.searchParams.get('before')) || Infinity;
        return send(res, 200, { items: engine.events({ before, limit: 60 }), timeZone: engine.tz }), true;
      }
      if (p === '/api/energy/history' && req.method === 'GET') {
        return send(res, 200, await engine.history(url.searchParams.get('days') || 30)), true;
      }
      if (engine.disabled && req.method !== 'GET') throw new UserError('Energy is turned off in Home Control\'s settings', 409);
      for (const [method, re, fn] of routes) {
        const r = re.exec(p);
        if (!r || req.method !== method) continue;
        const body = ['POST', 'PUT'].includes(method) ? await readBody(req) : {};
        return send(res, 200, await fn(r, body)), true;
      }
      send(res, 404, { error: 'Unknown request' });
    } catch (err) {
      if (err instanceof UserError || err.status) send(res, err.status || 400, { error: err.message });
      else if (err.code) send(res, 502, { error: `Home Assistant said: ${err.message}` });
      else { log.error?.(err.stack || String(err)); send(res, 500, { error: `Something went wrong: ${err.message}` }); }
    }
    return true;
  }

  function start() { engine.start(); }
  function shutdown() { try { engine.stop(); } catch (err) { log.error?.(err.message); } for (const res of clients) res.end(); }

  return { engine, store, handle, start, shutdown, snapshot };
}
