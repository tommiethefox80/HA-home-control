// Bringing lights across from the old Lighting Control app, in the browser, as it happens inside
// Home Assistant: a stand-in Home Assistant page (same origin) hosts the app in an iframe and answers
// the Supervisor calls; the real old app (0.2.4) runs on :8098 behind a stand-in ingress address.
// Run on fresh data: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/import-test.js [old app dir]
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OLD_DIR = process.argv[2] || '/home/claude/ha-lighting/lighting_control';
const APP = 'http://localhost:8099'; const OLD = 'http://localhost:8098'; const MOCK = 'http://localhost:8124';
const OUT = new URL('./screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => (await fetch(url)).json();
const errors = [];
const check = (ok, msg) => { if (!ok) errors.push(msg); };

// ---- the old app, with a realistic set-up ----
const oldData = mkdtempSync(path.join(os.tmpdir(), 'old-lighting-'));
let oldProc = spawn('node', [path.join(OLD_DIR, 'server/src/index.js')], {
  env: { ...process.env, HA_URL: 'http://localhost:8123', HA_TOKEN: 'dev', DATA_DIR: oldData, PORT: '8098' }, stdio: 'ignore',
});
await sleep(2500);
execFileSync('node', [new URL('./seed.js', import.meta.url).pathname], { env: { ...process.env, LIGHTING_API: `${OLD}/api/` }, stdio: 'inherit' });
const oldCfg = await get(`${OLD}/api/config`);
console.log(`old app has ${oldCfg.groups.length} groups and ${oldCfg.scenes.length} scenes`);
check((await get(`${APP}/api/lighting/state`)).groups.length === 0, 'expected no lighting groups here yet (run on fresh data)');

// ---- stand-in Home Assistant: Supervisor answers, and the old app's ingress address ----
const sup = { state: 'started', boot: 'auto', calls: [] };
const HA_PAGE = `<!doctype html><html><body style="margin:0">
<home-assistant></home-assistant>
<iframe id="panel" src="/#/lighting/lights" style="border:0;width:100vw;height:100vh;display:block"></iframe>
<script>
  document.querySelector('home-assistant').hass = {
    callWS: async (msg) => {
      if (msg.type !== 'supervisor/api') throw { code: 'unknown_command', message: 'Unknown command.' };
      return window.__supervisor(msg.endpoint, msg.method, msg.data || null);
    },
  };
</script></body></html>`;

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 400/.test(m.text())) errors.push(`console ${m.text()}`); });
await page.exposeFunction('__supervisor', async (endpoint, method, data) => {
  sup.calls.push(`${method} ${endpoint}${data ? ` ${JSON.stringify(data)}` : ''}`);
  if (endpoint === '/addons') return { addons: [{ slug: 'bea84e52_home_control', name: 'Home Control', state: 'started' }, { slug: 'local_lighting_control', name: 'Lighting Control', state: sup.state }] };
  if (endpoint === '/addons/local_lighting_control/info') return { name: 'Lighting Control', slug: 'local_lighting_control', state: sup.state, boot: sup.boot, ingress_url: '/api/hassio_ingress/old-token/' };
  if (endpoint === '/addons/local_lighting_control/stop') {
    oldProc.kill('SIGTERM');
    await sleep(800);
    sup.state = 'stopped';
    await fetch(`${MOCK}/reset-calls`, { method: 'POST' }); // from here on, every call is from this app
    return {};
  }
  if (endpoint === '/addons/local_lighting_control/options') { if (data?.boot) sup.boot = data.boot; return {}; }
  throw { code: 'not_found', message: `No such endpoint ${endpoint}` };
});
await page.setRequestInterception(true);
page.on('request', async (req) => {
  const u = new URL(req.url());
  if (u.port !== '8099') return req.continue();
  if (u.pathname === '/__ha/') return req.respond({ status: 200, contentType: 'text/html', body: HA_PAGE });
  if (u.pathname.startsWith('/api/hassio_ingress/old-token/')) {
    if (sup.state !== 'started') return req.respond({ status: 502, contentType: 'text/plain', body: 'Bad gateway' });
    const r = await fetch(OLD + u.pathname.replace('/api/hassio_ingress/old-token', ''));
    return req.respond({ status: r.status, contentType: 'application/json', body: await r.text() });
  }
  req.continue();
});

await page.goto(`${APP}/__ha/`, { waitUntil: 'load' });
const frame = async () => { const f = await (await page.$('#panel')).contentFrame(); return f; };
let f = await frame();

// 1. Empty lighting page offers to bring the lights across
await f.waitForSelector('.bring button', { timeout: 15000 });
await page.screenshot({ path: `${OUT}import-1-offer.png` });
const offer = await f.$eval('.bring', (e) => e.textContent);
console.log('offer:', offer.slice(0, 120));
check(/Lighting Control is installed/.test(offer), 'no offer to bring lights across');
const statesBefore = await get(`${MOCK}/states`);
await f.click('.bring button');
await f.waitForSelector('.paused', { timeout: 20000 });
await sleep(1000);
await page.screenshot({ path: `${OUT}import-2-paused.png` });

const st = await get(`${APP}/api/lighting/state`);
const cfg = await get(`${APP}/api/lighting/config`);
console.log(`brought across: ${st.groups.map((g) => g.name).join(', ')} | scenes ${cfg.scenes.map((s) => s.name).join(', ')} | paused ${st.paused}`);
check(st.paused === true, 'not paused after import');
check(st.groups.length === oldCfg.groups.length, `groups: ${st.groups.length} vs ${oldCfg.groups.length}`);
check(cfg.scenes.length === oldCfg.scenes.length, `scenes: ${cfg.scenes.length} vs ${oldCfg.scenes.length}`);
check(cfg.settings.stepSize === 5, `settings not brought across (step ${cfg.settings.stepSize})`);
check(cfg.settings.autoAway === false, 'the old app\'s own Away automatically should be off here (the house does it)');
const sch = (await get(`${APP}/api/lighting/schedules`)).schedules;
const oldSch = (await get(`${OLD}/api/schedules`)).schedules;
check(JSON.stringify(sch.lounge) === JSON.stringify(oldSch.lounge), 'Lounge schedule differs from the old app');
const panel = await f.$eval('.paused', (e) => e.textContent);
console.log('paused panel:', panel.slice(0, 160));
check(/6 groups and 2 scenes brought across/.test(panel), `paused panel text: ${panel}`);
const chip = await f.$eval('.status-chip', (e) => e.textContent);
check(/Paused/.test(chip), `status chip: ${chip}`);
// controls refuse politely while paused
await f.evaluate(() => [...document.querySelectorAll('.scene-btn')].find((b) => b.textContent.includes('All off')).click());
await sleep(800);
const refusal = await f.evaluate(() => document.querySelector('.notice-error')?.textContent || '');
console.log('pressing All off while paused:', refusal);
check(/paused/i.test(refusal), 'All off while paused should explain it is paused');

// 2. Switch over: stops the old app, keeps it from starting at boot, starts lighting here, changes nothing
const label = await f.$eval('.paused .btn-primary', (e) => e.textContent);
console.log('button:', label);
check(/Stop Lighting Control and start here/.test(label), `switch-over button says: ${label}`);
await f.click('.paused .btn-primary');
await f.waitForFunction(() => !document.querySelector('.paused'), { timeout: 15000 });
await sleep(6000);
console.log('supervisor calls:', sup.calls.join(' | '));
check(sup.calls.includes('post /addons/local_lighting_control/stop'), 'old app not stopped');
check(sup.calls.some((c) => c.startsWith('post /addons/local_lighting_control/options') && c.includes('"boot":"manual"')), 'old app still starts at boot');
const st2 = await get(`${APP}/api/lighting/state`);
check(st2.paused === false, 'still paused after switching over');
const calls = (await get(`${MOCK}/calls`)).filter((c) => ['light', 'switch'].includes(c.domain));
console.log(`light/socket commands after switching over: ${calls.length}`);
check(calls.length === 0, `switching over changed lights: ${JSON.stringify(calls)}`);
const statesAfter = await get(`${MOCK}/states`);
const changed = Object.keys(statesBefore).filter((k) => statesBefore[k].state !== statesAfter[k].state);
check(!changed.length || changed.every((k) => calls.length === 0), `lights changed: ${changed.join(', ')}`);
console.log('group status after switching over:', st2.groups.map((g) => `${g.name}: ${g.status.text}`).join(' | '));
await page.screenshot({ path: `${OUT}import-3-running.png` });

// 3. Settings mentions the stopped old app
await f.evaluate(() => { window.location.hash = '#/lighting/settings/start'; });
await f.waitForSelector('#set-old');
const oldNote = await f.$eval('#set-old', (e) => e.closest('section').textContent);
check(/installed but stopped/.test(oldNote), `settings note: ${oldNote}`);
await f.evaluate(() => document.getElementById('set-old').scrollIntoView());
await page.screenshot({ path: `${OUT}import-4-settings.png` });

// 4. Outside Home Assistant (no Supervisor to ask), nothing is offered and nothing breaks
const plain = await browser.newPage();
plain.on('pageerror', (e) => errors.push(`pageerror (plain) ${e.message}`));
await plain.goto(`${APP}/#/lighting/settings/start`, { waitUntil: 'load' });
await plain.waitForSelector('#set-tips');
check(!(await plain.$('#set-old')), 'old app section shown without Home Assistant');

await browser.close();
try { oldProc.kill(); } catch { /* already stopped */ }
console.log(errors.length ? `PROBLEMS:\n${errors.join('\n')}` : 'import checks passed');
process.exit(errors.length ? 1 : 0);
