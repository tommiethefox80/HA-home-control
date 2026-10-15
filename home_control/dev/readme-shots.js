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

await shot('heating', '#/');
await shot('lighting', '#/lighting/lights');
await shot('heating-schedules', '#/schedules', { height: 640, wait: 2000 });
await shot('lighting-schedules', '#/lighting/schedules', { wait: 2500 });
await shot('phone-heating', '#/', { width: 390, height: 844, scale: 2, dark: true });
await shot('phone-lighting', '#/lighting/lights', { width: 390, height: 844, scale: 2, dark: true });
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
