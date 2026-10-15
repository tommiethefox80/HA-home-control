// Browser checks for the merged app: the heating half looks exactly as Heating Control 0.15.0 did
// (everything under the header compared pixel by pixel against the original build, served against
// the same server), switching between Heating and Lighting, and screenshots of the heating pages.
// Run: sh dev/run.sh && node dev/seed.js && node dev/home-screens.js [path/to/original/web/dist]
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const APP_URL = 'http://localhost:8099/';
const ORIGINAL = process.argv[2] || '/home/claude/heating-src/unz/heating_control/web/dist';
const OUT = new URL('./screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });

async function page(width, height, dark, original = false) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: 1 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  p.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
  if (original) {
    // the original Heating Control web build, talking to this server's (unchanged) heating API
    await p.setRequestInterception(true);
    p.on('request', (req) => {
      const u = new URL(req.url());
      if (u.port === '8099' && (u.pathname === '/' || u.pathname === '/index.html' || u.pathname.startsWith('/assets/'))) {
        const file = path.join(ORIGINAL, u.pathname === '/' ? 'index.html' : u.pathname);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
        return req.respond({ status: 200, contentType: type, body: readFileSync(file) });
      }
      req.continue();
    });
  }
  return p;
}
const noHScroll = async (p, label) => {
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 0) errors.push(`${label}: horizontal scroll of ${over}px`);
};

/** Everything below the header, as a PNG. Live timestamps ("2 min ago") are blanked in both. */
async function belowHeader(p) {
  // Same header height in both, so everything below sits on the same pixel grid (the header itself
  // is the one intended change), and the fixed tab bar is left out.
  await p.addStyleTag({ content: 'header.top{height:64px!important;min-height:0!important;overflow:hidden!important;margin-bottom:16px!important;padding-top:0!important;padding-bottom:0!important}.tabs,.toast{display:none!important}.chart-card .chart,.chart-card .chart~*{visibility:hidden!important}' });
  await p.evaluate(() => {
    for (const t of document.querySelectorAll('time, .log time')) t.style.visibility = 'hidden';
  });
  await sleep(150);
  const box = await p.evaluate(() => {
    const h = document.querySelector('header.top');
    const r = h.getBoundingClientRect();
    const mb = parseFloat(getComputedStyle(h).marginBottom) || 0;
    const app = document.querySelector('main.app');
    const end = app.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(app).paddingBottom) || 0);
    return { y: r.bottom + mb + window.scrollY, h: end + window.scrollY, w: document.documentElement.clientWidth };
  });
  return p.screenshot({ clip: { x: 0, y: box.y, width: box.w, height: Math.min(box.h - box.y, 4000) }, captureBeyondViewport: true, encoding: 'base64' });
}

let cmp = null;
async function compare(a, b) {
  cmp ??= await browser.newPage();
  return cmp.evaluate(async (a, b) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${src}`; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}`, diff: -1 };
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d');
    g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
    let diff = 0; let firstY = null;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) {
        diff++;
        if (firstY == null) firstY = Math.floor(i / 4 / c.width);
      }
    }
    return { diff, firstY, total: da.length / 4 };
  }, a, b);
}

// ---------- 1. heating looks as it did ----------
if (existsSync(ORIGINAL)) {
  const pages = (process.env.PAGES || '#/,#/schedules,#/insights,#/activity,#/settings').split(',');
  const sizes = process.env.ONLY_DESKTOP ? [[1280, 900, 'desktop']] : [[1280, 900, 'desktop'], [390, 844, 'phone']];
  for (const [w, h, tag] of sizes) {
    for (const dark of [false, true]) {
      const orig = await page(w, h, dark, true);
      const now = await page(w, h, dark);
      for (const hash of pages) {
        for (const p of [orig, now]) {
          await p.goto(APP_URL + hash, { waitUntil: 'load' });
          await p.waitForSelector('header.top');
          await sleep(hash === '#/' || hash === '#/insights' ? 3500 : 1500);
        }
        const [a, b] = [await belowHeader(orig), await belowHeader(now)];
        const r = await compare(a, b);
        if (process.env.KEEP) {
          const tag2 = `${tag}-${dark ? 'dark' : 'light'}-${hash.replace(/[#/]/g, '') || 'rooms'}`;
          writeFileSync(`${OUT}cmp-${tag2}-orig.png`, Buffer.from(a, 'base64'));
          writeFileSync(`${OUT}cmp-${tag2}-now.png`, Buffer.from(b, 'base64'));
        }
        const label = `${tag} ${dark ? 'dark' : 'light'} ${hash}`;
        const share = r.diff > 0 ? (100 * r.diff / r.total).toFixed(3) : 0;
        console.log(`heating vs original, ${label}: ${r.diff < 0 ? `size differs ${r.size}` : `${r.diff} pixels differ (${share}%)${r.firstY != null ? `, first at y=${r.firstY}` : ''}`}`);
        // Settings has two reworded paragraphs (Away automatically is shared with the lights now; the
        // Dashboard button covers both halves), which reflow a little; everything else must match.
        const allowed = hash === '#/settings' ? 12 : 0.05;
        if (r.diff < 0 || share > allowed) errors.push(`${label} looks different from Heating Control 0.15.0`);
      }
      await orig.close(); await now.close();
    }
  }
} else console.log(`(no original build at ${ORIGINAL}, skipping the comparison)`);

// ---------- 2. heating screenshots ----------
for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
  for (const dark of [false, true]) {
    const p = await page(w, h, dark);
    const name = `home-${tag}-${dark ? 'dark' : 'light'}`;
    await p.goto(APP_URL + '#/', { waitUntil: 'load' });
    await p.waitForSelector('.home-switch');
    await sleep(2500);
    await noHScroll(p, `${name} heating`);
    await p.screenshot({ path: `${OUT}${name}-heating.png`, fullPage: true });
    if (!dark) {
      await p.goto(APP_URL + '#/settings', { waitUntil: 'load' });
      await sleep(1200);
      await noHScroll(p, `${name} heating settings`);
      await p.screenshot({ path: `${OUT}${name}-heating-settings.png`, fullPage: true });
    }
    await p.close();
  }
}

// ---------- 3. switching ----------
{
  const p = await page(1280, 900, false);
  await p.goto(APP_URL + '#/schedules', { waitUntil: 'load' });
  await p.waitForSelector('.home-switch');
  await sleep(1500);
  const look = () => p.evaluate(() => ({
    cls: document.body.className, title: document.title, hash: location.hash,
    current: document.querySelector('.home-switch [aria-current="page"]')?.textContent.trim(),
    h1: document.querySelector('h1')?.textContent,
    switchX: Math.round(document.querySelector('.home-switch').getBoundingClientRect().x),
    switchY: Math.round(document.querySelector('.home-switch').getBoundingClientRect().y),
    visibleApps: [...document.querySelectorAll('#root > div')].filter((d) => !d.hidden).length,
  }));
  const a = await look();
  console.log('on heating schedules:', JSON.stringify(a));
  if (!/sec-heating/.test(a.cls) || a.title !== 'Heating' || a.current !== 'Heating' || a.visibleApps !== 1) errors.push(`heating section wrong: ${JSON.stringify(a)}`);
  await p.click('.home-switch a:nth-child(2)');
  await p.waitForSelector('.gcard');
  const b = await look();
  console.log('after switching to lighting:', JSON.stringify(b));
  if (!/sec-lighting/.test(b.cls) || /sec-heating/.test(b.cls) || b.title !== 'Lighting' || b.hash !== '#/lighting/lights' || b.current !== 'Lighting') errors.push(`lighting section wrong: ${JSON.stringify(b)}`);
  if (Math.abs(a.switchX - b.switchX) > 2 || Math.abs(a.switchY - b.switchY) > 2) errors.push(`the switch moved between sections: ${a.switchX},${a.switchY} -> ${b.switchX},${b.switchY}`);
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector('.gcard')).backgroundColor);
  if (!bg || bg === 'rgba(0, 0, 0, 0)') errors.push('lighting cards unstyled after switching');
  await p.click('.home-switch a:nth-child(1)');
  await sleep(500);
  const c = await look();
  console.log('back to heating:', JSON.stringify(c));
  if (c.hash !== '#/schedules') errors.push(`switching back didn't return to the heating page you were on: ${c.hash}`);
  // a dashboard button with ?section=lighting opens straight onto lighting
  const q = await page(1280, 900, false);
  await q.goto(APP_URL + '?section=lighting', { waitUntil: 'load' });
  await q.waitForSelector('.gcard');
  const d = await q.evaluate(() => ({ hash: location.hash, cls: document.body.className }));
  console.log('opened with ?section=lighting:', JSON.stringify(d));
  if (d.hash !== '#/lighting/lights' || !/sec-lighting/.test(d.cls)) errors.push(`?section=lighting didn't open lighting: ${JSON.stringify(d)}`);
  // the Away note on the lighting page, and the link to the shared setting
  await q.goto(APP_URL + '#/lighting/settings', { waitUntil: 'load' });
  await q.waitForSelector('#set-auto-away');
  await q.click('#set-auto-away + p + p a');
  await sleep(800);
  const e = await q.evaluate(() => ({ hash: location.hash, top: Math.round(document.getElementById('set-away')?.getBoundingClientRect().top ?? -1) }));
  console.log('Away link from lighting settings:', JSON.stringify(e));
  if (e.hash !== '#/settings/away' || e.top < 0 || e.top > 200) errors.push(`Away link didn't land on the heating setting: ${JSON.stringify(e)}`);
  await p.close(); await q.close();
}

// ---------- 4. Away from either side shows on both ----------
{
  const p = await page(1280, 900, false);
  await p.goto(APP_URL + '#/lighting/lights', { waitUntil: 'load' });
  await p.waitForSelector('.modebar');
  await p.evaluate(() => [...document.querySelectorAll('.modebar button')].find((b) => b.textContent.includes('Away')).click());
  await sleep(1500);
  await p.click('.home-switch a:nth-child(1)');
  await sleep(800);
  const pressed = await p.evaluate(() => document.querySelector('.modes [aria-pressed="true"]')?.textContent);
  console.log('heating mode after Away on the lighting page:', pressed);
  if (pressed !== 'Away') errors.push(`heating didn't show Away: ${pressed}`);
  await p.screenshot({ path: `${OUT}home-desktop-light-heating-away.png` });
  await p.evaluate(() => [...document.querySelectorAll('.modes button')].find((b) => b.textContent === 'Schedules').click());
  await sleep(1500);
  await p.click('.home-switch a:nth-child(2)');
  await sleep(800);
  const lmode = await p.evaluate(() => document.querySelector('.modebar .seg-on')?.textContent);
  console.log('lighting mode after Schedules on the heating page:', lmode);
  if (!/Schedules/.test(lmode || '')) errors.push(`lighting didn't come back to Schedules: ${lmode}`);
  await p.close();
}

await browser.close();
console.log(errors.length ? `PROBLEMS:\n${errors.join('\n')}` : 'home browser checks passed');
