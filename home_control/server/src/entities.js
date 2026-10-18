// Lighting groups, heating rooms, scenes and the house's Away as real Home Assistant entities, so
// Alexa, Google, automations and other dashboards can use them ("Alexa, turn off the lounge lights").
//
// Made with MQTT discovery: Home Control publishes a description of each entity, retained, under
// homeassistant/<component>/home_control/<id>/config, and Home Assistant's MQTT integration creates
// it. Its state is published (retained) under home_control/…/state, and Home Assistant sends
// commands to home_control/…/set. Everything goes through Home Assistant itself (the mqtt.publish
// action and the mqtt/subscribe command on the app's one connection), so the broker's address and
// password are never needed here: it just needs the MQTT integration set up (the Mosquitto add-on).
//
//   light.home_control_<group>      each lighting group: on, off, brightness and warmth
//   climate.home_control_<room>     each heating room: its temperature (a hold until the next change),
//                                   off (snoozed until turned back on) and heat (back to its schedule)
//   scene.home_control_<scene>      each lighting scene
//   switch.home_control_away        the house's Away
//   select.home_control_heating_mode  Schedules, Away or Heating off
//
// Each group and each room is a device of its own, named in full ("Lounge lights", "Lounge heating")
// and put in the Home Assistant area with the same name, if there is one. Away and the heating mode
// belong to a "Home Control" device; scenes have none, so they're named just as they are here.
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'homeassistant';
const BASE = 'home_control';
const AVAIL = `${BASE}/status`;
const DEFAULTS = { enabled: false, lights: true, rooms: true, scenes: true, away: true, mode: true };
const MODE_OPTIONS = { auto: 'Schedules', away: 'Away', off: 'Heating off' };

export function slug(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

/** A light group's name in Home Assistant: "Lounge lights", but "Christmas lights" or "Bed lamp" as they are. */
export function lightsName(groupName) {
  return /\b(lights?|lamps?|lighting|sockets?|plugs?|spots?|bulbs?|led|strip)\b/i.test(groupName) ? groupName : `${groupName} lights`;
}

export function createEntities({ client, house, heating, lighting, dataDir, log = console, version = '' }) {
  const file = dataDir ? path.join(dataDir, 'entities.json') : null;
  let data = { settings: { ...DEFAULTS }, published: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { settings: { ...DEFAULTS, ...(raw.settings || {}) }, published: raw.published || {} };
  } catch { /* first start */ }
  const save = () => {
    if (!file) return;
    try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1)); fs.renameSync(`${file}.tmp`, file); } catch (err) { log.warn?.(`Couldn't save the entity settings: ${err.message}`); }
  };

  let mqtt = null;          // does Home Assistant have MQTT? (null: not looked yet)
  let areas = new Map();    // Home Assistant's areas: name in lower case -> name
  let ids = new Map();      // unique_id -> entity ID in Home Assistant (renamed there, or _2)
  let subscribed = false;
  let lastStates = new Map(); // state topic -> payload last published (this connection)
  let lastError = null;
  let timer = null;

  const S = () => data.settings;
  const origin = { name: 'Home Control', sw_version: version, support_url: 'https://github.com/tommiethefox80/ha-home-control' };

  async function publish(topic, payload, retain = true) {
    await client.callService('mqtt', 'publish', { topic, payload, retain, qos: 0 });
  }

  // ---------- what there should be ----------

  // A device for each group and each room, keyed by its ID here so a rename here renames it in
  // Home Assistant (rather than making another). Named in full ("Lounge lights", "Lounge heating"),
  // and put in the Home Assistant area of the same name, if there is one, when first made.
  function device(key, name, place, model) {
    const d = { identifiers: [`${BASE}_${key}`], name, manufacturer: 'Home Control', model, sw_version: version };
    const area = areas.get(String(place).toLowerCase());
    if (area) d.suggested_area = area;
    return d;
  }
  const HOUSE = () => ({ identifiers: [`${BASE}_house`], name: 'Home Control', manufacturer: 'Home Control', model: 'House', sw_version: version });

  /** Every entity there should be now: [{ component, id, config, state: { topic, payload } }]. */
  function desired() {
    const s = S();
    const out = [];
    const lightOn = house.on('lighting');
    const heatOn = house.on('heating');

    if (lightOn && s.lights) {
      const snap = lighting.snapshot();
      for (const g of snap.groups) {
        const id = `light_${g.id}`;
        const topic = `${BASE}/light/${g.id}`;
        const dims = !!g.dimmable;
        const ct = !!g.ct;
        const config = {
          name: null, unique_id: `${BASE}_${id}`, default_entity_id: `light.${BASE}_${slug(g.name)}`,
          schema: 'json', command_topic: `${topic}/set`, state_topic: `${topic}/state`,
          supported_color_modes: ct ? ['color_temp'] : dims ? ['brightness'] : ['onoff'],
          ...(ct ? { color_temp_kelvin: true, min_kelvin: Math.min(g.minK, g.maxK), max_kelvin: Math.max(g.minK, g.maxK) } : {}),
          icon: 'mdi:lightbulb-group', availability_topic: AVAIL, device: device(`group_${g.id}`, lightsName(g.name), g.name, 'Light group'), origin,
        };
        const cur = g.current || {};
        const on = !!cur.on;
        const st = { state: on ? 'ON' : 'OFF' };
        if (on && (dims || ct)) st.brightness = Math.max(1, Math.round(((cur.brightness ?? 100) / 100) * 255));
        // a colour mode only with its value: Home Assistant warns about color_temp without one
        if (on && ct && cur.kelvin) { st.color_mode = 'color_temp'; st.color_temp = Math.round(cur.kelvin); }
        else if (on && dims && !ct) st.color_mode = 'brightness';
        else if (on && !dims && !ct) st.color_mode = 'onoff';
        out.push({ component: 'light', id, config, state: { topic: `${topic}/state`, payload: JSON.stringify(st) } });
      }
    }
    if (lightOn && s.scenes) {
      for (const sc of lighting.engine.data.scenes || []) {
        const id = `scene_${sc.id}`;
        out.push({
          component: 'scene', id, state: null,
          config: {
            // no device, so it's just "Film night" ("Alexa, turn on Film night"), not "Home Control Film night"
            name: sc.name, unique_id: `${BASE}_${id}`, default_entity_id: `scene.${BASE}_${slug(sc.name)}`,
            command_topic: `${BASE}/scene/${sc.id}/set`, payload_on: 'ON', icon: 'mdi:palette', availability_topic: AVAIL, origin,
          },
        });
      }
    }
    if (heatOn && s.rooms) {
      for (const v of heating.engine.views || []) {
        if (!v.enabled) continue;
        const id = `climate_${v.id}`;
        const topic = `${BASE}/climate/${v.id}`;
        const off = v.source === 'snooze';
        const st = {
          mode: off ? 'off' : 'heat',
          target: v.target ?? null,
          current: v.current ?? null,
          action: off ? 'off' : v.calling ? 'heating' : 'idle',
          status: v.source || null,
        };
        out.push({
          component: 'climate', id,
          config: {
            name: null, unique_id: `${BASE}_${id}`, default_entity_id: `climate.${BASE}_${slug(v.name)}`,
            modes: ['heat', 'off'],
            mode_command_topic: `${topic}/mode/set`, mode_state_topic: `${topic}/state`, mode_state_template: '{{ value_json.mode }}',
            temperature_command_topic: `${topic}/temperature/set`, temperature_state_topic: `${topic}/state`, temperature_state_template: '{{ value_json.target }}',
            current_temperature_topic: `${topic}/state`, current_temperature_template: '{{ value_json.current }}',
            action_topic: `${topic}/state`, action_template: '{{ value_json.action }}',
            json_attributes_topic: `${topic}/state`, json_attributes_template: '{{ {"status": value_json.status} | tojson }}',
            min_temp: 5, max_temp: 30, temp_step: 0.5, precision: 0.1, temperature_unit: 'C',
            availability_topic: AVAIL, device: device(`room_${v.id}`, `${v.name} heating`, v.name, 'Heating room'), origin,
          },
          state: { topic: `${topic}/state`, payload: JSON.stringify(st) },
        });
      }
    }
    if (s.away && (heatOn || lightOn)) {
      const away = (heatOn && heating.store.data.runtime.mode === 'away') || (lightOn && lighting.engine.data.mode === 'away');
      out.push({
        component: 'switch', id: 'away', state: { topic: `${BASE}/away/state`, payload: away ? 'ON' : 'OFF' },
        config: {
          name: 'Away', unique_id: `${BASE}_away`, default_entity_id: `switch.${BASE}_away`,
          command_topic: `${BASE}/away/set`, state_topic: `${BASE}/away/state`, payload_on: 'ON', payload_off: 'OFF',
          icon: 'mdi:home-export-outline', availability_topic: AVAIL, device: HOUSE(), origin,
        },
      });
    }
    if (s.mode && heatOn) {
      out.push({
        component: 'select', id: 'heating_mode', state: { topic: `${BASE}/heating_mode/state`, payload: MODE_OPTIONS[heating.store.data.runtime.mode] || 'Schedules' },
        config: {
          name: 'Heating mode', unique_id: `${BASE}_heating_mode`, default_entity_id: `select.${BASE}_heating_mode`,
          options: Object.values(MODE_OPTIONS), command_topic: `${BASE}/heating_mode/set`, state_topic: `${BASE}/heating_mode/state`,
          icon: 'mdi:radiator', availability_topic: AVAIL, device: HOUSE(), origin,
        },
      });
    }
    return out;
  }

  // ---------- keeping Home Assistant up to date ----------

  let busy = false; let again = false;
  async function sync() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      if (!client.connected) return;
      if (mqtt == null) await look();
      const want = S().enabled && mqtt ? desired() : [];
      const topics = new Set();
      if (want.length) await publish(AVAIL, 'online');
      for (const e of want) {
        const topic = `${PREFIX}/${e.component}/${BASE}/${e.id}/config`;
        topics.add(topic);
        const body = JSON.stringify(e.config);
        if (data.published[topic] !== body) {
          await publish(topic, body);
          data.published[topic] = body;
          lastStates.delete(e.state?.topic); // a new entity gets its state again
          save();
        }
      }
      // gone (deleted, or turned off here): an empty config removes it from Home Assistant
      for (const topic of Object.keys(data.published)) {
        if (topics.has(topic)) continue;
        if (mqtt) await publish(topic, '');
        delete data.published[topic];
        save();
      }
      for (const e of want) {
        if (!e.state || lastStates.get(e.state.topic) === e.state.payload) continue;
        await publish(e.state.topic, e.state.payload);
        lastStates.set(e.state.topic, e.state.payload);
      }
      if (want.length && !subscribed) await listen();
      lastError = null;
    } catch (err) {
      lastError = err.message;
      log.warn?.(`Home Assistant entities: ${err.message}`);
    } finally {
      busy = false;
      if (again) { again = false; soon(500); }
    }
  }
  const soon = (ms = 800) => { clearTimeout(timer); timer = setTimeout(sync, ms); timer.unref?.(); };

  /** Is MQTT set up in Home Assistant, and what areas are there? */
  async function look() {
    try {
      const services = await client.send('get_services');
      mqtt = !!services?.mqtt?.publish;
    } catch { mqtt = false; }
    try {
      const list = await client.send('config/area_registry/list');
      areas = new Map((list || []).filter((a) => a.name).map((a) => [String(a.name).toLowerCase(), String(a.name)]));
    } catch { /* areas not readable: devices just aren't put in areas */ }
  }

  /** The entity IDs Home Assistant actually gave them, for the settings page. */
  async function readIds() {
    try {
      const list = await client.send('config/entity_registry/list');
      ids = new Map((list || []).filter((e) => e.platform === 'mqtt' && String(e.unique_id || '').startsWith(`${BASE}_`)).map((e) => [e.unique_id, e.entity_id]));
    } catch { /* not readable: the suggested IDs are shown */ }
  }

  async function listen() {
    try {
      await client.subscribeMessage('mqtt/subscribe', { topic: `${BASE}/#` }, (ev) => onMessage(ev?.topic, ev?.payload));
      subscribed = true;
    } catch (err) { log.warn?.(`Home Assistant entities: couldn't listen for commands: ${err.message}`); }
  }

  // ---------- commands from Home Assistant ----------

  const from = 'from Home Assistant';
  function onMessage(topic, payload) {
    if (!topic || !topic.endsWith('/set') || !S().enabled) return;
    const parts = topic.split('/'); // home_control/<kind>/<id>[/<what>]/set
    try {
      if (parts[1] === 'light') {
        const g = lighting.engine.data.groups.find((x) => x.id === parts[2]);
        if (!g) return;
        let cmd = {};
        try { cmd = JSON.parse(payload); } catch { cmd = { state: String(payload).toUpperCase() }; }
        const body = {};
        if (cmd.state === 'OFF') body.on = false;
        else {
          body.on = true;
          if (cmd.brightness != null) body.brightness = Math.max(1, Math.round((Number(cmd.brightness) / 255) * 100));
          if (cmd.color_temp != null) body.kelvin = Number(cmd.color_temp) > 1000 ? Number(cmd.color_temp) : Math.round(1e6 / Number(cmd.color_temp));
        }
        lighting.engine.setGroup(g.id, body, { quiet: true });
        lighting.engine.addActivity(`${g.name}: ${body.on === false ? 'turned off' : body.brightness != null ? `set to ${body.brightness}%` : 'turned on'} ${from}, until its next change.`, g.id);
      } else if (parts[1] === 'scene') {
        lighting.engine.runScene(parts[2], { from: 'Home Assistant' });
      } else if (parts[1] === 'climate') {
        const z = heating.engine.zones.find((x) => x.id === parts[2]);
        if (!z) return;
        if (parts[3] === 'temperature') {
          heating.engine.setOverride(z.id, { temp: Number(payload), untilNext: true, kind: 'hold' });
        } else if (parts[3] === 'mode') {
          if (payload === 'off') heating.engine.setOverride(z.id, { kind: 'snooze', forever: true });
          else if (payload === 'heat') heating.engine.clearOverride(z.id);
        }
      } else if (parts[1] === 'away') {
        setAway(String(payload).toUpperCase() === 'ON');
      } else if (parts[1] === 'heating_mode') {
        const mode = Object.keys(MODE_OPTIONS).find((k) => MODE_OPTIONS[k] === payload);
        if (mode) heating.engine.setMode(mode, null, { by: 'user' });
      }
      soon(300);
    } catch (err) {
      log.warn?.(`Home Assistant entities: ${topic}: ${err.message}`);
      soon(300); // put Home Assistant's view back to how things are
    }
  }

  /** The house's Away, as on the Heating and Lighting pages. */
  function setAway(on) {
    if (house.on('heating') && heating.store.data.runtime.mode !== 'off') {
      heating.engine.setMode(on ? 'away' : 'auto', null, { by: 'user' }); // the lights follow
    } else if (house.on('lighting')) {
      house.setFromLighting(on ? 'away' : 'schedule');
    }
  }

  // ---------- settings (General → Home Assistant entities) ----------

  function view() {
    const list = S().enabled && mqtt ? desired() : [];
    return {
      settings: S(),
      mqtt,
      error: lastError,
      // as Home Assistant names them: the device's name, then the entity's (if it has one)
      entities: list.map((e) => ({ id: ids.get(e.config.unique_id) || e.config.default_entity_id, name: [e.config.device?.name, e.config.name].filter(Boolean).join(' '), kind: e.component })),
    };
  }

  async function update(body) {
    const s = { ...S() };
    for (const k of Object.keys(DEFAULTS)) if (typeof body?.[k] === 'boolean') s[k] = body[k];
    data.settings = s;
    save();
    if (s.enabled) await look();
    await sync();
    if (s.enabled && mqtt) await readIds();
    return view();
  }

  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function handle(req, res, p) {
    if (p !== '/api/ha-entities') return false;
    try {
      if (req.method === 'GET') {
        if (S().enabled || mqtt == null) await look();
        if (S().enabled && mqtt) await readIds();
        return send(res, 200, view()), true;
      }
      if (req.method === 'PUT') {
        let s = ''; for await (const c of req) s += c;
        return send(res, 200, await update(s ? JSON.parse(s) : {})), true;
      }
      return send(res, 405, { error: 'Not allowed' }), true;
    } catch (err) { return send(res, 400, { error: err.message }), true; }
  }

  function start() {
    client.on('ready', () => { subscribed = false; lastStates = new Map(); mqtt = null; setTimeout(() => sync(), 4000); });
    client.on('disconnected', () => { subscribed = false; });
    heating.engine.on('change', () => { if (S().enabled) soon(); });
    lighting.engine.on('change', () => { if (S().enabled) soon(); });
    house.events.on('modules', () => soon(300));
    // every so often, in case anything was missed (and new areas)
    const t = setInterval(() => { if (S().enabled) { mqtt = null; soon(0); } }, 15 * 60000); t.unref?.();
  }

  async function shutdown() {
    if (!S().enabled || !mqtt || !client.connected) return;
    try { await publish(AVAIL, 'offline'); } catch { /* going anyway */ }
  }

  return { start, shutdown, handle, sync, view, onMessage };
}
