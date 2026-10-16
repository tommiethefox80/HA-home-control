// Renders the dashboard card the way Home Assistant would (ha-card stub, theme variables, a hass
// object with the sensors the app just published to the mock), light and dark, and saves screenshots.
// Run with the app and mock running: node dev/card-preview.js
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { readFileSync, mkdirSync } from 'node:fs';
const OUT = new URL('./screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const card = readFileSync(new URL('../dashboard/home-control-card.js', import.meta.url), 'utf8');
const published = await (await fetch('http://localhost:8124/published')).json();
const THEMES = {
  light: { '--primary-background-color': '#eef1f2', '--card-background-color': '#ffffff', '--primary-text-color': '#1c252c', '--secondary-text-color': '#56646f', '--divider-color': '#dbe1e4', '--primary-color': '#2f6fb0', '--ha-card-border-radius': '16px', '--ha-card-box-shadow': '0 1px 2px rgba(28,37,44,.06), 0 4px 16px rgba(28,37,44,.05)' },
  dark: { '--primary-background-color': '#141a1f', '--card-background-color': '#1d252c', '--primary-text-color': '#e8edf0', '--secondary-text-color': '#a3b0b9', '--divider-color': '#2d3740', '--primary-color': '#5b95d6', '--ha-card-border-radius': '16px', '--ha-card-box-shadow': '0 1px 2px rgba(0,0,0,.3)' },
};
const errors = [];
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
for (const [name, vars] of Object.entries(THEMES)) {
  for (const width of [880, 390]) {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewport({ width, height: 700 });
    const style = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
    await p.setRequestInterception(true);
    let html = '';
    p.on('request', (req) => {
      const u = req.url();
      const cam = /\/api\/camera_proxy\/camera\.([a-z]+)/.exec(u);
      if (cam) return req.respond({ status: 200, contentType: 'image/jpeg', body: readFileSync(new URL(`./cameras/${{ garden: 'garden', front: 'front_door', driveway: 'driveway', shed: 'shed' }[cam[1]] || 'garden'}.jpg`, import.meta.url)) });
      return u.startsWith('http://ha.test/') ? req.respond({ status: 200, contentType: 'text/html', body: html }) : req.continue();
    });
    html = (`<!doctype html><html><head><style>
      html{${style}} body{margin:0;padding:16px;background:var(--primary-background-color);font-family:Roboto,'Segoe UI',system-ui,sans-serif;font-size:14px}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;align-items:start}
      ha-card{display:block;background:var(--card-background-color);border-radius:var(--ha-card-border-radius);box-shadow:var(--ha-card-box-shadow);border:1px solid var(--divider-color)}
    </style></head><body><div class="grid"><home-control-card id="h"></home-control-card><home-control-card id="l"></home-control-card><home-control-card id="m"></home-control-card><home-control-card id="c"></home-control-card></div></body></html>`);
    await p.goto('http://ha.test/lovelace/home', { waitUntil: 'load' });
    // ha-card styles itself in its own shadow DOM in Home Assistant; do the same here
    await p.addScriptTag({ content: `customElements.define('ha-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<style>:host{display:block;background:var(--ha-card-background,var(--card-background-color));border-radius:var(--ha-card-border-radius,12px);box-shadow:var(--ha-card-box-shadow,none);border:var(--ha-card-border-width,1px) solid var(--ha-card-border-color,var(--divider-color));color:var(--primary-text-color)}</style><slot></slot>'; } });` });
    await p.addScriptTag({ content: card });
    await p.evaluate((states) => {
      const hass = { states };
      const set = (id, cfg) => { const el = document.getElementById(id); el.setConfig(cfg); el.hass = hass; };
      set('h', { show: 'heating' });
      set('l', { show: 'lighting' });
      set('m', { show: 'lighting', entity: 'sensor.not_there' });
      // cameras: their entities, as Home Assistant has them, for the pictures and controls
      const cams = states['sensor.home_cameras']?.attributes?.cameras || [];
      const extra = {};
      for (const c of cams) {
        extra[c.entity] = { state: c.online ? 'idle' : 'unavailable', attributes: { entity_picture: `/api/camera_proxy/${c.entity}?token=t0k3n` } };
        for (const x of c.controls) extra[x.id] = { state: x.domain === 'select' ? (x.options || [])[0] : 'off', attributes: { options: x.options } };
      }
      const el = document.getElementById('c');
      el.setConfig({ show: 'cameras' });
      el.hass = { states: { ...states, ...extra }, callService: async () => {} };
    }, published.states);
    await new Promise((r) => setTimeout(r, 400));
    await p.screenshot({ path: `${OUT}card-${name}-${width}.png`, fullPage: true });
    // tapping opens the app
    await p.evaluate(() => { window.__nav = []; window.addEventListener('location-changed', () => window.__nav.push(location.pathname + location.search)); });
    await p.evaluate(() => document.getElementById('l').shadowRoot.querySelector('.head.open').click());
    const nav = await p.evaluate(() => window.__nav);
    if (nav[0] !== '/local_heating_control?section=lighting') errors.push(`lighting tap went to ${nav[0]}`);
    // from 1.3 the app says where it is
    await p.evaluate((states) => {
      const s = { ...states, 'sensor.home_lighting': { ...states['sensor.home_lighting'], attributes: { ...states['sensor.home_lighting'].attributes, panel: '/bea84e52_home_control' } } };
      document.getElementById('l').hass = { states: s };
    }, published.states);
    await p.evaluate(() => document.getElementById('l').shadowRoot.querySelector('.head.open').click());
    const nav2 = await p.evaluate(() => window.__nav);
    if (nav2[1] !== '/bea84e52_home_control?section=lighting') errors.push(`lighting tap with the app's address went to ${nav2[1]}`);
    await p.close();
  }
}
await browser.close();
console.log(errors.length ? `PROBLEMS:\n${errors.join('\n')}` : 'card preview done');
