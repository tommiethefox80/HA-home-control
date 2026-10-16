// Screenshots of the Wi-Fi pages against the stand-in UniFi network (dev/mock-ha.js).
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/wifi-screens.js [out dir]
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';
const OUT = process.argv[2] || new URL('./screens/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (p, b, m = 'PUT') => fetch(`http://localhost:8099/api/${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
await put('house', { modules: { wifi: true } });
await sleep(1200);
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
async function shot(name, hash, { width = 1200, height = 860, dark = false, full = false, click = null } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: width < 500 ? 2 : 1 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await p.goto(`http://localhost:8099/${hash}`, { waitUntil: 'load' });
  await sleep(2200);
  if (click) { await p.evaluate((t) => { const b = [...document.querySelectorAll('button, a')].find((x) => x.textContent.trim().startsWith(t)); b?.click(); }, click); await sleep(900); }
  await p.screenshot({ path: `${OUT}/wifi-${name}.png`, fullPage: full });
  await p.close();
  console.log(`wifi-${name}.png`);
}
await shot('aps', '#/wifi/');
await shot('networks', '#/wifi/networks');
await shot('devices', '#/wifi/devices', { full: true });
await shot('settings', '#/wifi/settings', { full: true });
await shot('phone-aps', '#/wifi/', { width: 390, height: 844, dark: true });
await shot('phone-devices', '#/wifi/devices', { width: 390, height: 844, dark: true });
await shot('qr', '#/wifi/networks', { click: 'QR code to join' });
await shot('tablet', '#/wifi/', { width: 820, height: 700 });
await browser.close();
