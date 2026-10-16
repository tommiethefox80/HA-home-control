// The house: what Home Control looks after, and one Away for everything it looks after.
//
// Modules: heating and lighting can each be turned off (Settings → Home Control), for houses that
// use something else for one of them. A module that's off sends nothing to its devices, ignores
// Home Assistant's events, writes no dashboard sensors, and its pages and settings are hidden. Its
// setup is kept, so turning it back on carries on where it left off. At least one stays on.
//
// One Away. The heating's Away (and its "away automatically" from people's phones) is the master:
// - heating goes to Away (by hand or automatically)  -> lights go to Away (lived-in pattern)
// - heating comes back to Schedules from Away        -> lights back to schedules
// - Away / Schedules picked on the Lighting page      -> heating follows, unless it's switched Off
// - heating switched Off (e.g. for summer), or turned off in Home Control's settings -> the same
//   people/delay/distance settings still switch the lights to Away and back.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const MODULES = ['heating', 'lighting', 'cameras', 'wifi'];
// new parts start off, so an update never starts doing something new by itself
const DEFAULT_ON = { heating: true, lighting: true, cameras: false, wifi: false };

class HouseError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function createHouse({ log, dataDir = null }) {
  let heating = null; let lighting = null; let cameras = null; let wifi = null;
  let lastHeatMode = null;
  const st = { emptySince: null, suppress: false, lightAway: false };
  const events = new EventEmitter();

  // ---------- what's switched on (house.json) ----------
  const file = dataDir ? path.join(dataDir, 'house.json') : null;
  let data = { modules: { ...DEFAULT_ON } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...data, ...raw, modules: { ...data.modules, ...(raw.modules || {}) } };
  } catch { /* first start: everything on */ }
  const save = () => {
    if (!file) return;
    try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1)); fs.renameSync(`${file}.tmp`, file); } catch (err) { log.warn?.(`Couldn't save house settings: ${err.message}`); }
  };
  const on = (m) => (data.modules[m] ?? DEFAULT_ON[m]) !== false;
  const modules = () => Object.fromEntries(MODULES.map((m) => [m, on(m)]));

  const hrt = () => heating.store.data.runtime;
  const presenceSettings = () => heating.store.data.settings.presence || {};

  function lightingTo(mode, reason) {
    if (!on('lighting')) return;
    const l = lighting.engine;
    if (lighting.store.data.paused || l.data.mode === mode) return;
    l.setMode(mode, { reason, auto: true });
  }

  function onHeatingChange() {
    if (!on('heating')) return;
    const mode = hrt().mode;
    if (mode === lastHeatMode) return;
    const prev = lastHeatMode; lastHeatMode = mode;
    if (prev == null) return; // first look at startup: nothing changed
    if (mode === 'away') {
      st.lightAway = true;
      lightingTo('away', hrt().presenceAway ? 'Everyone is out.' : 'Heating set to Away.');
    } else if (mode === 'auto' && prev === 'away') {
      st.lightAway = false;
      lightingTo('schedule', 'Heating back on schedules.');
    }
  }

  /** Away or Schedules picked on the Lighting page. */
  function setFromLighting(mode, reason = null) {
    const l = lighting.engine;
    if (mode === 'off') { l.setMode('off'); return; } // older scripts: "off" means All off, a one-press action
    if (!['schedule', 'away'].includes(mode)) { l.setMode(mode); return; } // lets lighting refuse it in plain words
    l.setMode(mode, { reason });
    st.lightAway = false;
    if (on('heating')) {
      const heatMode = hrt().mode;
      const want = mode === 'away' ? 'away' : 'auto';
      if (heatMode !== 'off' && heatMode !== want) {
        lastHeatMode = want; // we're making this change; don't echo it back
        heating.engine.setMode(want, null, { by: 'user' });
        l.addActivity(mode === 'away' ? 'The heating is on Away too.' : 'The heating is back on schedules too.');
      }
    }
    // picked by hand while everyone's out: don't switch straight back to Away
    if (mode === 'schedule' && everyoneOut()) st.suppress = true;
  }

  function people(all = false) {
    try { return heating.engine.presenceView(all); } catch { return []; }
  }
  /** Is the house on Away (by hand or because everyone's out)? Used by the cameras' schedules. */
  function isAway() {
    try {
      if (on('heating') && hrt().mode === 'away') return true;
      if (on('lighting') && lighting.engine.data.mode === 'away') return true;
    } catch { /* starting up */ }
    return everyoneOut();
  }

  function everyoneOut() {
    const p = presenceSettings();
    const list = people();
    return !!p.enabled && list.length > 0 && !list.some((x) => x.home);
  }

  /** Lights follow people even while the heating is switched off (e.g. all summer) or not looked after here. */
  function check() {
    if (!heating || !lighting || !on('lighting') || lighting.store.data.paused) return;
    const p = presenceSettings();
    if (!p.enabled) return;
    const list = people();
    if (!list.length) return;
    const heatingInCharge = on('heating') && hrt().mode !== 'off';
    const near = Number(p.nearMiles) || 2;
    const back = list.find((x) => x.home) || list.find((x) => x.miles != null && x.miles <= near);
    if (back) {
      st.emptySince = null;
      st.suppress = false;
      if (st.lightAway && lighting.engine.data.mode === 'away' && !(heatingInCharge && hrt().mode === 'away')) {
        st.lightAway = false;
        lightingTo('schedule', back.home ? `${back.name} is home.` : `${back.name} is on the way home.`);
      }
      return;
    }
    if (heatingInCharge) { st.emptySince = null; return; } // the heating's own presence check is in charge
    st.emptySince ??= Date.now();
    const waited = Date.now() - st.emptySince >= (Number.isFinite(Number(p.delayMinutes)) ? Number(p.delayMinutes) : 15) * 60000;
    if (waited && !st.suppress && lighting.engine.data.mode === 'schedule') {
      st.lightAway = true;
      lightingTo('away', 'Everyone is out.');
    }
  }

  // ---------- turning modules on and off ----------
  function apply(m, value, { quiet = false } = {}) {
    if (m === 'heating') {
      const e = heating.engine;
      if (e.disabled === !value) return;
      e.disabled = !value;
      if (!value) {
        if (!quiet) {
          e.note('Heating turned off in Home Control\'s settings. Radiators and the boiler are handed back to their own schedules.');
          e.handBack().catch(() => {});
        }
      } else {
        if (!quiet) e.note('Heating turned back on in Home Control\'s settings.');
        lastHeatMode = hrt().mode;
        e.resume();
      }
      e.emit('change');
    } else if (m === 'lighting') {
      const e = lighting.engine;
      if (e.disabled === !value) return;
      e.disabled = !value;
      if (!value) {
        if (!quiet) e.addActivity('Lighting turned off in Home Control\'s settings. Lights and sockets are left as they are.');
      } else if (!quiet) {
        // change nothing now: each group follows its schedule from its next change, as when lighting first started here
        for (const g of lighting.store.data.groups) e.leaveAsIsUntilNext(g, 'start');
        e.addActivity('Lighting turned back on in Home Control\'s settings. Each group carries on as it is until its next scheduled change.');
        lighting.store.save();
      }
      e.tick();
    } else if (m === 'cameras' && cameras) {
      const e = cameras.engine;
      if (e.disabled === !value) return;
      e.disabled = !value;
      if (!quiet) e.addEvent(null, 'note', value ? 'Cameras turned on in Home Control\'s settings.' : 'Cameras turned off in Home Control\'s settings. No more alerts or recordings; the cameras themselves carry on as they are.');
      e.changed();
    } else if (m === 'wifi' && wifi) {
      const e = wifi.engine;
      if (e.disabled === !value) return;
      e.disabled = !value;
      if (!quiet) e.addEvent(value ? 'Wi-Fi turned on in Home Control\'s settings.' : 'Wi-Fi turned off in Home Control\'s settings. No more scheduled changes; the network carries on as it is.');
      if (value) e.tick();
      e.changed();
    }
  }

  function setModules(input) {
    const next = modules();
    for (const m of MODULES) if (typeof input?.[m] === 'boolean') next[m] = input[m];
    if (!MODULES.some((m) => next[m])) throw new HouseError('Home Control has to look after something: keep at least one of these on.');
    const changed = MODULES.filter((m) => next[m] !== on(m));
    data = { ...data, modules: next };
    save();
    for (const m of changed) {
      apply(m, next[m]);
      log.info?.(`${m[0].toUpperCase()}${m.slice(1)} turned ${next[m] ? 'on' : 'off'}`);
    }
    if (changed.length) events.emit('modules', changed);
  }

  // ---------- the shared settings: modules, the Dashboard button, Away automatically ----------
  function settingsView() {
    const s = heating.store.data.settings;
    return {
      modules: modules(),
      dashboardPath: s.dashboardPath || '/',
      presence: s.presence || { enabled: false, people: [], delayMinutes: 15, nearMiles: 2 },
      people: people(true),
    };
  }

  function updateSettings(body) {
    if (body.modules) setModules(body.modules);
    const h = {};
    if (typeof body.dashboardPath === 'string') h.dashboardPath = body.dashboardPath;
    if (body.presence && typeof body.presence === 'object') h.presence = body.presence;
    if (Object.keys(h).length) heating.engine.updateSettings(h); // kept with the heating's settings, as before
    lighting.engine.changed();
    return settingsView();
  }

  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new HouseError('Bad request')); } });
    req.on('error', reject);
  });

  async function handle(req, res, p) {
    if (p !== '/api/house') return false;
    try {
      if (req.method === 'GET') return send(res, 200, settingsView()), true;
      if (req.method === 'PUT') return send(res, 200, updateSettings(await readBody(req))), true;
      return send(res, 405, { error: 'Not allowed' }), true;
    } catch (err) {
      return send(res, err.status || 400, { error: err.message }), true;
    }
  }

  function view() {
    if (!heating) return null;
    const p = presenceSettings();
    const list = p.enabled ? people() : [];
    let heatingOn = false;
    try { heatingOn = on('heating') && !!heating.engine.boilerView().on; } catch { /* no boiler chosen yet */ }
    return {
      modules: modules(),
      away: isAway(),
      heatingMode: hrt().mode,
      heatingOn,
      dashboardPath: heating.store.data.settings.dashboardPath || '/',
      panel: api.panel?.() || null, // where this app is in Home Assistant, for dashboard buttons
      presence: { enabled: !!p.enabled, delay: Number.isFinite(Number(p.delayMinutes)) ? Number(p.delayMinutes) : 15, home: list.filter((x) => x.home).map((x) => x.name), allOut: everyoneOut() },
    };
  }

  function attach(h, l, c = null, w = null) {
    heating = h; lighting = l; cameras = c; wifi = w;
    l.engine.modeRequest = (mode, reason) => setFromLighting(mode, reason); // lighting_control_mode events from Home Assistant
    lastHeatMode = hrt().mode;
    heating.engine.on('change', () => { onHeatingChange(); lighting.engine.changed(); });
    for (const m of MODULES) if (!on(m)) apply(m, false, { quiet: true }); // turned off before this start
    setInterval(check, 30000);
  }

  const api = { attach, setFromLighting, view, check, handle, on, isAway, events, state: st, panel: null };
  return api;
}
