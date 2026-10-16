// Turning heating or lighting off in Settings → Home Control, and back on.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/modules-test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const OUT = new URL('./screens/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || r.status), { status: r.status });
  return d;
};
const house = (m, b) => j(m, `${APP}/api/house`, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const calls = async () => (await mock('GET', '/calls'));
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }

await step('heating and lighting are on to start with, cameras and Wi-Fi off', async () => {
  const h = await house('GET');
  assert.deepEqual(h.modules, { heating: true, lighting: true, cameras: false, wifi: false });
  assert.equal(typeof h.dashboardPath, 'string');
  assert.ok(Array.isArray(h.people));
});

await step('heating off: radiators handed back, sensors removed, nothing more sent', async () => {
  await sleep(4000);
  assert.ok((await mock('GET', '/published')).states['sensor.home_heating'], 'heating sensor there before');
  await mock('POST', '/reset-calls');
  const h = await house('PUT', { modules: { heating: false } });
  assert.equal(h.modules.heating, false);
  await sleep(2500);
  const c = await calls();
  assert.ok(c.some((x) => x.domain === 'climate' && x.service === 'set_hvac_mode' && x.data.hvac_mode === 'auto'), `handed back: ${JSON.stringify(c)}`);
  const pub = (await mock('GET', '/published')).states;
  assert.ok(!pub['sensor.home_heating'] && !pub['binary_sensor.home_boiler'] && !pub['sensor.home_boiler_today'], `still there: ${Object.keys(pub)}`);
  assert.ok(pub['sensor.home_lighting'], 'lighting sensor kept');
  // a knob turned by hand is no business of ours now, and nothing is sent back
  await mock('POST', '/reset-calls');
  await mock('POST', '/knob', { entity: 'climate.lounge_trv', temperature: 25 });
  await sleep(3000);
  assert.deepEqual((await calls()).filter((x) => x.domain === 'climate'), []);
  assert.ok(!(await j('GET', `${APP}/api/state`)).log.some((l) => /changed by hand to 25/.test(l.msg)), 'took the knob for a hold');
  await assert.rejects(j('POST', `${APP}/api/boost`, { temp: 22, minutes: 30 }), (e) => e.status === 409 && /turned off/.test(e.message));
  const log = await j('GET', `${APP}/api/log`);
  assert.ok(JSON.stringify(log).includes('Heating turned off in Home Control'), 'Activity says so');
});

await step('both off is refused', async () => {
  await assert.rejects(house('PUT', { modules: { lighting: false } }), (e) => e.status === 400 && /at least one/.test(e.message));
  assert.deepEqual((await house('GET')).modules, { heating: false, lighting: true, cameras: false, wifi: false });
});

await step('with heating off, Away on the Lighting page leaves the heating alone', async () => {
  const before = (await j('GET', `${APP}/api/state`)).mode;
  await j('POST', `${APP}/api/lighting/mode`, { mode: 'away' });
  await sleep(500);
  assert.equal((await j('GET', `${APP}/api/state`)).mode, before);
  assert.equal((await j('GET', `${APP}/api/lighting/state`)).mode, 'away');
  await j('POST', `${APP}/api/lighting/mode`, { mode: 'schedule' });
});

await step('the setting survives a restart (house.json)', async () => {
  const saved = JSON.parse(fs.readFileSync(new URL('./data/house.json', import.meta.url), 'utf8'));
  assert.equal(saved.modules.heating, false);
});

await step('heating back on: it takes over again and its sensors come back', async () => {
  await mock('POST', '/reset-calls');
  await house('PUT', { modules: { heating: true } });
  await sleep(4000);
  const c = await calls();
  assert.ok(c.some((x) => x.domain === 'climate'), 'radiators driven again');
  assert.ok((await mock('GET', '/published')).states['sensor.home_heating'], 'heating sensor back');
});

await step('lighting off: lights left as they are, events ignored, controls refused', async () => {
  const before = await mock('GET', '/states');
  await mock('POST', '/reset-calls');
  await house('PUT', { modules: { lighting: false } });
  await sleep(4000);
  assert.ok(!(await mock('GET', '/published')).states['sensor.home_lighting'], 'lighting sensor removed');
  await mock('POST', '/fire', { event_type: 'lighting_control_scene', data: { scene: 'all-off' } });
  await mock('POST', '/human', { entity: 'light.kitchen_spots', on: false });
  await sleep(3000);
  const lc = (await calls()).filter((x) => ['light', 'switch'].includes(x.domain));
  assert.deepEqual(lc, [], `sent to lights: ${JSON.stringify(lc)}`);
  const after = await mock('GET', '/states');
  assert.equal(after['light.lounge_ceiling'].state, before['light.lounge_ceiling'].state);
  await assert.rejects(j('POST', `${APP}/api/lighting/groups/lounge/set`, { on: false }), (e) => e.status === 409);
});

await step('lighting back on: nothing changes until each group\'s next scheduled change', async () => {
  // while it's off, someone puts the Lounge the other way from what its schedule wants
  const lounge = (await j('GET', `${APP}/api/lighting/state`)).groups.find((g) => g.id === 'lounge');
  const want = !!lounge.target?.on;
  await mock('POST', '/human', { entity: 'light.lounge_ceiling', on: !want, ...(!want ? { brightness: 50 } : {}) });
  await sleep(1500);
  await mock('POST', '/reset-calls');
  await house('PUT', { modules: { lighting: true } });
  await sleep(4000);
  const lc = (await calls()).filter((x) => ['light', 'switch'].includes(x.domain));
  assert.deepEqual(lc, [], `sent to lights: ${JSON.stringify(lc)}`);
  assert.equal((await mock('GET', '/states'))['light.lounge_ceiling'].state, !want ? 'on' : 'off', 'Lounge put back');
  const st = await j('GET', `${APP}/api/lighting/state`);
  assert.match(st.groups.find((g) => g.id === 'lounge').status.text, /Left as it is until|until/);
  assert.ok((await mock('GET', '/published')).states['sensor.home_lighting'], 'lighting sensor back');
});

// ---------- in the browser ----------
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const errors = [];
async function open(hash, width = 1100, height = 900, scale = 1) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: scale });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${APP}/${hash}`, { waitUntil: 'load' });
  await sleep(1500);
  return p;
}

await step('the Settings menu: General first (parts, Away, Dashboard), then a group for each part', async () => {
  const p = await open('#/settings');
  await p.waitForSelector('.setf-nav');
  const nav = await p.$eval('.setf-nav', (e) => e.textContent);
  assert.match(nav, /General.*What it looks after.*Away automatically.*Dashboard button.*Heating.*Rooms.*Boiler.*History.*Lighting/s);
  // heating's own page shows beside it, with no general settings mixed in
  assert.match(await p.$eval('.setf-page', (e) => e.textContent), /^Rooms/);
  assert.equal(await p.$$eval('.section h2', (hs) => hs.filter((h) => /Away automatically|Dashboard button/.test(h.textContent)).length), 0, 'still in heating settings');
  await p.screenshot({ path: `${OUT}modules-heating-settings.png` });
  // a general page is the same from any part
  await p.goto(`${APP}/#/lighting/settings/parts`, { waitUntil: 'load' });
  await p.waitForSelector('.home-set');
  assert.match(await p.$eval('.home-set', (e) => e.textContent), /What it looks after.*Heating.*Lighting.*Cameras.*Wi-Fi/s);
  await p.goto(`${APP}/#/settings/presence`, { waitUntil: 'load' });
  await p.waitForSelector('#home-away');
  // links from before the menu still land
  await p.goto(`${APP}/#/settings/away`, { waitUntil: 'load' });
  await p.waitForSelector('#home-away');
  // a page in another part is a link into that part
  await p.goto(`${APP}/#/settings/boiler`, { waitUntil: 'load' });
  await p.waitForSelector('.setf-nav');
  await p.evaluate(() => [...document.querySelectorAll('.setf-group h3 button')].find((b) => /Lighting/.test(b.textContent)).click());
  await p.evaluate(() => [...document.querySelectorAll('.setf-nav a')].find((a) => a.textContent.trim() === 'Scenes').click());
  await p.waitForFunction(() => /sec-lighting/.test(document.body.className) && location.hash === '#/lighting/settings/scenes', { timeout: 5000 });
  await p.waitForSelector('#set-scenes, .setf-page .settings-section');
  await p.close();
});

await step('turning lighting off from the page asks first, then hides lighting', async () => {
  const p = await open('#/lighting/settings/parts', 390, 844, 2);
  await p.waitForSelector('#mod-lighting');
  await p.click('#mod-lighting');
  await p.waitForSelector('.home-confirm');
  assert.match(await p.$eval('.home-confirm', (e) => e.textContent), /Turn off lighting\?.*stay as they are/s);
  await p.evaluate(() => document.querySelector('.home-confirm').scrollIntoView({ block: 'center' }));
  await p.screenshot({ path: `${OUT}modules-confirm-phone.png` });
  await p.click('.home-btn-strong');
  // off the lighting page it goes, onto heating, with no switch: just "Heating"
  await p.waitForFunction(() => /sec-heating/.test(document.body.className) && !location.hash.includes('lighting'), { timeout: 8000 });
  await p.waitForSelector('.home-solo');
  assert.equal(await p.$('.home-switch'), null);
  assert.match(await p.$eval('.home-solo', (e) => e.textContent), /Heating/);
  assert.equal((await house('GET')).modules.lighting, false);
  await p.screenshot({ path: `${OUT}modules-heating-only-phone.png` });
  // the last part on can't be turned off
  await p.goto(`${APP}/#/settings/parts`, { waitUntil: 'load' });
  await p.waitForSelector('#mod-heating');
  assert.equal(await p.$eval('#mod-heating', (e) => e.disabled), true);
  // and on again, straight away (no question)
  await p.click('#mod-lighting');
  await p.waitForSelector('.home-switch', { timeout: 8000 });
  assert.equal((await house('GET')).modules.lighting, true);
  await p.close();
});

await step('a lighting link while lighting is off opens heating', async () => {
  await house('PUT', { modules: { lighting: false } });
  const p = await open('?section=lighting');
  await p.waitForSelector('.home-solo');
  assert.match(await p.evaluate(() => location.hash), /^#\/?$/);
  await p.close();
  await house('PUT', { modules: { lighting: true } });
});

await browser.close();
assert.deepEqual(errors, []);
console.log(`\n${passed} module checks passed`);
