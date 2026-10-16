// Home Control: heating, lighting, cameras and Wi-Fi in one app, served through Home Assistant ingress.
// One connection to Home Assistant, shared by all. Heating keeps its original URLs (/api/…);
// the others live under /api/lighting/…, /api/cameras/… and /api/wifi/…. Each runs independently,
// so a problem in one can't stop the others.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAClient } from './ha.js';
import { createHeating } from './heating/http.js';
import { createLighting } from './lighting/http.js';
import { createCameras } from './cameras/http.js';
import { createWifi } from './wifi/http.js';
import { createHouse } from './house.js';
import { createPublisher } from './publish.js';
import { createCardInstaller, panelPath, selfSlug } from './card.js';
import { applyStagedMove, createMove } from './move.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8099);
const DATA_DIR = process.env.DATA_DIR || '/data';
const WEB_DIR = process.env.WEB_DIR || path.resolve(here, '../../web/dist');
const CARD_FILE = process.env.CARD_FILE || path.resolve(here, '../../dashboard/home-control-card.js');
// Home Assistant's config folder (mapped by the app's config) and the backup folder
const HA_CONFIG_DIR = process.env.HA_CONFIG_DIR || '/homeassistant';
const BACKUP_DIR = process.env.BACKUP_DIR || '/backup';
// Home Assistant's media folder, where camera clips and pictures are saved (as this app sees it, and as Home Assistant does)
const MEDIA_DIR = process.env.MEDIA_DIR || '/media';
const HA_MEDIA_DIR = process.env.HA_MEDIA_DIR || '/media';
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8')).version;
const SUPERVISOR = !!process.env.SUPERVISOR_TOKEN && !process.env.HA_URL;
const HA_URL = process.env.HA_URL
  ? process.env.HA_URL.replace(/^http/, 'ws').replace(/\/$/, '') + (/\/api\/websocket$/.test(process.env.HA_URL) ? '' : '/api/websocket')
  : 'ws://supervisor/core/websocket';
const HA_TOKEN = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
// Home Assistant's REST API, for writing the dashboard sensors
const REST_BASE = process.env.HA_URL
  ? process.env.HA_URL.replace(/^ws/, 'http').replace(/\/api\/websocket$/, '').replace(/\/$/, '') + '/api'
  : 'http://supervisor/core/api';

const stamp = () => new Date().toISOString().slice(11, 19);
const plain = (m) => console.log(`[${stamp()}] ${m}`);
const logObj = {
  info: (m) => console.log(`[${stamp()}] ${m}`),
  warn: (m) => console.warn(`[${stamp()}] WARN ${m}`),
  error: (m) => console.error(`[${stamp()}] ERROR ${m}`),
};
if (!HA_TOKEN) { plain('No Home Assistant token: set HA_URL and HA_TOKEN when running outside Home Assistant'); process.exit(1); }

// Moving in from another Home Control: the staged files go in place before anything reads them.
try { applyStagedMove(DATA_DIR, logObj); } catch (err) { logObj.error(`Couldn't finish moving in: ${err.message}`); }

const client = new HAClient({ url: HA_URL, token: HA_TOKEN, log: logObj });
const house = createHouse({ log: logObj, dataDir: DATA_DIR });
let lighting = null;
const lightingSummary = () => {
  if (!lighting || !house.on('lighting')) return null;
  const groups = lighting.engine.data.groups.length;
  if (!groups) return { groups: 0 };
  let on = 0;
  for (const g of lighting.engine.data.groups) for (const id of g.devices) if (lighting.engine.states.get(id)?.state === 'on') on++;
  return { groups, on, paused: !!lighting.store.data.paused };
};
const heating = createHeating({ client, dataDir: DATA_DIR, log: plain, lightingSummary });
lighting = createLighting({ client, dataDir: DATA_DIR, log: logObj, house });
const cameras = createCameras({ client, dataDir: DATA_DIR, log: logObj, house, restBase: REST_BASE, token: HA_TOKEN, mediaDir: MEDIA_DIR, haMediaDir: HA_MEDIA_DIR, panel: panelPath });
const wifi = createWifi({ client, dataDir: DATA_DIR, log: logObj, house, restBase: REST_BASE, token: HA_TOKEN });
house.attach(heating, lighting, cameras, wifi);
house.panel = panelPath;
lighting.engine.on('change', () => heating.push());
/** Nothing set up yet (a fresh install): no rooms, no boiler and no lighting groups. */
const isEmpty = () => !heating.store.data.zones.length && !heating.store.data.settings.boiler?.entity && !lighting.store.data.groups.length && !cameras.store.data.cameras.length && !house.on('wifi');
createPublisher({ restBase: REST_BASE, token: HA_TOKEN, log: logObj, heating, lighting, cameras, wifi, client, panel: panelPath, isEmpty, house });
const card = createCardInstaller({ client, log: logObj, version: VERSION, source: CARD_FILE, configDir: HA_CONFIG_DIR });
const move = createMove({ dataDir: DATA_DIR, backupDir: BACKUP_DIR, log: logObj, isEmpty, panel: panelPath, slug: selfSlug, card });

// ---------- static web app ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(WEB_DIR, pathname));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('GUI not built'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  // Under the Supervisor, only accept traffic from the ingress proxy.
  if (SUPERVISOR && !process.env.ALLOW_DIRECT) {
    const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
    if (ip !== '172.30.32.2' && ip !== '127.0.0.1' && ip !== '::1') { res.writeHead(403); return res.end(); }
  }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  if (!p.startsWith('/api/')) return serveStatic(req, res, p === '/' ? '/index.html' : p);
  if (p === '/api/house') { if (await house.handle(req, res, p)) return; }
  else if (p.startsWith('/api/move') || p === '/api/card') { if (await move.handle(req, res, p)) return; }
  else if (p.startsWith('/api/lighting/')) { if (await lighting.handle(req, res, url, p)) return; }
  else if (p.startsWith('/api/cameras/')) { if (await cameras.handle(req, res, url, p)) return; }
  else if (p.startsWith('/api/wifi/')) { if (await wifi.handle(req, res, url, p)) return; }
  else if (await heating.handle(req, res, url, p)) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

client.start();
heating.start();
lighting.start();
cameras.start();
wifi.start();
card.start();
server.listen(PORT, () => plain(`Home Control ${VERSION} listening on :${PORT}, Home Assistant at ${HA_URL}`));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  plain('Stopping');
  lighting.shutdown();
  cameras.shutdown();
  wifi.shutdown();
  await heating.shutdown();
  client.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
