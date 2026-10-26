// Wi-Fi: API routes and live updates under /api/wifi/…, on the app's shared connection.
import { Store } from './store.js';
import { Engine, UserError } from './engine.js';

export function createWifi({ client, dataDir, log, house, restBase, token }) {
  const store = new Store(dataDir, log);

  /** An image from Home Assistant (a network's QR code). */
  async function getImage(entity) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${restBase}/image_proxy/${entity}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
      if (!r.ok) return { status: r.status };
      return { status: 200, type: r.headers.get('content-type') || 'image/png', buf: Buffer.from(await r.arrayBuffer()) };
    } finally { clearTimeout(t); }
  }

  const engine = new Engine({ ha: client, store, log, house, picture: getImage });
  const snapshot = () => ({ ...engine.snapshot(), dashboardPath: house?.view?.()?.dashboardPath || '/' });

  // ---------- live updates ----------
  const clients = new Set();
  let pushTimer = null; let lastPush = 0;
  engine.on('change', () => {
    if (pushTimer) return;
    const wait = Math.max(0, 600 - (Date.now() - lastPush));
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
  const bool = (v, what) => { if (typeof v !== 'boolean') throw new UserError(`Say whether to turn ${what} on or off`); return v; };

  const routes = [
    ['GET', /^\/api\/wifi\/state$/, () => snapshot()],
    ['GET', /^\/api\/wifi\/settings$/, () => engine.settingsView()],
    ['PUT', /^\/api\/wifi\/settings$/, (m, b) => { engine.updateSettings(b || {}); return engine.settingsView(); }],
    ['POST', /^\/api\/wifi\/networks\/([\w-]+)\/power$/, async (m, b) => { await engine.setNetwork(m[1], bool(b.on, 'the network')); return snapshot(); }],
    ['PUT', /^\/api\/wifi\/networks\/([\w-]+)$/, (m, b) => { engine.updateNetwork(m[1], b); return engine.settingsView(); }],
    ['POST', /^\/api\/wifi\/networks\/([\w-]+)\/qr$/, async (m) => engine.showQr(m[1])],
    ['POST', /^\/api\/wifi\/devices\/([0-9a-fA-F:]+)\/led$/, async (m, b) => { await engine.setLed(m[1], bool(b.on, 'the light')); return snapshot(); }],
    ['POST', /^\/api\/wifi\/leds$/, async (m, b) => ({ changed: await engine.setAllLeds(bool(b.on, 'the lights')) })],
    ['POST', /^\/api\/wifi\/devices\/([0-9a-fA-F:]+)\/restart$/, async (m) => { await engine.restart(m[1]); return { ok: true }; }],
    ['POST', /^\/api\/wifi\/devices\/([0-9a-fA-F:]+)\/power$/, async (m, b) => { await engine.setPower(m[1], bool(b.on, 'the access point')); return snapshot(); }],
    ['PUT', /^\/api\/wifi\/devices\/([0-9a-fA-F:]+)$/, (m, b) => { engine.updateDevice(m[1], b); return engine.settingsView(); }],
    ['PUT', /^\/api\/wifi\/ports\/(switch\.[a-z0-9_]+)$/, (m, b) => { engine.updatePort(m[1], b || {}); return engine.settingsView(); }],
    ['POST', /^\/api\/wifi\/clients\/block$/, async (m, b) => { await engine.setBlocked(String(b.entity || ''), bool(b.blocked, 'blocking')); return snapshot(); }],
    ['POST', /^\/api\/wifi\/track-all$/, async () => ({ turnedOn: await engine.trackAll() })],
  ];

  async function handle(req, res, url, p) {
    if (!p.startsWith('/api/wifi/')) return false;
    try {
      if (p === '/api/wifi/live' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return true;
      }
      if (p === '/api/wifi/activity' && req.method === 'GET') {
        const before = Number(url.searchParams.get('before')) || Infinity;
        return send(res, 200, { items: engine.events({ before, limit: 60 }) }), true;
      }
      const qr = /^\/api\/wifi\/networks\/([\w-]+)\/qr\.png$/.exec(p);
      if (qr && req.method === 'GET') {
        const img = await engine.qrImage(qr[1]).catch(() => null);
        if (!img?.buf) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return true; }
        res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.buf.length, 'Cache-Control': 'no-store' });
        res.end(img.buf);
        return true;
      }
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
