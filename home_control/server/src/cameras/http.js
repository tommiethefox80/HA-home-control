// Cameras: API routes and live updates under /api/cameras/…, on the app's shared connection.
// Pictures come from Home Assistant (its camera proxy), so they work for every make of camera;
// recordings are files in Home Assistant's media folder, served from here so they play in the app.
import fs from 'node:fs';
import { Store } from './store.js';
import { Engine, UserError } from './engine.js';

const VIDEO = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };

export function createCameras({ client, dataDir, log, house, restBase, token, mediaDir, haMediaDir, panel }) {
  const store = new Store(dataDir, log);
  const engine = new Engine({ ha: client, store, log, house, mediaDir, haMediaDir, panel, picture: getPicture });
  const snapshot = () => ({ ...engine.snapshot(), dashboardPath: house?.view?.()?.dashboardPath || '/' });

  // ---------- live updates ----------
  const clients = new Set();
  let pushTimer = null; let lastPush = 0;
  engine.on('change', () => {
    if (pushTimer) return;
    const wait = Math.max(0, 400 - (Date.now() - lastPush));
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
      if (size > 256 * 1024) throw new UserError('That request was too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError('That request wasn\'t valid JSON'); }
  }

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

  /** A picture from the camera now, from Home Assistant's camera proxy (any make of camera; it answers
   *  even for a camera it shows as unavailable). */
  async function getPicture(entity, width) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${restBase}/camera_proxy/${entity}${width ? `?width=${width}` : ''}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
      if (!r.ok) return { status: r.status };
      return { status: 200, type: r.headers.get('content-type') || 'image/jpeg', buf: Buffer.from(await r.arrayBuffer()) };
    } finally { clearTimeout(t); }
  }

  async function picture(res, id, url) {
    const cam = engine.camera(id);
    const width = Math.min(1920, Math.max(160, Number(url.searchParams.get('width')) || 0)) || null;
    try {
      const pic = await getPicture(cam.entity, width);
      if (!pic.buf) { res.writeHead(pic.status === 404 ? 404 : 502, { 'Cache-Control': 'no-store' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': pic.type, 'Content-Length': pic.buf.length, 'Cache-Control': 'no-store' });
      res.end(pic.buf);
    } catch {
      res.writeHead(504, { 'Cache-Control': 'no-store' }); res.end();
    }
  }

  /** A saved clip or picture, with byte ranges so clips can be skipped through. */
  function media(req, res, id, file) {
    const p = engine.recordingPath(id, file);
    let stat = null;
    try { stat = p && fs.statSync(p); } catch { stat = null; }
    if (!stat?.isFile()) { res.writeHead(404); return res.end(); }
    const type = VIDEO[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(p, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' });
    return fs.createReadStream(p).pipe(res);
  }

  const routes = [
    ['GET', /^\/api\/cameras\/state$/, () => snapshot()],
    ['GET', /^\/api\/cameras\/notify-targets$/, () => notifyTargets()],
    ['POST', /^\/api\/cameras\/test-alert$/, async () => ({ sent: await engine.testAlert() })],
    ['POST', /^\/api\/cameras\/cameras$/, (m, b) => { engine.addCamera(String(b.entity || '')); return snapshot(); }],
    ['PUT', /^\/api\/cameras\/cameras\/([\w-]+)$/, (m, b) => { engine.updateCamera(m[1], b); return snapshot(); }],
    ['DELETE', /^\/api\/cameras\/cameras\/([\w-]+)$/, (m) => { engine.removeCamera(m[1]); return snapshot(); }],
    ['POST', /^\/api\/cameras\/order$/, (m, b) => { engine.reorder(Array.isArray(b.ids) ? b.ids.map(String) : []); return snapshot(); }],
    ['POST', /^\/api\/cameras\/cameras\/([\w-]+)\/control$/, async (m, b) => { await engine.control(m[1], String(b.entity || ''), { value: b.value }); return { ok: true }; }],
    ['PUT', /^\/api\/cameras\/settings$/, (m, b) => { engine.updateSettings(b || {}); return snapshot(); }],
  ];

  async function handle(req, res, url, p) {
    if (!p.startsWith('/api/cameras/')) return false;
    try {
      if (p === '/api/cameras/live' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return true;
      }
      if (p === '/api/cameras/activity' && req.method === 'GET') {
        const before = Number(url.searchParams.get('before')) || Infinity;
        return send(res, 200, { items: engine.events({ camera: url.searchParams.get('camera') || null, before, limit: 60 }) }), true;
      }
      let m = /^\/api\/cameras\/cameras\/([\w-]+)\/picture$/.exec(p);
      if (m && req.method === 'GET') { await picture(res, m[1], url); return true; }
      m = /^\/api\/cameras\/media\/([\w-]+)\/([\w.-]+)$/.exec(p);
      if (m && req.method === 'GET') { media(req, res, m[1], m[2]); return true; }
      if (m && req.method === 'DELETE') {
        const f = engine.recordingPath(m[1], m[2]);
        if (f) fs.rmSync(f, { force: true });
        return send(res, 200, { ok: true }), true;
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
      else { log.error?.(err.stack || String(err)); send(res, 500, { error: `Something went wrong: ${err.message}` }); }
    }
    return true;
  }

  function start() { engine.start(); }
  function shutdown() { try { engine.stop(); } catch (err) { log.error?.(err.message); } for (const res of clients) res.end(); }

  return { engine, store, handle, start, shutdown, snapshot };
}
