// A small fake Home Assistant that speaks the real WebSocket API, for testing without a house.
//   node dev/mock-ha.js            -> ws://localhost:8123/api/websocket, control on http://localhost:8124
// Control port (simulate a person):
//   POST /human   {"entity":"light.lounge_lamp","on":false,"brightness":40,"user":"u1"}  (no user = wall switch)
//   POST /sensor  {"entity":"binary_sensor.hallway_motion","state":"on"}
//   GET  /calls   service calls received
//   POST /reset-calls
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sunTimes, localDate } from '../server/src/lighting/schedule.js';

const PORT = Number(process.env.MOCK_PORT || 8123);
const CTRL = Number(process.env.MOCK_CTRL || 8124);
const TZ = 'Europe/London';
const LAT = 53.26; const LON = -2.52;

const areas = [
  ['lounge', 'Lounge'], ['kitchen', 'Kitchen'], ['hallway', 'Hallway'], ['bedroom', 'Bedroom'],
  ['office', 'Office'], ['garden', 'Garden'],
].map(([area_id, name]) => ({ area_id, name }));

const devices = [];
const entities = [];
const states = new Map();
const nowIso = () => new Date().toISOString();

function add(entity_id, attrs, { area, state = 'off', category = null, deviceClass = null, slow = false, quirk = null } = {}) {
  const device_id = `dev_${entity_id.replace('.', '_')}`;
  devices.push({ id: device_id, area_id: area, name: attrs.friendly_name });
  entities.push({ entity_id, device_id, area_id: null, entity_category: category, disabled_by: null, hidden_by: null, original_device_class: deviceClass, name: null, platform: entity_id.startsWith('light.') ? 'zha' : 'demo' });
  states.set(entity_id, { entity_id, state, attributes: attrs, last_changed: nowIso(), last_updated: nowIso(), context: { id: randomUUID(), parent_id: null, user_id: null }, _slow: slow, _quirk: quirk });
}

const ct = (name, min = 2200, max = 6500) => ({ friendly_name: name, supported_color_modes: ['color_temp'], color_mode: null, min_color_temp_kelvin: min, max_color_temp_kelvin: max, brightness: null, color_temp_kelvin: null, supported_features: 32 });
const dim = (name) => ({ friendly_name: name, supported_color_modes: ['brightness'], color_mode: null, brightness: null, supported_features: 32 });
const onoff = (name) => ({ friendly_name: name, supported_color_modes: ['onoff'], color_mode: null });
const rgb = (name) => ({ friendly_name: name, supported_color_modes: ['color_temp', 'xy'], color_mode: null, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6535, brightness: null, color_temp_kelvin: null });

add('light.lounge_ceiling', ct('Lounge ceiling'), { area: 'lounge', slow: true });
add('light.lounge_lamp', dim('Lounge lamp'), { area: 'lounge', quirk: 'fadeOffBright' });
add('switch.lounge_uplighter_plug', { friendly_name: 'Lounge uplighter plug', device_class: 'outlet' }, { area: 'lounge', deviceClass: 'outlet' });
add('switch.christmas_tree_plug', { friendly_name: 'Christmas tree plug', device_class: 'outlet' }, { area: 'lounge', deviceClass: 'outlet' });
add('light.kitchen_spots', ct('Kitchen spots', 2700, 6500), { area: 'kitchen' });
add('light.kitchen_under_cabinet', onoff('Kitchen under cabinet'), { area: 'kitchen' });
add('switch.kettle_plug', { friendly_name: 'Kettle plug', device_class: 'outlet' }, { area: 'kitchen', deviceClass: 'outlet' });
add('switch.dishwasher_child_lock', { friendly_name: 'Dishwasher child lock' }, { area: 'kitchen', category: 'config' });
add('light.hallway', dim('Hallway'), { area: 'hallway' });
add('light.landing', rgb('Landing strip'), { area: 'hallway', slow: true });
add('light.bedroom_ceiling', ct('Bedroom ceiling'), { area: 'bedroom' });
add('light.bedside_left', ct('Bedside left', 2200, 4000), { area: 'bedroom' });
add('light.bedside_right', ct('Bedside right', 2200, 4000), { area: 'bedroom' });
add('light.office_desk', ct('Office desk lamp'), { area: 'office' });
add('light.porch', onoff('Porch light'), { area: 'garden' });
add('switch.garden_festoon_socket', { friendly_name: 'Garden festoon socket', device_class: 'outlet' }, { area: 'garden', deviceClass: 'outlet', slow: true });
add('binary_sensor.hallway_motion', { friendly_name: 'Hallway motion', device_class: 'motion' }, { area: 'hallway' });
add('sensor.hallway_illuminance', { friendly_name: 'Hallway light level', device_class: 'illuminance', unit_of_measurement: 'lx' }, { area: 'hallway', state: '12' });
add('binary_sensor.front_door', { friendly_name: 'Front door', device_class: 'door' }, { area: 'hallway' });
add('person.tom', { friendly_name: 'Tom', user_id: 'u1' }, { state: 'home' });
add('person.sam', { friendly_name: 'Sam', user_id: 'u3' }, { state: 'home' });

// ---------- heating kit ----------
areas.push({ area_id: 'bedroom2', name: 'Spare room' });
const trv = (name, temp, cur, modes) => ({ friendly_name: name, hvac_modes: modes, temperature: temp, current_temperature: cur, min_temp: 5, max_temp: 30, target_temp_step: 0.5, battery: 80 });
add('climate.lounge_trv', trv('Lounge radiator', 18, 18.5, ['heat', 'off']), { area: 'lounge', state: 'heat' });
add('climate.bedroom_trv', trv('Bedroom radiator', 16, 17, ['heat', 'off', 'auto']), { area: 'bedroom', state: 'auto' });
add('climate.heating', { friendly_name: 'Heating', hvac_modes: ['heat', 'off', 'auto'], temperature: 7, current_temperature: 19, min_temp: 5, max_temp: 32, target_temp_step: 0.5 }, { state: 'auto' });
add('sensor.lounge_temperature', { friendly_name: 'Lounge temperature', device_class: 'temperature', unit_of_measurement: '°C' }, { area: 'lounge', state: '18.4' });
add('weather.home', { friendly_name: 'Home', temperature: 12, temperature_unit: '°C' }, { state: 'cloudy' });
add('zone.home', { friendly_name: 'Home', latitude: 53.26, longitude: -2.52, radius: 100 }, { state: '0' });

function refreshSun() {
  const ms = Date.now();
  const today = localDate(ms, TZ);
  const t = sunTimes(today, { tz: TZ, lat: LAT, lon: LON });
  const tm = sunTimes({ ...today, day: today.day + 1 }, { tz: TZ, lat: LAT, lon: LON });
  const next = (a, b) => new Date(a > ms ? a : b).toISOString();
  states.set('sun.sun', {
    entity_id: 'sun.sun', state: ms > t.sunrise && ms < t.sunset ? 'above_horizon' : 'below_horizon',
    attributes: { friendly_name: 'Sun', next_rising: next(t.sunrise, tm.sunrise), next_setting: next(t.sunset, tm.sunset) },
    last_changed: nowIso(), last_updated: nowIso(), context: { id: randomUUID() },
  });
}
refreshSun();
setInterval(refreshSun, 600000);


const sockets = new Set();
const calls = [];

function publicState(s) {
  return Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('_')));
}

function setState(entity, { on, brightness, kelvin, state, attrs }, context = { id: randomUUID(), parent_id: null, user_id: null }) {
  const old = states.get(entity);
  if (!old) return;
  const ns = structuredClone(old);
  if (state != null) ns.state = String(state);
  else if (on != null) ns.state = on ? 'on' : 'off';
  if (attrs) Object.assign(ns.attributes, attrs);
  const a = ns.attributes;
  if (entity.startsWith('light.')) {
    const modes = a.supported_color_modes || [];
    if (ns.state === 'on') {
      if (modes.some((m) => m !== 'onoff')) a.brightness = Math.round(((brightness ?? (old.state === 'on' && old.attributes.brightness != null ? Math.round(old.attributes.brightness / 2.55) : 100)) / 100) * 255);
      if (modes.includes('color_temp')) {
        a.color_temp_kelvin = Math.min(a.max_color_temp_kelvin, Math.max(a.min_color_temp_kelvin, kelvin ?? old.attributes.color_temp_kelvin ?? 2700));
        a.color_mode = 'color_temp';
      } else a.color_mode = modes[0];
    } else {
      a.brightness = null; a.color_mode = null;
      if ('color_temp_kelvin' in a) a.color_temp_kelvin = null;
    }
  }
  if (old.state !== ns.state) ns.last_changed = nowIso();
  ns.last_updated = nowIso();
  ns.context = context;
  states.set(entity, ns);
  history.push({ entity, t: Date.now(), s: ns.state, a: { brightness: a.brightness ?? null } });
  fireEvent('state_changed', { entity_id: entity, old_state: publicState(old), new_state: publicState(ns) }, context);
}

// Behave like real devices: HA writes the new state straight away with our context, then the
// device reports in on its own (fresh context, no user), including a mid-transition value.
// Cloud devices ("slow") only report back once, late, with a fresh context.
function simulateDevice(entity, service, d, context) {
  const s = states.get(entity);
  const on = service === 'turn_on';
  const fresh = () => ({ id: randomUUID(), parent_id: null, user_id: null });
  const target = { on, brightness: d.brightness_pct, kelvin: d.color_temp_kelvin };
  if (s._slow) { setTimeout(() => setState(entity, target, fresh()), 1500); return; }
  // Like some Zigbee bulbs: asked to fade to off, HA shows "off" straight away, then the bulb
  // jumps to full brightness instead and reports that a moment later.
  // A light that comes back on by itself after any off, a given number of times.
  if (s._bounces > 0 && !on) {
    s._bounces--;
    const delay = s._bounceDelay ?? 600; // some bulbs come back on a good while later
    setTimeout(() => setState(entity, { on: false }, context), 150);
    if (s._silent) { setTimeout(() => { states.get(entity)._really = { on: true, brightness: 100 }; }, delay); return; } // really on, but stays quiet
    setTimeout(() => setState(entity, { on: true, brightness: 100 }, fresh()), delay);
    return;
  }
  // A bulb (or Home Assistant) reporting a value from part-way through a fade, well after the fade
  if (s._lag && on) {
    const lag = s._lag; s._lag = null;
    setTimeout(() => setState(entity, target, context), 150);
    setTimeout(() => setState(entity, { on: true, brightness: lag.value, kelvin: d.color_temp_kelvin }, fresh()), lag.at);
    setTimeout(() => setState(entity, target, fresh()), lag.at + 1000);
    return;
  }
  s._really = null;
  if (s._quirk === 'fadeOffBright' && !on && d.transition > 0) {
    setTimeout(() => setState(entity, { on: false }, context), 150);
    setTimeout(() => setState(entity, { on: true, brightness: 100 }, fresh()), 600);
    return;
  }
  const wasOn = s.state === 'on';
  const from = s.attributes.brightness != null ? Math.round(s.attributes.brightness / 2.55) : 100;
  setTimeout(() => setState(entity, target, context), 150);
  if (entity.startsWith('light.') && on && wasOn && d.brightness_pct != null && Math.abs(from - d.brightness_pct) > 4) {
    const mid = Math.round((from + d.brightness_pct) / 2);
    setTimeout(() => setState(entity, { on: true, brightness: mid, kelvin: d.color_temp_kelvin }, fresh()), 450);
  }
  setTimeout(() => setState(entity, target, fresh()), 900);
}

function fireEvent(type, data, context = { id: randomUUID(), parent_id: null, user_id: null }) {
  for (const ws of sockets) {
    for (const [id, t] of ws.subs || []) {
      if (t !== type) continue;
      ws.send(JSON.stringify({ id, type: 'event', event: { event_type: type, data, origin: 'LOCAL', time_fired: nowIso(), context } }));
    }
  }
}

// ---------- synthetic history for the last day ----------
const history = [];
(function seedHistory() {
  const end = Date.now(); const start = end - 24 * 3600000;
  for (const id of states.keys()) {
    if (!/^(light|switch)\./.test(id)) continue;
    let t = start;
    history.push({ entity: id, t, s: 'off', a: { brightness: null } });
    const seed = [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
    // on in the evening of the previous day, off at night, on in the morning
    const evening = start + ((seed % 5) + 1) * 3600000;
    history.push({ entity: id, t: evening, s: 'on', a: { brightness: 150 + (seed % 100) } });
    history.push({ entity: id, t: evening + 2 * 3600000, s: 'on', a: { brightness: 60 } });
    history.push({ entity: id, t: evening + 4 * 3600000, s: 'off', a: { brightness: null } });
    history.push({ entity: id, t: start + 13 * 3600000, s: 'on', a: { brightness: 220 } });
    history.push({ entity: id, t: start + 15 * 3600000, s: 'off', a: { brightness: null } });
  }
  // the boiler (Hive thermostat) firing for an hour each morning and evening
  for (let t = start; t <= end; t += 30 * 60000) {
    const h = new Date(t).getHours();
    const firing = h === 7 || h === 17;
    history.push({ entity: 'climate.heating', t, s: 'heat', a: { hvac_action: firing ? 'heating' : 'idle', temperature: firing ? 30 : 7 } });
  }
  // a day of radiator and room temperatures
  for (const [id, base] of [['climate.lounge_trv', 18.5], ['climate.bedroom_trv', 17], ['sensor.lounge_temperature', 18.4]]) {
    for (let t = start; t <= end; t += 30 * 60000) {
      const h = new Date(t).getHours();
      const warm = (h >= 7 && h < 9) || (h >= 17 && h < 22);
      const cur = Math.round((base + (warm ? 1.6 : -0.8) + Math.sin(t / 3.6e6) * 0.3) * 10) / 10;
      if (id.startsWith('sensor.')) history.push({ entity: id, t, s: String(cur), a: { unit_of_measurement: '°C' } });
      else history.push({ entity: id, t, s: 'heat', a: { current_temperature: cur, temperature: warm ? 20 : 16, hvac_action: warm ? 'heating' : 'idle' } });
    }
  }
  for (let k = 0; k < 8; k++) {
    const t = Date.now() - (k * 2.7 + 1) * 3600000;
    history.push({ entity: 'binary_sensor.hallway_motion', t, s: 'on', a: {} });
    history.push({ entity: 'binary_sensor.hallway_motion', t: t + 6 * 60000, s: 'off', a: {} });
  }
})();

// A few things on at the start
setState('light.lounge_lamp', { on: true, brightness: 45 });

// ---------- WebSocket API ----------
// REST: POST /api/states/<entity_id> (what apps use to put their own sensors into HA)
const published = [];
const server = createServer(async (req, res) => {
  const m = /^\/api\/states\/([\w]+\.[\w]+)$/.exec(req.url);
  if (req.method === 'POST' && m) {
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end(); }
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    const id = m[1];
    const old = states.get(id);
    const ns = { entity_id: id, state: String(body.state), attributes: body.attributes || {}, last_changed: old && old.state === String(body.state) ? old.last_changed : nowIso(), last_updated: nowIso(), context: { id: randomUUID(), parent_id: null, user_id: null } };
    states.set(id, ns);
    published.push({ at: Date.now(), id, state: ns.state });
    fireEvent('state_changed', { entity_id: id, old_state: old ? publicState(old) : null, new_state: ns }, ns.context);
    res.writeHead(old ? 200 : 201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(ns));
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/api/websocket' });
let frozen = false;
// dashboard resources (storage mode), for the app keeping its card up to date
const resources = [{ id: 'r1', type: 'module', url: '/local/home-control-card.js?v=1.2.0' }];
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.10.0' }));
  ws.on('message', async (raw) => {
    if (frozen) return;
    const m = JSON.parse(raw.toString());
    const reply = (result, success = true, error) => ws.send(JSON.stringify({ id: m.id, type: 'result', success, result, ...(error ? { error } : {}) }));
    switch (m.type) {
      case 'auth':
        ws.send(JSON.stringify(m.access_token ? { type: 'auth_ok', ha_version: '2026.10.0' } : { type: 'auth_invalid', message: 'bad' }));
        return;
      case 'ping':
        return ws.send(JSON.stringify({ id: m.id, type: 'pong' }));
      case 'get_config':
        return reply({ time_zone: TZ, latitude: LAT, longitude: LON, location_name: 'Mock home', unit_system: { length: 'mi' }, version: '2026.10.0' });
      case 'get_states':
        return reply([...states.values()].map(publicState));
      case 'subscribe_events':
        (ws.subs ||= new Map()).set(m.id, m.event_type || '*');
        return reply(null);
      case 'config/entity_registry/list': return reply(entities);
      case 'config/device_registry/list': return reply(devices);
      case 'config/area_registry/list': return reply(areas);
      case 'lovelace/resources': return reply(resources);
      case 'lovelace/resources/create': { const r = { id: `r${resources.length + 1}`, type: m.res_type, url: m.url }; resources.push(r); return reply(r); }
      case 'lovelace/resources/update': {
        const r = resources.find((x) => x.id === m.resource_id);
        if (!r) return reply(null, false, { code: 'not_found', message: 'No such resource' });
        Object.assign(r, { type: m.res_type ?? r.type, url: m.url ?? r.url });
        return reply(r);
      }
      case 'config/auth/list': return reply([{ id: 'u1', name: 'Tom' }, { id: 'u2', name: 'Home Assistant Cloud' }]);
      case 'call_service': {
        const { domain, service, service_data: d = {} } = m;
        if (domain === 'climate') {
          calls.push({ at: Date.now(), domain, service, data: d });
          const id = d.entity_id;
          if (!states.has(id)) return reply(null, false, { code: 'not_found', message: `Entity ${id} not found` });
          const context = { id: randomUUID(), parent_id: null, user_id: 'supervisor' };
          reply({ context });
          if (service === 'set_temperature') setTimeout(() => setState(id, { attrs: { temperature: d.temperature } }, context), 200);
          if (service === 'set_hvac_mode') setTimeout(() => setState(id, { state: d.hvac_mode }, context), 200);
          return;
        }
        if (domain === 'homeassistant' && service === 'update_entity') {
          const context = { id: randomUUID(), parent_id: null, user_id: 'supervisor' };
          calls.push({ at: Date.now(), domain, service, data: d });
          reply({ context });
          for (const id of [].concat(d.entity_id || [])) {
            const st = states.get(id);
            if (st?._really) { const r = st._really; st._really = null; setTimeout(() => setState(id, r, context), 200); }
          }
          return;
        }
        const ids = [].concat(d.entity_id || m.target?.entity_id || []);
        calls.push({ at: Date.now(), domain, service, data: d });
        const missing = ids.find((id) => !states.has(id));
        if (!ids.length || missing) return reply(null, false, { code: 'not_found', message: `Entity ${missing} not found` });
        const context = { id: randomUUID(), parent_id: null, user_id: 'supervisor' };
        reply({ context });
        for (const id of ids) simulateDevice(id, service, d, context);
        return;
      }
      case 'history/history_during_period': {
        const start = Date.parse(m.start_time); const end = Date.parse(m.end_time || nowIso());
        const out = {};
        for (const id of m.entity_ids || []) {
          const rows = history.filter((h) => h.entity === id && h.t <= end).sort((a, b) => a.t - b.t);
          let before = null; const inside = [];
          for (const r of rows) { if (r.t < start) before = r; else inside.push(r); }
          const list = before ? [{ ...before, t: start }, ...inside] : inside;
          out[id] = list.map((r, i) => ({ s: r.s, ...(i % 3 === 0 || r.s === 'on' ? { a: r.a } : {}), lu: r.t / 1000 }));
        }
        return reply(out);
      }
      default:
        return reply(null, false, { code: 'unknown_command', message: `Unknown command ${m.type}` });
    }
  });
});
server.listen(PORT, () => console.log(`mock HA on ws://localhost:${PORT}/api/websocket`));

// ---------- control port ----------
createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const done = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/human') {
    setState(body.entity, { on: body.on, brightness: body.brightness, kelvin: body.kelvin }, { id: randomUUID(), parent_id: body.automation ? randomUUID() : null, user_id: body.user || null });
    return done({ ok: true, state: publicState(states.get(body.entity)) });
  }
  if (req.url === '/sensor') { setState(body.entity, { state: body.state, attrs: body.attrs }); return done({ ok: true }); }
  if (req.url === '/knob') { setState(body.entity, { attrs: { temperature: body.temperature } }); return done({ ok: true }); }
  if (req.url === '/bounce') { const st = states.get(body.entity); st._bounces = body.times; st._silent = !!body.silent; st._bounceDelay = body.delay ?? 600; return done({ ok: true }); }
  if (req.url === '/lag') { const st = states.get(body.entity); st._lag = { at: body.at, value: body.value }; return done({ ok: true }); }
  if (req.url === '/freeze') { frozen = true; return done({ ok: true }); }
  if (req.url === '/unfreeze') { frozen = false; return done({ ok: true }); }
  if (req.url === '/fire') { fireEvent(body.event_type, body.data || {}); return done({ ok: true }); }
  if (req.url === '/calls') return done(calls);
  if (req.url === '/published') return done({ count: published.length, states: Object.fromEntries([...states].filter(([k]) => /^(sensor|binary_sensor)\.home_/.test(k)).map(([k, v]) => [k, publicState(v)])) });
  if (req.url === '/resources') return done(resources);
  if (req.url === '/reset-calls') { calls.length = 0; return done({ ok: true }); }
  if (req.url === '/climate') return done(Object.fromEntries([...states].filter(([k]) => k.startsWith('climate.')).map(([k, v]) => [k, { state: v.state, temperature: v.attributes.temperature, current: v.attributes.current_temperature }])));
  if (req.url === '/states') return done(Object.fromEntries([...states].filter(([k]) => /^(light|switch)\./.test(k)).map(([k, v]) => [k, { state: v.state, brightness: v.attributes.brightness, kelvin: v.attributes.color_temp_kelvin, ...(v._really ? { really: v._really.on ? 'on' : 'off' } : {}) }])));
  res.writeHead(404); res.end();
}).listen(CTRL, () => console.log(`mock control on http://localhost:${CTRL}`));
