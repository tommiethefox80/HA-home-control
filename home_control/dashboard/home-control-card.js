// Home Control card for Home Assistant dashboards.
// Shows the heating or the lighting at a glance, in the same colours as the Home app:
// rooms coloured by what they're aiming for, light groups in the colour of their light.
// Tap the heating card to open the app. On the lighting card each group has a power button
// (on at the level its schedule uses at this time of day) and, where it dims, minus and plus;
// tap a group's name or the title to open the app.
//
//   type: custom:home-control-card
//   show: heating            # or: lighting
//   panel: /local_heating_control   # optional: where the Home app is (the app says, from 1.3)
//
// Reads sensor.home_heating and sensor.home_lighting, which Home Control 1.1+ writes.
// Home Control 1.3+ copies this card into Home Assistant and keeps its dashboard resource current.
const VERSION = '1.3.0';
const PENDING_MS = 10000; // how long to show a change as done before Home Assistant confirms it
const STEP_WAIT = 500;    // wait this long after the last minus or plus press before sending

// ---------- colours (the same scales as the app) ----------
const HEAT = [[7, [74, 111, 150]], [13, [111, 152, 166]], [16.5, [139, 178, 160]], [19, [230, 182, 72]], [21, [238, 132, 52]], [24, [196, 66, 45]]];
function thermal(t) {
  if (t == null || Number.isNaN(Number(t))) return null;
  if (t <= HEAT[0][0]) return HEAT[0][1];
  for (let i = 1; i < HEAT.length; i++) {
    const [t1, c1] = HEAT[i]; const [t0, c0] = HEAT[i - 1];
    if (t <= t1) { const f = (t - t0) / (t1 - t0); return c0.map((v, k) => Math.round(v + (c1[k] - v) * f)); }
  }
  return HEAT[HEAT.length - 1][1];
}
const LIGHT = [[2000, [255, 147, 44]], [2700, [255, 182, 98]], [3500, [255, 214, 162]], [4500, [255, 236, 214]], [6500, [224, 235, 255]]];
const DIM = [92, 52, 18];
function kelvinRgb(k) {
  const kk = Math.max(2000, Math.min(6500, k || 2700));
  for (let i = 1; i < LIGHT.length; i++) {
    if (kk <= LIGHT[i][0]) {
      const [k0, c0] = LIGHT[i - 1]; const [k1, c1] = LIGHT[i];
      const t = (kk - k0) / (k1 - k0);
      return c0.map((v, j) => v + (c1[j] - v) * t);
    }
  }
  return LIGHT[LIGHT.length - 1][1];
}
function lightRgb(on, brightness, kelvin) {
  if (!on) return null;
  const b = Math.max(1, Math.min(100, brightness ?? 100)) / 100;
  const base = kelvinRgb(kelvin);
  const t = 0.32 + 0.68 * Math.pow(b, 0.75);
  return base.map((v, j) => Math.round(DIM[j] + (v - DIM[j]) * t));
}
/** Ink that reads on top of a light colour. */
function inkOn(rgb) {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#1c252c' : '#fff6ea';
}
const css = (c, a = 1) => (c ? (a === 1 ? `rgb(${c.join(' ')})` : `rgb(${c.join(' ')} / ${a})`) : null);
const deg = (t) => (t == null ? '–' : `${Number(t).toFixed(1).replace(/\.0$/, '')}°`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const P = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  flame: `<svg viewBox="0 0 24 24" ${P}><path d="M12 3c1 3.5 5 5.6 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.2-4.8.3 1.6 1.1 2.6 2.1 3C11 8.7 11.4 5.6 12 3Z" fill="currentColor" fill-opacity=".25"/></svg>`,
  bulb: `<svg viewBox="0 0 24 24" ${P}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/></svg>`,
  chev: `<svg viewBox="0 0 24 24" ${P}><path d="M9 6l6 6-6 6"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" ${P}><path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>`,
  power: `<svg viewBox="0 0 24 24" ${P} stroke-width="2"><path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" ${P} stroke-width="2"><path d="M5 12h14"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" ${P} stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`,
};

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; box-sizing: border-box; }
  .card { padding: 14px 16px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 12px; outline: none; }
  .card > *, .rooms > * { flex-shrink: 0; }
  .card:focus-visible { box-shadow: inset 0 0 0 2px var(--primary-color); border-radius: inherit; }
  .head { display: flex; align-items: center; gap: 12px; }
  .badge { flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
    background: var(--hc-badge-bg, rgb(127 127 127 / .12)); color: var(--hc-badge-ink, var(--secondary-text-color)); }
  .badge svg { width: 22px; height: 22px; }
  .titles { flex: 1; min-width: 0; }
  .title { font-size: 1.05rem; font-weight: 650; letter-spacing: -0.005em; color: var(--primary-text-color); line-height: 1.25; }
  .sub { font-size: .85rem; color: var(--secondary-text-color); line-height: 1.3; margin-top: 1px; }
  .pill { flex: none; font-size: .78rem; font-weight: 600; padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--divider-color); color: var(--secondary-text-color); white-space: nowrap; }
  .pill.strong { background: var(--primary-text-color); color: var(--card-background-color, #fff); border-color: transparent; }
  .chev { width: 18px; height: 18px; color: var(--secondary-text-color); flex: none; margin-left: -4px; }
  .num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; letter-spacing: -0.02em; }

  /* heating */
  .rooms { display: flex; flex-direction: column; gap: 2px; }
  .room { display: grid; grid-template-columns: 4px minmax(0, 1fr) auto; gap: 0 12px; align-items: center; padding: 8px 0; }
  .room + .room { border-top: 1px solid var(--divider-color); }
  .bar { width: 4px; align-self: stretch; border-radius: 4px; background: var(--divider-color); }
  .rname { font-weight: 600; color: var(--primary-text-color); font-size: .95rem; display: flex; align-items: center; gap: 6px; }
  .rname svg { width: 15px; height: 15px; color: rgb(238 132 52); }
  .rstatus { font-size: .8rem; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .temps { text-align: right; display: flex; align-items: baseline; gap: 8px; }
  .now { font-size: 1.45rem; font-weight: 650; color: var(--primary-text-color); line-height: 1; }
  .target { font-size: .8rem; font-weight: 650; padding: 3px 8px; border-radius: 8px; color: var(--primary-text-color); }
  .note { font-size: .82rem; display: flex; gap: 6px; align-items: flex-start; color: var(--primary-text-color);
    background: rgb(238 132 52 / .12); border-radius: 10px; padding: 7px 10px; }
  .note svg { width: 15px; height: 15px; flex: none; margin-top: 1px; color: rgb(196 66 45); }

  /* lighting */
  .lighting { cursor: default; }
  .head.open { cursor: pointer; border-radius: 12px; outline: none; }
  .head.open:focus-visible { box-shadow: 0 0 0 2px var(--primary-color); }
  .groups { display: flex; flex-direction: column; gap: 6px; }
  .grow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px;
    padding: 6px 6px 6px 12px; border-radius: 14px; background: var(--hc-tile-bg, rgb(127 127 127 / .08));
    user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; }
  .grow.dead { opacity: .55; }
  .gtext { min-width: 0; border: 0; background: none; padding: 4px 0; margin: 0; font: inherit; color: inherit;
    text-align: left; cursor: pointer; border-radius: 8px; }
  .gtext:focus-visible, .hcbtn:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .gname { display: block; font-weight: 600; font-size: .92rem; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gsub { display: block; font-size: .78rem; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .hcbtn { border: 0; margin: 0; padding: 0; font: inherit; cursor: pointer; display: grid; place-items: center;
    touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: transform .08s ease-out; }
  .hcbtn:active:not(:disabled) { transform: scale(.93); }
  .hcbtn:disabled { cursor: default; opacity: .35; }
  .hcbtn svg { width: 18px; height: 18px; }
  .step { display: flex; align-items: center; gap: 2px; }
  .step .hcbtn { width: 34px; height: 34px; border-radius: 10px; color: var(--primary-text-color);
    background: var(--card-background-color, #fff); box-shadow: inset 0 0 0 1px var(--divider-color); }
  .val { min-width: 46px; text-align: center; font-weight: 650; font-size: .95rem; color: var(--primary-text-color); }
  .val.quiet { color: var(--secondary-text-color); font-weight: 600; }
  .power { width: 42px; height: 42px; border-radius: 50%; color: var(--secondary-text-color);
    background: var(--card-background-color, #fff); box-shadow: inset 0 0 0 1px var(--divider-color); }
  .power svg { width: 20px; height: 20px; }
  .power.on { background: var(--light); color: var(--ink); box-shadow: inset 0 0 0 1px rgb(0 0 0 / .08), 0 0 0 3px var(--glow), 0 0 14px var(--glow); }
  .grow.busy .power { animation: hc-pulse 1s ease-in-out infinite; }
  @keyframes hc-pulse { 50% { opacity: .6; } }
  @media (prefers-reduced-motion: reduce) { .grow.busy .power { animation: none; } .hcbtn { transition: none; } }
  .empty { font-size: .88rem; color: var(--secondary-text-color); }
`;

class HomeControlCard extends HTMLElement {
  static getStubConfig() { return { show: 'heating' }; }

  setConfig(config) {
    this._pending ??= new Map();
    this._timers ??= {};
    const show = config?.show || 'heating';
    if (!['heating', 'lighting'].includes(show)) throw new Error('show must be heating or lighting');
    this._config = { ...config, show };
    this._entity = config.entity || (show === 'heating' ? 'sensor.home_heating' : 'sensor.home_lighting');
    this._last = undefined;
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const st = hass.states[this._entity];
    if (st === this._last && this.shadowRoot?.childElementCount) return;
    this._last = st;
    this._render();
  }

  getCardSize() {
    const a = this._last?.attributes;
    if (!a) return 2;
    return this._config.show === 'heating' ? 2 + Math.ceil((a.rooms?.length || 0) * 0.8) : 2 + Math.ceil((a.groups?.length || 0) / 3);
  }

  // no rows: Home Assistant sizes the card to fit everything in it
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  _open(e) {
    e?.stopPropagation?.();
    // the app says where it is; older versions were always at /local_heating_control
    const panel = this._config.panel || this._last?.attributes?.panel || '/local_heating_control';
    const path = this._config.show === 'lighting' ? `${panel}?section=lighting` : panel;
    window.history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    if (this._pressing) { this._dirty = true; return; } // don't swap the tile out from under a finger
    const st = this._last;
    const body = !st
      ? `<div class="card"><div class="head">${this._badge('quiet')}<div class="titles"><div class="title">${this._config.show === 'heating' ? 'Heating' : 'Lighting'}</div>
           <div class="sub">Waiting for Home Control. Update it to 1.1 or later and make sure it's running (${esc(this._entity)} not found).</div></div></div></div>`
      : this._config.show === 'heating' ? this._heating(st) : this._lighting(st);
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card>${body}</ha-card>`;
    const root = this.shadowRoot;
    // the heating card opens the app; on the lighting card only the title does, and the groups switch
    const opener = this._config.show === 'lighting' ? root.querySelector('.head.open') : root.querySelector('.card');
    if (st && opener) {
      opener.addEventListener('click', (e) => this._open(e));
      opener.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._open(e); } });
    }
    this._wire(root);
  }

  // ---------- switching and dimming lighting groups from the dashboard ----------

  _wire(root) {
    const pressing = () => { this._pressing = true; };
    const released = () => {
      this._pressing = false;
      if (this._dirty) { this._dirty = false; setTimeout(() => this._render(), 0); }
    };
    for (const row of root.querySelectorAll('.grow[data-id]')) {
      const id = row.dataset.id;
      row.querySelector('.gtext')?.addEventListener('click', (e) => this._open(e));
      for (const btn of row.querySelectorAll('.hcbtn')) {
        btn.addEventListener('pointerdown', pressing);
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, released);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === 'power') this._toggle(id);
          else this._step(id, act === 'up' ? 1 : -1);
        });
      }
    }
  }

  /** What a group shows: what it reports, or what was just asked for while that lands. */
  _shown(g) {
    const p = this._pending.get(g.id);
    const real = { on: !!g.on, brightness: g.brightness ?? (g.on ? 100 : null), kelvin: g.kelvin, busy: false };
    if (!p) return real;
    const landed = p.sent && p.on === real.on && (!p.on || p.brightness == null || !g.brightness || Math.abs(g.brightness - p.brightness) <= 3);
    if (landed || Date.now() - p.at > PENDING_MS) { this._pending.delete(g.id); return real; }
    return { on: p.on, brightness: p.on ? p.brightness ?? real.brightness : null, kelvin: p.on ? p.kelvin ?? real.kelvin : null, busy: true };
  }

  _group(id) { return (this._last?.attributes?.groups || []).find((x) => x.id === id); }

  _toggle(id) {
    const g = this._group(id);
    if (!g) return;
    if (!Array.isArray(g.devices)) { this._open(); return; } // an older Home Control: switch it in the app
    const d = this._shown(g);
    const lvl = g.turn_on || {};
    this._want(g, d.on ? { on: false } : { on: true, brightness: lvl.brightness ?? null, kelvin: lvl.kelvin ?? null }, 0);
  }

  _step(id, dir) {
    const g = this._group(id);
    if (!g || !Array.isArray(g.devices)) return;
    const d = this._shown(g);
    const step = Number(this._last?.attributes?.step) || 10;
    const cur = d.on ? (d.brightness ?? 100) : 0;
    let next = Math.round((cur + dir * step) / step) * step;
    if (dir > 0 && cur === 0) next = step;
    next = Math.min(100, next);
    // several quick presses become one change, like the app
    if (next <= 0) this._want(g, { on: false }, STEP_WAIT);
    else this._want(g, { on: true, brightness: next, kelvin: d.on ? null : (g.turn_on || {}).kelvin ?? null }, STEP_WAIT);
  }

  /** Show it straight away; send it to Home Assistant once the presses stop. */
  _want(g, want, delay) {
    this._pending.set(g.id, { ...want, at: Date.now(), sent: false });
    this._error = null;
    this.dispatchEvent(new CustomEvent('haptic', { bubbles: true, composed: true, detail: 'light' }));
    clearTimeout(this._timers[g.id]);
    this._timers[g.id] = setTimeout(() => this._apply(g.id), delay);
    clearTimeout(this._expiry);
    this._expiry = setTimeout(() => this._render(), PENDING_MS + delay + 50); // put it back if nothing happened
    this._render();
  }

  async _apply(id) {
    const g = this._group(id);
    const p = this._pending.get(id);
    if (!g || !p) return;
    p.sent = true; p.at = Date.now();
    const devs = g.devices.filter((d) => d.available !== false);
    const lights = devs.filter((d) => d.id.startsWith('light.'));
    const others = devs.filter((d) => !d.id.startsWith('light.')).map((d) => d.id);
    const ids = (pick) => lights.filter(pick).map((d) => d.id);
    const bri = p.brightness != null ? { brightness_pct: p.brightness } : {};
    const calls = [];
    if (!p.on) {
      // straight off, no fade: some Zigbee bulbs misbehave when asked to fade off
      if (lights.length) calls.push(['light', 'turn_off', { entity_id: lights.map((d) => d.id) }]);
      if (others.length) calls.push(['homeassistant', 'turn_off', { entity_id: others }]);
    } else if (g.on) {
      // already on: just the brightness of the lights that dim
      const dim = ids((d) => d.dimmable || d.ct);
      if (dim.length && p.brightness != null) calls.push(['light', 'turn_on', { entity_id: dim, ...bri }]);
    } else {
      // coming on: the level asked for, in the warmth its schedule uses now
      const ct = ids((d) => d.ct); const dim = ids((d) => d.dimmable && !d.ct); const plain = ids((d) => !d.dimmable && !d.ct);
      if (ct.length) calls.push(['light', 'turn_on', { entity_id: ct, ...bri, ...(p.kelvin ? { color_temp_kelvin: p.kelvin } : {}) }]);
      if (dim.length) calls.push(['light', 'turn_on', { entity_id: dim, ...bri }]);
      if (plain.length) calls.push(['light', 'turn_on', { entity_id: plain }]);
      if (others.length) calls.push(['homeassistant', 'turn_on', { entity_id: others }]);
    }
    try {
      await Promise.all(calls.map(([domain, service, data]) => this._hass.callService(domain, service, data)));
    } catch (err) {
      this._pending.delete(id);
      this._error = `Couldn't change ${g.name}: ${err?.message || err}`;
      setTimeout(() => { this._error = null; this._render(); }, 6000);
      this._render();
    }
  }

  _badge(kind, icon = this._config.show === 'heating' ? ICON.flame : ICON.bulb) {
    const styles = {
      fire: '--hc-badge-bg: rgb(238 132 52 / .16); --hc-badge-ink: rgb(238 132 52);',
      lit: '--hc-badge-bg: rgb(255 182 98 / .22); --hc-badge-ink: rgb(214 128 38);',
      quiet: '',
    };
    return `<div class="badge" style="${styles[kind] || ''}">${icon}</div>`;
  }

  _heating(st) {
    const a = st.attributes || {};
    const rooms = (a.rooms || []).filter((r) => r.enabled !== false);
    const title = this._config.title || 'Heating';
    const modeText = a.mode_text || st.state;
    const pillStrong = a.mode === 'away' || a.mode === 'off';
    const rows = rooms.map((r) => {
      const c = thermal(r.target);
      return `<div class="room">
        <span class="bar" style="${c ? `background:${css(c)}` : ''}"></span>
        <div style="min-width:0">
          <div class="rname">${esc(r.name)}${r.calling ? ICON.flame : ''}</div>
          <div class="rstatus" title="${esc(r.status)}">${esc(r.status)}</div>
        </div>
        <div class="temps">
          <span class="now num">${deg(r.temp)}</span>
          <span class="target num" style="${c ? `background:${css(c, 0.22)}` : ''}" title="Aiming for ${deg(r.target)}">${deg(r.target)}</span>
        </div>
      </div>`;
    }).join('');
    const notes = [a.boost?.text, ...(a.attention || [])].filter(Boolean)
      .map((t) => `<div class="note">${ICON.alert}<span>${esc(t)}</span></div>`).join('');
    return `<div class="card" role="button" tabindex="0" aria-label="${esc(title)}: ${esc(modeText)}. ${esc(a.boiler)}${a.boiler_today ? `, ${esc(a.boiler_today)} today` : ''}. Open Home.">
      <div class="head">${this._badge(a.boiler_on ? 'fire' : 'quiet')}
        <div class="titles"><div class="title">${esc(title)}</div><div class="sub">${esc(a.boiler || '')}${a.boiler_today ? ` · <span class="num">${esc(a.boiler_today)}</span> today${a.boiler_fires_today ? `, ${a.boiler_fires_today === 1 ? '1 run' : `${a.boiler_fires_today} runs`}` : ''}` : ''}</div></div>
        <span class="pill${pillStrong ? ' strong' : ''}">${esc(modeText)}</span>${ICON.chev.replace('<svg', '<svg class="chev"')}
      </div>
      ${notes}
      ${rows ? `<div class="rooms">${rows}</div>` : '<div class="empty">No rooms yet. Add them in Home → Heating → Settings.</div>'}
    </div>`;
  }

  _lighting(st) {
    const a = st.attributes || {};
    const groups = a.groups || [];
    const title = this._config.title || 'Lighting';
    const anyOn = groups.some((g) => g.on);
    const modeText = a.paused ? 'Paused' : a.mode_text || 'Schedules';
    const step = Number(a.step) || 10;
    const rows = groups.map((g) => {
      const d = this._shown(g);
      const dead = g.available === false;
      const canSwitch = Array.isArray(g.devices) && !dead;
      const dims = canSwitch && g.devices.some((x) => x.available !== false && (x.dimmable || x.ct));
      const c = lightRgb(d.on, d.brightness, d.kelvin);
      const level = dead ? 'Unavailable' : !d.on ? 'Off' : dims || g.brightness != null ? `${d.brightness ?? 100}%` : 'On';
      const tint = c ? `background: linear-gradient(0deg, ${css(c, 0.14)}, ${css(c, 0.14)}), var(--hc-tile-bg, rgb(127 127 127 / .08));` : '';
      const vars = c ? `--light:${css(c)};--ink:${inkOn(c)};--glow:${css(c, 0.35)};` : '';
      const sub = dead ? 'Can\'t reach it right now' : d.busy ? (!d.on ? 'Switching off…' : g.on ? `Setting to ${level}…` : 'Switching on…') : g.status || '';
      const stepper = dims
        ? `<div class="step">
            <button type="button" class="hcbtn" data-act="down" ${!d.on ? 'disabled' : ''} aria-label="Dim ${esc(g.name)} by ${step}%">${ICON.minus}</button>
            <span class="val num" aria-live="polite">${esc(level)}</span>
            <button type="button" class="hcbtn" data-act="up" ${d.on && (d.brightness ?? 100) >= 100 ? 'disabled' : ''} aria-label="Brighten ${esc(g.name)} by ${step}%">${ICON.plus}</button>
          </div>`
        : `<span class="val quiet num">${esc(level)}</span>`;
      return `<div class="grow${d.on ? ' on' : ''}${d.busy ? ' busy' : ''}${dead ? ' dead' : ''}" data-id="${esc(g.id)}" style="${tint}${vars}">
        <button type="button" class="gtext" aria-label="${esc(g.name)}, ${esc(level)}. Open in Home." title="${esc(g.status)}">
          <span class="gname">${esc(g.name)}</span><span class="gsub">${esc(sub)}</span>
        </button>
        ${stepper}
        <button type="button" class="hcbtn power${d.on ? ' on' : ''}" data-act="power" ${canSwitch ? '' : 'disabled'}
          aria-pressed="${d.on}" aria-label="${d.on ? 'Switch off' : 'Switch on'} ${esc(g.name)}">${ICON.power}</button>
      </div>`;
    }).join('');
    const err = this._error ? `<div class="note">${ICON.alert}<span>${esc(this._error)}</span></div>` : '';
    return `<div class="card lighting">
      <div class="head open" role="button" tabindex="0" aria-label="${esc(title)}: ${esc(a.summary)}. Open lighting in Home.">${this._badge(anyOn ? 'lit' : 'quiet')}
        <div class="titles"><div class="title">${esc(title)}</div><div class="sub">${esc(a.summary || '')}</div></div>
        <span class="pill${a.mode === 'away' || a.paused ? ' strong' : ''}">${esc(modeText)}</span>${ICON.chev.replace('<svg', '<svg class="chev"')}
      </div>
      ${err}
      ${rows ? `<div class="groups">${rows}</div>` : '<div class="empty">No groups yet. Add them in Home → Lighting → Settings.</div>'}
    </div>`;
  }
}

if (!customElements.get('home-control-card')) {
  customElements.define('home-control-card', HomeControlCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'home-control-card', name: 'Home Control', description: 'Heating or lighting at a glance, from the Home Control app', preview: false });
  console.info(`%c HOME-CONTROL-CARD %c ${VERSION} `, 'background:#ee8434;color:#fff;border-radius:3px 0 0 3px;padding:1px 4px', 'background:#1c252c;color:#fff;border-radius:0 3px 3px 0;padding:1px 4px');
}
