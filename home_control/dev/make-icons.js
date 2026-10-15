// Draws icon.png and logo.png (shown in Home Assistant's app store and on the app's page)
// from the same house-and-flame mark as the app's favicon. Run: node dev/make-icons.js
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
const ROOT = new URL('../', import.meta.url).pathname;
const mark = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="2.5 3.5 27 26" width="${size}" height="${size}"><path d="M4 15 16 5l12 10v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="#ee8434"/><path d="M16 12.5c.8 2.5 3.4 3.8 3.4 6.8a3.4 3.4 0 0 1-6.8 0c0-1.6.7-2.5 1.5-3.2.2 1.1.8 1.8 1.4 2.1.1-2.3.2-4.2.5-5.7z" fill="white"/></svg>`;
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const page = await browser.newPage();
async function shot(html, w, h, file) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
  await page.screenshot({ path: `${ROOT}${file}`, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}
await shot(`<div style="width:256px;height:256px;display:grid;place-items:center">${mark(232)}</div>`, 256, 256, 'icon.png');
await shot(`<div style="width:500px;height:200px;display:flex;align-items:center;gap:22px;padding-left:12px;font:700 62px/1 'Archivo','Segoe UI',system-ui,sans-serif;letter-spacing:-1px;color:#ee8434">${mark(150)}<span>Home<br>Control</span></div>`, 500, 200, 'logo.png');
await browser.close();
console.log('icon.png and logo.png written');
