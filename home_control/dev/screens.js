// Browser checks for the lighting half: screenshots at desktop and 390px wide, light and dark, plus real flows.
// (dev/home-screens.js covers the heating half and switching between them.)
// Run: sh dev/run.sh && node dev/seed.js && node dev/screens.js
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { mkdirSync } from 'node:fs';

const APP_URL = 'http://localhost:8099/';
const OUT = new URL('./screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });

async function page(width, height, dark) {
  const p = await browser.newPage();
  await p.setViewport({ width, height, deviceScaleFactor: 1 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  p.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
  return p;
}

async function noHScroll(p, label) {
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 0) errors.push(`${label}: horizontal scroll of ${over}px`);
}

async function shoot(p, name) {
  await sleep(400);
  await p.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
}

const clickText = (p, sel, text) => p.evaluate((s, t) => {
  const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().startsWith(t));
  if (!el) throw new Error(`no ${s} with ${t}`);
  el.click();
}, sel, text);

for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
  for (const dark of [false, true]) {
    const name = `${tag}-${dark ? 'dark' : 'light'}`;
    const p = await page(w, h, dark);
    await p.goto(APP_URL + '#/lighting/lights', { waitUntil: 'load' });
    await p.waitForSelector('.gcard');
    await sleep(1200);
    await noHScroll(p, name);
    await shoot(p, `${name}-lights`);
    if (dark && tag === 'phone') { await p.close(); continue; }
    // details sheet
    await p.click('.gname');
    await p.waitForSelector('.sheet');
    await shoot(p, `${name}-sheet`);
    await p.keyboard.press('Escape');
    await p.goto(APP_URL + '#/lighting/schedules/lounge', { waitUntil: 'load' });
    await p.waitForSelector('.day');
    await noHScroll(p, `${name} schedules`);
    await shoot(p, `${name}-schedules`);
    await p.click('.day');
    await p.waitForSelector('.point');
    await shoot(p, `${name}-day`);
    await p.keyboard.press('Escape');
    if (!dark) {
      await p.goto(APP_URL + '#/lighting/settings', { waitUntil: 'load' });
      await p.waitForSelector('.group-list');
      await noHScroll(p, `${name} settings`);
      await shoot(p, `${name}-settings`);
      await clickText(p, 'button', 'Edit');
      await p.waitForSelector('.dev-picker');
      await shoot(p, `${name}-editor`);
      await p.keyboard.press('Escape');
      await p.goto(APP_URL + '#/lighting/activity', { waitUntil: 'load' });
      await p.waitForSelector('.activity, .fine');
      await shoot(p, `${name}-activity`);
    }
    await p.close();
  }
}

// ---------- flows ----------
const p = await page(1280, 900, false);
await p.goto(APP_URL + '#/lighting/lights', { waitUntil: 'load' });
await p.waitForSelector('.gcard');

// Stepper: two quick presses send one change after the debounce.
const before = await p.$eval('.gcard .big', (e) => e.textContent);
await p.click('.gcard [aria-label^="Brighten"]');
await p.click('.gcard [aria-label^="Brighten"]');
await sleep(2500);
const after = await p.$eval('.gcard .big', (e) => e.textContent);
const status = await p.$eval('.gcard .gstatus', (e) => e.textContent);
console.log('stepper', before, '->', after, '|', status);
if (!/Set here/.test(status)) errors.push(`stepper did not create a hold: ${status}`);

// Rapid presses: the number must move straight to each new value and never jump back.
await p.goto(APP_URL + '#/lighting/lights', { waitUntil: 'load' });
await p.waitForSelector('.gcard');
await sleep(1500);
const card = '.gcard:nth-of-type(2)'; // Kitchen
const readBig = () => p.$eval(`${card} .big`, (e) => e.textContent);
const startVal = await readBig();
for (let i = 0; i < 3; i++) { await p.click(`${card} [aria-label^="Dim"]`); await sleep(120); }
const afterPresses = await readBig();
const seen = [];
for (let i = 0; i < 40; i++) { seen.push(await readBig()); await sleep(150); }
const distinct = [...new Set(seen)];
console.log('rapid presses', startVal, '->', afterPresses, '| values seen over 6 s:', distinct.join(' '));
if (distinct.length !== 1 || distinct[0] !== afterPresses) errors.push(`number moved after presses: ${distinct.join(' ')}`);
const kstate = await (await fetch('http://localhost:8124/states')).json();
if (Math.round(kstate['light.kitchen_spots'].brightness / 2.55) !== parseInt(afterPresses, 10)) errors.push(`kitchen light ended at ${Math.round(kstate['light.kitchen_spots'].brightness / 2.55)} not ${afterPresses}`);
const kitchen = (await (await fetch('http://localhost:8099/api/lighting/state')).json()).groups.find((x) => x.id === 'kitchen');
if (kitchen.override?.type !== 'hold') errors.push(`kitchen became ${kitchen.override?.type}: ${kitchen.status.text}`);

// Editing a time on desktop while live updates stream in: the field must keep focus and the typed value.
await p.goto(APP_URL + '#/lighting/schedules/lounge', { waitUntil: 'load' });
await p.waitForSelector('.day');
await p.click('.day');
await p.waitForSelector('input[type="time"]');
const timeEl = await p.$('input[type="time"]');
await timeEl.click({ offset: { x: 14, y: 12 } });
await p.keyboard.type('0815');
// cause live updates
for (let i = 0; i < 3; i++) {
  await fetch('http://localhost:8124/human', { method: 'POST', body: JSON.stringify({ entity: 'light.office_desk', on: i % 2 === 0, brightness: 50 }) });
  await sleep(800);
}
const focusOk = await p.evaluate(() => document.activeElement?.type === 'time');
const val = await p.$eval('input[type="time"]', (e) => e.value);
console.log('time field focus kept:', focusOk, 'value:', val);
if (!focusOk || val !== '08:15') errors.push(`time field lost focus or value (${focusOk}, ${val})`);

// Also use for weekdays and copy to rooms
await clickText(p, '.sheet button.chip', 'Weekdays');
const saveLabel = await p.$eval('.sheet-foot .btn-primary', (e) => e.textContent);
console.log('save label:', saveLabel);
await p.click('.sheet-foot .btn-primary');
await sleep(800);
const sched = await (await fetch('http://localhost:8099/api/lighting/schedules')).json();
if (sched.schedules.lounge[0][0].time !== '08:15' || sched.schedules.lounge[4][0].time !== '08:15' || sched.schedules.lounge[5][0].time === '08:15') errors.push('weekday save went wrong');
await clickText(p, 'button', 'Copy this week');
await p.waitForSelector('.sheet');
await clickText(p, '.sheet .chip', 'Office');
await clickText(p, '.sheet-foot button', 'Copy to 1 group');
await sleep(800);
const sched2 = await (await fetch('http://localhost:8099/api/lighting/schedules')).json();
if (JSON.stringify(sched2.schedules.office) !== JSON.stringify(sched2.schedules.lounge)) errors.push('copy to office failed');

// Settings save themselves
await p.goto(APP_URL + '#/lighting/settings', { waitUntil: 'load' });
await p.waitForSelector('#step');
await p.select('#step', '10');
await sleep(2000);
const cfg = await (await fetch('http://localhost:8099/api/lighting/config')).json();
if (cfg.settings.stepSize !== 10) errors.push('settings did not save');
await p.select('#step', '5');
await sleep(1500);

// Keyboard focus is visible
await p.goto(APP_URL + '#/lighting/lights', { waitUntil: 'load' });
await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
const outline = await p.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
if (outline === 'none') errors.push('no visible focus ring');

// Scenes: the button runs it and says what happened; the editor opens from Settings.
await p.goto(APP_URL + '#/lighting/lights', { waitUntil: 'load' });
await p.waitForSelector('.scene-btn');
await clickText(p, '.scene-btn', 'Film night');
await sleep(1500);
const sceneMsg = await p.$eval('.scene-done', (e) => e.textContent);
console.log('scene button:', sceneMsg);
if (!/Film night: 3 groups set/.test(sceneMsg)) errors.push(`scene button said: ${sceneMsg}`);
await p.goto(APP_URL + '#/lighting/settings', { waitUntil: 'load' });
await p.waitForSelector('#set-scenes');
await p.evaluate(() => document.querySelector('#set-scenes').closest('section').querySelector('.group-li-actions button').click());
await p.waitForSelector('.scene-groups');
await shoot(p, 'desktop-light-scene-editor');
await p.keyboard.press('Escape');
const ph = await page(390, 844, false);
await ph.goto(APP_URL + '#/lighting/settings', { waitUntil: 'load' });
await ph.waitForSelector('#set-scenes');
await noHScroll(ph, 'phone settings with scenes');
await shoot(ph, 'phone-light-settings-scenes');
await ph.goto(APP_URL + '#/lighting/lights', { waitUntil: 'load' });
await ph.waitForSelector('.scene-btn');
await noHScroll(ph, 'phone lights with scenes');
await shoot(ph, 'phone-light-lights-scenes');

// The day editor keeps changes in time order: on open, after adding one, after editing a time, after switching to sunrise.
{
  const q = await page(1280, 900, false);
  await q.goto(APP_URL + '#/lighting/schedules/lounge', { waitUntil: 'load' });
  await q.waitForSelector('.day');
  await q.click('.day');
  await q.waitForSelector('.point');
  const order = () => q.$$eval('.point', (rows) => rows.map((r) => {
    const t = r.querySelector('input[type="time"]');
    if (t) return t.value;
    const sel = r.querySelectorAll('select');
    return `${sel[0].value}${sel[1].value}`;
  }));
  // sunset in October here is about 18:30, sunrise about 07:25
  const mins = (v) => (/^\d\d:\d\d$/.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3)) : v.startsWith('sunset') ? 18 * 60 + 28 + Number(v.slice(6)) : 7 * 60 + 25 + Number(v.slice(7)));
  const sorted = (list) => list.every((v, i) => i === 0 || mins(list[i - 1]) <= mins(v));
  let o = await order();
  console.log('editor on open:', o.join(' '));
  if (!sorted(o)) errors.push(`not in time order on open: ${o.join(' ')}`);
  await clickText(q, '.sheet button', 'Add a change');
  await sleep(500);
  o = await order();
  const focused = await q.evaluate(() => document.activeElement?.type === 'time' ? document.activeElement.value : null);
  console.log('after adding:', o.join(' '), '| new one focused at', focused);
  if (!sorted(o)) errors.push(`not in time order after adding: ${o.join(' ')}`);
  if (!focused || o.indexOf(focused) < 0) errors.push('the new change was not focused');
  await q.keyboard.type('0630A');
  o = await order();
  console.log('while typing (no jump yet):', o.join(' '));
  await q.evaluate(() => document.activeElement.blur());
  await sleep(300);
  o = await order();
  console.log('after leaving the field:', o.join(' '));
  if (o[0] !== '06:30' || !sorted(o)) errors.push(`edited time did not move into place: ${o.join(' ')}`);
  // switch the last change to "around sunrise": it should move up next to the morning
  await q.evaluate(() => {
    const rows = [...document.querySelectorAll('.point')];
    const sel = rows[rows.length - 1].querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'sunrise');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(400);
  o = await order();
  console.log('after switching to sunrise:', o.join(' '));
  if (!sorted(o) || !o.slice(0, 4).some((v) => v.startsWith('sunrise'))) errors.push(`sunrise change not in order: ${o.join(' ')}`);
  await shoot(q, 'desktop-light-day-sorted');
  await q.close();
}

await browser.close();
console.log(errors.length ? `PROBLEMS:\n${errors.join('\n')}` : 'browser checks passed');
