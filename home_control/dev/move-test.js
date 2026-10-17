// Moving in from the Home Control installed by hand (the 1.2.0 release), end to end in the browser,
// as it happens inside Home Assistant: a stand-in Home Assistant page hosts this app in an iframe and
// answers the Supervisor and dashboard calls. The old app really runs (its own data folder), backups
// are made in Supervisor's format (dev/make-backup.py, securetar), and "restart" really restarts
// this app. Needs: the 1.2.0 release unpacked (OLD_APP) and a Python with securetar (SECURETAR_PY).
//   sh dev/run.sh stop; node dev/move-test.js
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const SCRATCH = process.env.SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), 'move-test-'));
const OLD_APP = process.env.OLD_APP || '/tmp/claude-0/-home-claude/ab8679e5-0b51-5ccd-8645-88778a0517cc/scratchpad/old120/heating_control';
const PY = process.env.SECURETAR_PY || '/tmp/claude-0/-home-claude/ab8679e5-0b51-5ccd-8645-88778a0517cc/scratchpad/st/bin/python';
const ME = 'bea84e52_home_control';
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../server/package.json'), 'utf8')).version;
const APP = 'http://localhost:8099'; const OLD = 'http://localhost:8097'; const MOCK = 'http://localhost:8124';
const OUT = path.join(HERE, 'screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url}: ${d.error || r.status}`);
  return d;
};
const dirs = { old: path.join(SCRATCH, 'old-data'), neu: path.join(SCRATCH, 'new-data'), backup: path.join(SCRATCH, 'backup'), ha: path.join(SCRATCH, 'homeassistant') };
for (const d of Object.values(dirs)) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
fs.mkdirSync(path.join(dirs.ha, 'www'));
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }

// ---------- processes ----------
const procs = {};
async function waitUp(url) { for (let i = 0; i < 60; i++) { try { await fetch(url); return; } catch { await sleep(250); } } throw new Error(`${url} never came up`); }
async function stop(name) {
  const p = procs[name];
  if (!p || p.exitCode != null) return;
  const gone = new Promise((r) => p.once('exit', r));
  p.kill('SIGTERM');
  await gone;
}
function start(name, args, env) {
  const log = fs.openSync(path.join(SCRATCH, `${name}.log`), 'a');
  procs[name] = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', log, log] });
}
const startMock = () => start('mock', [path.join(HERE, 'mock-ha.js')], {});
const startOld = () => start('old', [path.join(OLD_APP, 'server/src/index.js')], { HA_URL: 'http://localhost:8123', HA_TOKEN: 'dev', DATA_DIR: dirs.old, PORT: '8097', WEB_DIR: path.join(OLD_APP, 'web/dist') });
const startNew = () => start('new', [path.join(ROOT, 'server/src/index.js')], {
  HA_URL: 'http://localhost:8123', HA_TOKEN: 'dev', DATA_DIR: dirs.neu, PORT: '8099',
  BACKUP_DIR: dirs.backup, HA_CONFIG_DIR: dirs.ha, APP_SLUG: ME,
});
process.on('exit', () => { for (const p of Object.values(procs)) try { p.kill('SIGKILL'); } catch { /* gone */ } });

startMock(); await waitUp(`${MOCK}/calls`);
startNew(); await waitUp(`${APP}/api/move`);

await step('a fresh install says nothing to Home Assistant, and keeps its dashboard card up to date', async () => {
  await sleep(6000);
  const pub = await j('GET', `${MOCK}/published`);
  assert.equal(pub.count, 0, `wrote ${JSON.stringify(Object.keys(pub.states))}`);
  const st = await j('GET', `${APP}/api/move`);
  assert.equal(st.empty, true);
  assert.equal(st.panel, `/${ME}`);
  const card = fs.readFileSync(path.join(dirs.ha, 'www/home-control-card.js'), 'utf8');
  assert.ok(card.includes(`const VERSION = '${VERSION}'`), 'card copied');
  const res = await j('GET', `${MOCK}/resources`);
  assert.deepEqual(res.map((r) => r.url), [`/local/home-control-card.js?v=${VERSION}`], JSON.stringify(res));
  assert.equal(st.card.resource, 'updated');
});

// ---------- the old app, set up like a real house ----------
startOld(); await waitUp(`${OLD}/api/state`);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
await j('PUT', `${OLD}/api/settings`, { boiler: { entity: 'climate.heating', onTemp: 30, offTemp: 7, minOnMinutes: 0, minOffMinutes: 0 }, dashboardPath: '/dashboard-home', awayTemp: 13 });
for (const [name, trv, sensor, temp] of [['Lounge', 'climate.lounge_trv', 'sensor.lounge_temperature', 21], ['Bedroom', 'climate.bedroom_trv', null, 18]]) {
  const sched = Object.fromEntries(DAYS.map((d) => [d, [{ time: '06:30', temp }, { time: '22:30', temp: 16 }]]));
  await j('POST', `${OLD}/api/zones`, { name, trvs: [trv], ...(sensor ? { sensor } : {}), schedule: sched });
}
execFileSync('node', [path.join(HERE, 'seed.js')], { env: { ...process.env, LIGHTING_API: `${OLD}/api/lighting/` }, stdio: 'ignore' });
await sleep(7000); // let the old app save everything
const oldState = await j('GET', `${OLD}/api/state`);
const oldLight = await j('GET', `${OLD}/api/lighting/config`);
const oldSched = (await j('GET', `${OLD}/api/lighting/schedules`)).schedules;
console.log(`old app: ${oldState.zones.length} rooms, ${oldLight.groups.length} groups, ${oldLight.scenes.length} scenes`);

// ---------- stand-in Home Assistant ----------
const sup = { old: { state: 'started', boot: 'auto', ingress_panel: true, watchdog: true }, me: { ingress_panel: false }, calls: [], fail: null, backups: 0 };
const boards = {
  '': { title: 'Overview', mode: 'storage', config: { views: [{ cards: [
    { type: 'custom:home-control-card', show: 'heating', panel: '/local_heating_control' },
    { type: 'button', name: 'Heating', tap_action: { action: 'navigate', navigation_path: '/local_heating_control' } },
  ] }] } },
  'dashboard-home': { title: 'Home', mode: 'storage', config: { views: [{ cards: [
    { type: 'button', name: 'Lights', tap_action: { action: 'navigate', navigation_path: '/local_heating_control?section=lighting' } },
    { type: 'button', name: 'Other', tap_action: { action: 'navigate', navigation_path: '/local_heating_controller' } },
  ] }] } },
  'wall-tablet': { title: 'Wall tablet', mode: 'yaml', config: { views: [{ cards: [{ type: 'button', tap_action: { action: 'navigate', navigation_path: '/local_heating_control' } }] }] } },
  'energy-board': { title: 'Energy', mode: 'storage', config: { strategy: { type: 'energy' } } },
};
const saved = {};
const HA_PAGE = `<!doctype html><html><body style="margin:0">
<home-assistant></home-assistant>
<iframe id="panel" src="/" style="border:0;width:100vw;height:100vh;display:block"></iframe>
<script>
  document.querySelector('home-assistant').hass = {
    callWS: async (msg) => {
      const r = await window.__ws(JSON.stringify(msg));
      if (r.error) throw r.error;
      return r.result;
    },
  };
</script></body></html>`;

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const errors = [];
async function openPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  await page.exposeFunction('__ws', async (raw) => {
    const msg = JSON.parse(raw);
    try { return { result: await ws(msg) }; } catch (e) { return { error: { code: e.code || 'error', message: e.message } }; }
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.port === '8099' && u.pathname === '/__ha/') return req.respond({ status: 200, contentType: 'text/html', body: HA_PAGE });
    return req.continue();
  });
  await page.goto(`${APP}/__ha/`, { waitUntil: 'load' });
  return page;
}
const frame = async (page) => (await page.$('#panel')).contentFrame();

async function ws(msg) {
  if (msg.type === 'lovelace/dashboards/list') return Object.entries(boards).filter(([k]) => k).map(([k, b]) => ({ url_path: k, title: b.title, mode: b.mode }));
  if (msg.type === 'lovelace/config') {
    const b = boards[msg.url_path || ''];
    if (!b) throw Object.assign(new Error('No config found.'), { code: 'config_not_found' });
    return JSON.parse(JSON.stringify(b.config));
  }
  if (msg.type === 'lovelace/config/save') {
    const b = boards[msg.url_path || ''];
    if (b.mode === 'yaml') throw new Error('Not supported');
    saved[msg.url_path || ''] = msg.config; b.config = msg.config;
    return null;
  }
  if (msg.type !== 'supervisor/api') throw Object.assign(new Error('Unknown command.'), { code: 'unknown_command' });
  const { endpoint, method, data } = msg;
  sup.calls.push(`${method} ${endpoint}${data ? ` ${JSON.stringify(data)}` : ''}`);
  if (sup.fail && endpoint.includes(sup.fail)) throw new Error(`Supervisor said no to ${sup.fail}`);
  if (endpoint === '/addons') {
    return { addons: [
      { slug: 'local_heating_control', name: 'Home Control', version: '1.2.0', state: sup.old.state },
      { slug: ME, name: 'Home Control', version: VERSION, state: 'started' },
      { slug: 'local_lighting_control', name: 'Lighting Control', version: '0.2.4', state: 'stopped' },
    ] };
  }
  if (endpoint === '/addons/local_heating_control/info') return { name: 'Home Control', slug: 'local_heating_control', version: '1.2.0', state: sup.old.state, boot: sup.old.boot, ingress_panel: sup.old.ingress_panel, watchdog: sup.old.watchdog, ingress_url: '/api/hassio_ingress/old/' };
  if (endpoint === '/backups/new/partial') {
    assert.deepEqual(data.addons, ['local_heating_control']);
    assert.equal(data.location, null);
    const slug = `0dd${String(++sup.backups).padStart(5, '0')}`;
    execFileSync(PY, [path.join(HERE, 'make-backup.py'), path.join(dirs.backup, `${slug}.tar`), slug, 'local_heating_control', '1.2.0', dirs.old], { stdio: 'ignore' });
    return { slug, job_id: 'j1' };
  }
  if (endpoint === '/addons/local_heating_control/stop') { await stop('old'); sup.old.state = 'stopped'; return {}; }
  if (endpoint === '/addons/local_heating_control/start') { startOld(); await waitUp(`${OLD}/api/state`); sup.old.state = 'started'; return {}; }
  if (endpoint === '/addons/local_heating_control/options') { Object.assign(sup.old, data); return {}; }
  if (endpoint === `/addons/${ME}/options`) { Object.assign(sup.me, data); return {}; }
  if (endpoint === `/addons/${ME}/restart`) { await stop('new'); startNew(); await waitUp(`${APP}/api/move`); return {}; }
  throw Object.assign(new Error(`No such endpoint ${endpoint}`), { code: 'not_found' });
}

// ---------- 1. something goes wrong part-way: everything goes back as it was ----------
await step('if stopping the old app fails, everything is put back and nothing is staged', async () => {
  const page = await openPage();
  const f = await frame(page);
  await f.waitForSelector('.move-card button', { timeout: 15000 });
  const text = await f.$eval('.move-card', (e) => e.textContent);
  assert.match(text, /Bring everything across/);
  assert.match(text, /\(1\.2\.0\)/);
  await page.screenshot({ path: path.join(OUT, 'move-1-offer.png') });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'move-1-offer-phone.png') });
  await page.setViewport({ width: 1100, height: 900 });
  sup.fail = '/addons/local_heating_control/stop';
  await f.click('.move-card button');
  await f.waitForSelector('.move-card .banner', { timeout: 30000 });
  const err = await f.$eval('.move-card .banner', (e) => e.textContent);
  assert.match(err, /Supervisor said no.*Nothing has changed/, err);
  await page.screenshot({ path: path.join(OUT, 'move-2-failed.png') });
  const st = await j('GET', `${APP}/api/move`);
  assert.equal(st.staged, false, 'staged files left behind');
  assert.equal(st.empty, true);
  assert.equal(sup.old.state, 'started');
  assert.equal(sup.old.boot, 'auto');
  sup.fail = null;
  await page.close();
});

// ---------- 2. the real thing ----------
let page;
await step('one press: backs up, copies, stops the old app and restarts here with everything', async () => {
  sup.calls.length = 0;
  page = await openPage();
  const f = await frame(page);
  await f.waitForSelector('.move-card button', { timeout: 15000 });
  await f.click('.move-card button');
  await f.waitForSelector('.move-steps li.mv-now', { timeout: 10000 });
  await page.screenshot({ path: path.join(OUT, 'move-3-moving.png') });
  // the page reloads itself once this app is back with everything
  await page.waitForFunction(() => {
    const d = document.querySelector('#panel')?.contentDocument;
    return !!d?.querySelector('.moved');
  }, { timeout: 90000, polling: 500 });
  const order = sup.calls.map((c) => c.split(' ').slice(0, 2).join(' ')).filter((c) => !c.endsWith('/info') && c !== 'get /addons');
  assert.deepEqual(order, ['post /backups/new/partial', 'post /addons/local_heating_control/stop', 'post /addons/local_heating_control/options', `post /addons/${ME}/options`, `post /addons/${ME}/restart`]);
  assert.deepEqual(sup.me, { ingress_panel: true, watchdog: true });
  assert.equal(sup.old.boot, 'manual');
  assert.equal(sup.old.ingress_panel, false);
  assert.equal(sup.old.state, 'stopped');
});

await step('rooms, boiler, settings, groups, schedules and scenes are all here, exactly', async () => {
  const st = await j('GET', `${APP}/api/state`);
  assert.deepEqual(st.zones.map((z) => z.name), oldState.zones.map((z) => z.name));
  assert.equal(st.settings.boiler.entity, 'climate.heating');
  assert.equal(st.settings.dashboardPath, '/dashboard-home');
  assert.equal(st.settings.awayTemp, 13);
  const cfg = await j('GET', `${APP}/api/lighting/config`);
  assert.deepEqual(cfg.groups.map((g) => g.name), oldLight.groups.map((g) => g.name));
  assert.deepEqual(cfg.scenes, oldLight.scenes);
  // every setting the old app had came across (settings added since start at their defaults)
  assert.deepEqual(Object.fromEntries(Object.keys(oldLight.settings).map((k) => [k, cfg.settings[k]])), oldLight.settings);
  assert.deepEqual((await j('GET', `${APP}/api/lighting/schedules`)).schedules, oldSched);
  // the files themselves came across
  const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  assert.deepEqual(read(dirs.neu, 'heating.json').zones, read(dirs.old, 'heating.json').zones);
  const oldLog = read(dirs.old, 'activity.json').entries;
  const newLog = read(dirs.neu, 'activity.json').entries;
  assert.ok(oldLog.length > 0, 'old app had no Activity');
  assert.deepEqual(newLog.slice(-oldLog.length), oldLog, 'Activity history');
  assert.ok(!fs.existsSync(path.join(dirs.neu, 'move-in')), 'staging folder left behind');
});

await step('the page says so, dashboard links now open here, and the YAML dashboard is named', async () => {
  const f = await frame(page);
  await f.waitForFunction(() => /now open here/.test(document.querySelector('.moved')?.textContent || ''), { timeout: 15000 });
  const text = await f.$eval('.moved', (e) => e.textContent);
  assert.match(text, /2 rooms, 6 lighting groups, 2 scenes/, text);
  assert.match(text, /3 links on Overview and Home now open here/, text);
  assert.match(text, /Wall tablet still has links to the old app, to change by hand/, text);
  await page.screenshot({ path: path.join(OUT, 'move-4-done.png') });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'move-4-done-phone.png') });
  await page.setViewport({ width: 1100, height: 900 });
  const flat = JSON.stringify(saved);
  assert.ok(flat.includes(`"panel":"/${ME}"`), flat);
  assert.ok(flat.includes(`"navigation_path":"/${ME}"`), flat);
  assert.ok(flat.includes(`"navigation_path":"/${ME}?section=lighting"`), flat);
  assert.ok(flat.includes('"/local_heating_controller"'), 'changed a link that only looked similar');
  assert.ok(!('wall-tablet' in saved) && !('energy-board' in saved));
  const st = await j('GET', `${APP}/api/move`);
  assert.equal(st.moved.links.changed, 3);
});

await step('the dashboard sensors come from here now, with this app\'s address', async () => {
  await sleep(5000);
  const pub = (await j('GET', `${MOCK}/published`)).states;
  assert.equal(pub['sensor.home_heating'].attributes.panel, `/${ME}`);
  assert.equal(pub['sensor.home_lighting'].attributes.panel, `/${ME}`);
  assert.equal(pub['sensor.home_heating'].attributes.rooms.length, 2);
});

await step('Done puts the note away for good', async () => {
  const f = await frame(page);
  await f.click('.moved-ok');
  await f.waitForFunction(() => !document.querySelector('.moved'), { timeout: 5000 });
  assert.equal((await j('GET', `${APP}/api/move`)).moved.dismissed, true);
  await page.reload({ waitUntil: 'load' });
  const f2 = await frame(page);
  await f2.waitForSelector('.home-switch', { timeout: 15000 });
  assert.equal(await f2.$('.moved'), null);
  assert.equal(await f2.$('.move-card'), null);
  await page.screenshot({ path: path.join(OUT, 'move-5-after.png') });
});

await browser.close();
assert.deepEqual(errors, []);
for (const n of Object.keys(procs)) await stop(n);
console.log(`${passed} move checks passed`);
process.exit(0);
