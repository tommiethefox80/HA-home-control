// Screenshots for the README on GitHub, from the stand-in Home Assistant with a seeded house.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/readme-shots.js
// (then node dev/card-preview.js for the dashboard cards, copied in by this script if present)
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';

const APP = 'http://localhost:8099/';
const OUT = new URL('../../docs/screenshots/', import.meta.url).pathname;
const SCREENS = new URL('./screens/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
async function shot(name, hash, { width = 1200, height = 860, scale = 1, dark = false, wait = 3500, full = false } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: scale });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await p.goto(APP + hash, { waitUntil: 'load' });
  await sleep(wait);
  // the tab bar floats over the bottom of the page; leave it where it is, as it looks in the app
  await p.screenshot({ path: `${OUT}${name}.png`, fullPage: full });
  await p.close();
  console.log(`${name}.png`);
}

// cameras: turned on, the four stand-in cameras added, some movement and a camera offline
const put = (p, b, m = 'PUT') => fetch(`http://localhost:8099/api/${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const mockSensor = (entity, state) => fetch('http://localhost:8124/sensor', { method: 'POST', body: JSON.stringify({ entity, state }) });
await put('house', { modules: { cameras: true, wifi: true, energy: true } });
// energy: the stand-in Octopus (Intelligent Octopus Go, a Home Mini, a car), and a plan
await fetch('http://localhost:8124/octopus', { method: 'POST', body: JSON.stringify({ on: true, tariff: 'iog' }) });
await sleep(800);
const camState = await (await fetch('http://localhost:8099/api/cameras/state')).json();
for (const c of camState.candidates) await put('cameras/cameras', { entity: c.entity }, 'POST');
for (const id of ['garden', 'front_door', 'driveway', 'shed']) await put(`cameras/cameras/${id}`, { record: { seconds: 3 } });
await put('cameras/settings', { notify: ['notify.mobile_app_toms_iphone'] });
await put('cameras/cameras/driveway', { alerts: { when: 'always' }, card: ['light.driveway_floodlight', 'siren.driveway_siren'] });
await mockSensor('binary_sensor.driveway_person', 'on');
await mockSensor('event.front_door_ding', new Date().toISOString());
await sleep(2500);
await mockSensor('binary_sensor.garden_motion', 'on');
await mockSensor('camera.shed', 'unavailable');
await put('wifi/settings', { leds: { mode: 'off_between', from: '22:00', to: '07:00' } });
await put('energy/plans', { name: 'Dishwasher', entity: 'switch.dishwasher_plug', minutes: 120, by: '07:00' }, 'POST');
await sleep(6000); // the clips are finished

await shot('heating', '#/');
await shot('lighting', '#/lighting/lights');
await shot('heating-schedules', '#/schedules', { height: 640, wait: 2000 });
await shot('lighting-schedules', '#/lighting/schedules', { wait: 2500 });
await shot('phone-heating', '#/', { width: 390, height: 844, scale: 2, dark: true });
await shot('phone-lighting', '#/lighting/lights', { width: 390, height: 844, scale: 2, dark: true });
await shot('cameras', '#/cameras/', { wait: 4000 });
await shot('camera-activity', '#/cameras/activity', { height: 640, wait: 3000 });
await shot('wifi', '#/wifi/', { height: 760, wait: 2500 });
await shot('wifi-devices', '#/wifi/devices', { height: 760, wait: 2500 });
await shot('energy', '#/energy/', { height: 1060, wait: 3000 });
await shot('phone-energy', '#/energy/', { width: 390, height: 844, scale: 2, dark: true });
// the dashboard cards from dev/card-preview.js: just the heating and lighting cards
for (const [from, to] of [['card-light-880.png', 'dashboard-cards.png'], ['card-dark-880.png', 'dashboard-cards-dark.png']]) {
  if (!fs.existsSync(SCREENS + from)) continue;
  const p = await browser.newPage();
  await p.setViewport({ width: 880, height: 440, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0"><img src="data:image/png;base64,${fs.readFileSync(SCREENS + from).toString('base64')}"></body>`);
  await p.screenshot({ path: OUT + to, clip: { x: 0, y: 0, width: 880, height: 428 } });
  await p.close();
  console.log(to);
}
await browser.close();
