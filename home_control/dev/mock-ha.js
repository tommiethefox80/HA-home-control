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
import fs from 'node:fs';
import path from 'node:path';

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

// ---------- cameras: four makes, as their integrations set them up ----------
const PICTURES = new URL('./cameras/', import.meta.url).pathname;
const MEDIA = process.env.MOCK_MEDIA_DIR || new URL('./data/media/', import.meta.url).pathname;
const cameraPicture = {};
const pictureMode = {}; // camera -> 'live' | 'still' | 'none' (see camera_proxy)
function addCameraDevice(slug, name, { manufacturer, model, platform, area, stream = true, picture, camera, extras = [] }) {
  const device_id = `dev_cam_${slug}`;
  devices.push({ id: device_id, area_id: area, name, manufacturer, model, name_by_user: null });
  const reg = (entity_id, attrs, { state = 'off', category = null, deviceClass = null, from = platform } = {}) => {
    entities.push({ entity_id, device_id, area_id: null, entity_category: category, disabled_by: null, hidden_by: null, original_device_class: deviceClass, name: null, platform: from });
    states.set(entity_id, { entity_id, state, attributes: { friendly_name: attrs.name, ...attrs.extra }, last_changed: nowIso(), last_updated: nowIso(), context: { id: randomUUID(), parent_id: null, user_id: null } });
  };
  const camId = `camera.${camera}`;
  reg(camId, { name: `${name} ${camera.slice(slug.length + 1).replace(/_/g, ' ')}`.trim(), extra: { entity_picture: `/api/camera_proxy/${camId}?token=t0k3n`, access_token: 't0k3n', supported_features: stream ? 2 : 0, brand: manufacturer, model_name: model } }, { state: 'idle' });
  cameraPicture[camId] = picture;
  for (const [id, label, opts = {}] of extras) {
    const domain = id.split('.')[0];
    const extra = {};
    if (opts.deviceClass) extra.device_class = opts.deviceClass;
    if (domain === 'select') extra.options = opts.options;
    if (domain === 'number') Object.assign(extra, { min: opts.min ?? 0, max: opts.max ?? 100, step: opts.step ?? 1, unit_of_measurement: opts.unit ?? '' });
    if (domain === 'event') extra.event_types = opts.types || ['ring'];
    reg(id, { name: `${name} ${label}`, extra }, { state: opts.state ?? (domain === 'select' ? opts.options[0] : domain === 'number' ? String(opts.value ?? 50) : domain === 'event' || domain === 'button' ? 'unknown' : 'off'), category: opts.category || null, deviceClass: opts.deviceClass || null, from: opts.platform || platform });
  }
}
areas.push({ area_id: 'driveway', name: 'Driveway' });
addCameraDevice('garden', 'Garden', {
  manufacturer: 'Ubiquiti', model: 'G5 Turret Ultra', platform: 'unifiprotect', area: 'garden', picture: 'garden.jpg', camera: 'garden_high_resolution_channel',
  extras: [
    ['binary_sensor.garden_motion', 'Motion', { deviceClass: 'motion' }],
    ['binary_sensor.garden_person_detected', 'Person detected', { deviceClass: 'occupancy' }],
    ['binary_sensor.garden_vehicle_detected', 'Vehicle detected', { deviceClass: 'occupancy' }],
    ['binary_sensor.garden_is_dark', 'Is dark', { category: 'diagnostic' }],
    ['switch.garden_privacy_mode', 'Privacy mode', { category: 'config' }],
    ['select.garden_recording_mode', 'Recording mode', { category: 'config', options: ['Always', 'Never', 'Detections'], state: 'Detections' }],
    ['select.garden_infrared_mode', 'Infrared mode', { category: 'config', options: ['Auto', 'Always enable', 'Always disable'] }],
    ['switch.garden_status_light_on', 'Status light on', { category: 'config', state: 'on' }],
    ['switch.garden_detections_person', 'Detections: person', { category: 'config', state: 'on' }],
    ['number.garden_microphone_level', 'Microphone level', { category: 'config', min: 0, max: 100, value: 60, unit: '%' }],
    ['button.garden_reboot_device', 'Reboot device', { category: 'diagnostic' }],
    // another integration's view of the same device (Home Assistant joins them by network address),
    // which says "disconnected" while the camera itself is fine, as on Tom's Garden CCTV
    ['binary_sensor.garden_connected', 'Connected', { deviceClass: 'connectivity', platform: 'ping', state: 'off' }],
  ],
});
addCameraDevice('front_door', 'Front door', {
  manufacturer: 'Ring', model: 'Video Doorbell (2nd Gen)', platform: 'ring', area: 'hallway', picture: 'front_door.jpg', camera: 'front_door_live_view',
  extras: [
    ['event.front_door_ding', 'Ding', { types: ['ding'], deviceClass: 'doorbell' }],
    ['event.front_door_motion', 'Motion', { types: ['motion'], deviceClass: 'motion' }],
    ['switch.front_door_motion_detection', 'Motion detection', { state: 'on' }],
    ['number.front_door_volume', 'Volume', { category: 'config', min: 0, max: 10, value: 6 }],
  ],
});
addCameraDevice('driveway', 'Driveway', {
  manufacturer: 'Reolink', model: 'RLC-811A', platform: 'reolink', area: 'driveway', picture: 'driveway.jpg', camera: 'driveway_fluent',
  extras: [
    ['binary_sensor.driveway_motion', 'Motion', { deviceClass: 'motion' }],
    ['binary_sensor.driveway_person', 'Person', {}],
    ['binary_sensor.driveway_vehicle', 'Vehicle', {}],
    ['binary_sensor.driveway_animal', 'Animal', {}],
    ['switch.driveway_record', 'Record', { category: 'config', state: 'on' }],
    ['switch.driveway_email_on_event', 'Email on event', { category: 'config' }],
    ['light.driveway_floodlight', 'Floodlight', {}],
    ['siren.driveway_siren', 'Siren', {}],
    ['select.driveway_day_night_mode', 'Day night mode', { category: 'config', options: ['Auto', 'Color', 'Black&White'] }],
    ['number.driveway_motion_sensitivity', 'Motion sensitivity', { category: 'config', min: 1, max: 50, value: 41 }],
    ['button.driveway_restart', 'Restart', { category: 'diagnostic' }],
    // the camera's own "online" sensor, as Amcrest, Axis and Hikvision cameras have
    ['binary_sensor.driveway_online', 'Online', { deviceClass: 'connectivity', category: 'diagnostic', state: 'on' }],
  ],
});
addCameraDevice('shed', 'Shed', { manufacturer: 'Generic', model: 'RTSP camera', platform: 'generic', area: 'garden', picture: 'shed.jpg', camera: 'shed', stream: false });
// ---------- a UniFi network, as the UniFi Network integration sets it up ----------
// Devices (gateway, switch, access points) by MAC; networks (WLANs) as service devices; clients as
// router device trackers. Entities Home Assistant turns off to start with (PoE ports, QR codes,
// client trackers for devices it doesn't otherwise know) are in the registry with disabled_by set.
const QR_PICTURE = new URL('./wifi/qr.png', import.meta.url).pathname;
const unifiDisabled = new Map(); // entity -> its state, for when it's turned on
function unifi(entity_id, unique_id, attrs, { device_id = null, state = 'on', category = 'config', disabled = false, deviceClass = null } = {}) {
  entities.push({ entity_id, unique_id, device_id, area_id: null, entity_category: category, disabled_by: disabled ? 'integration' : null, hidden_by: null, original_device_class: deviceClass, name: null, platform: 'unifi' });
  const st = { entity_id, state, attributes: { ...attrs }, last_changed: nowIso(), last_updated: nowIso(), context: { id: randomUUID(), parent_id: null, user_id: null } };
  if (disabled) unifiDisabled.set(entity_id, st); else states.set(entity_id, st);
}
function unifiDevice(slug, name, mac, model, { led = null, ports = 0, poeOn = [], enabledPorts = [], uplink = null, clients = 0, temp = null, state = 'connected' } = {}) {
  const device_id = `dev_unifi_${slug}`;
  devices.push({ id: device_id, area_id: null, name, name_by_user: null, manufacturer: 'Ubiquiti Networks', model, sw_version: '6.6.77', connections: [['mac', mac]] });
  const o = { device_id };
  if (led != null) unifi(`light.${slug}_led`, `led-${mac}`, { friendly_name: `${name} LED`, supported_color_modes: ['onoff'], color_mode: led ? 'onoff' : null }, { ...o, state: led ? 'on' : 'off' });
  unifi(`button.${slug}_restart`, `device_restart-${mac}`, { friendly_name: `${name} Restart`, device_class: 'restart' }, { ...o, state: 'unknown' });
  unifi(`sensor.${slug}_state`, `device_state-${mac}`, { friendly_name: `${name} State`, device_class: 'enum' }, { ...o, state, category: 'diagnostic' });
  unifi(`sensor.${slug}_uptime`, `device_uptime-${mac}`, { friendly_name: `${name} Uptime`, device_class: 'timestamp' }, { ...o, state: new Date(Date.now() - 9 * 86400000).toISOString(), category: 'diagnostic' });
  unifi(`sensor.${slug}_clients`, `device_clients-${mac}`, { friendly_name: `${name} Clients` }, { ...o, state: String(clients), category: 'diagnostic', disabled: true });
  if (temp != null) unifi(`sensor.${slug}_temperature`, `device_temperature-${mac}`, { friendly_name: `${name} Temperature`, unit_of_measurement: '°C', device_class: 'temperature' }, { ...o, state: String(temp), category: 'diagnostic' });
  if (uplink) unifi(`sensor.${slug}_uplink_mac`, `device_uplink_mac-${mac}`, { friendly_name: `${name} Uplink MAC` }, { ...o, state: uplink, category: 'diagnostic' });
  unifi(`update.${slug}`, `device_update-${mac}`, { friendly_name: name, installed_version: '6.6.77', latest_version: slug === 'garden_ap' ? '6.7.10' : '6.6.77' }, { ...o, state: slug === 'garden_ap' ? 'on' : 'off' });
  unifi(`device_tracker.${slug}`, mac, { friendly_name: name, source_type: 'router', ip: '192.168.1.2', mac }, { state: state === 'connected' ? 'home' : 'not_home', category: null });
  for (let p = 1; p <= ports; p++) {
    unifi(`switch.${slug}_port_${p}_poe`, `poe-${mac}_${p}`, { friendly_name: `${name} Port ${p} PoE`, device_class: 'outlet' }, { ...o, state: poeOn.includes(p) ? 'on' : 'off', disabled: !enabledPorts.includes(p) });
  }
}
function unifiWlan(slug, name, id, { on = true, clients = 0 } = {}) {
  const device_id = `dev_unifi_wlan_${slug}`;
  devices.push({ id: device_id, area_id: null, name, name_by_user: null, manufacturer: 'Ubiquiti Networks', model: 'UniFi WLAN', entry_type: 'service', connections: [] });
  const o = { device_id };
  unifi(`switch.${slug}`, `wlan-${id}`, { friendly_name: name, device_class: 'switch' }, { ...o, state: on ? 'on' : 'off' });
  unifi(`sensor.${slug}`, `wlan_clients-${id}`, { friendly_name: name, state_class: 'measurement' }, { ...o, state: String(clients), category: 'diagnostic' });
  unifi(`image.${slug}_qr_code`, `qr_code-${id}`, { friendly_name: `${name} QR Code`, entity_picture: `/api/image_proxy/image.${slug}_qr_code?token=t0k3n`, access_token: 't0k3n' }, { ...o, state: nowIso(), category: 'diagnostic', disabled: true });
}
const MAC = { gw: '70:a7:41:00:00:01', sw: '70:a7:41:00:00:02', lounge: '70:a7:41:00:00:11', upstairs: '70:a7:41:00:00:12', garden: '70:a7:41:00:00:13' };
unifiDevice('dream_machine_pro', 'Dream Machine Pro', MAC.gw, 'UDMPRO', { temp: 52 });
unifiDevice('office_switch', 'Office switch', MAC.sw, 'USL8LP', { led: true, ports: 8, poeOn: [1, 2, 3, 4, 5, 6, 7, 8], enabledPorts: [3], uplink: MAC.gw, temp: 41 });
unifiDevice('lounge_ap', 'Lounge AP', MAC.lounge, 'UAL6', { led: true, uplink: MAC.sw, clients: 4 });
unifiDevice('upstairs_ap', 'Upstairs AP', MAC.upstairs, 'UAP6MP', { led: true, uplink: MAC.sw, clients: 2 });
unifiDevice('garden_ap', 'Garden AP', MAC.garden, 'UALR6', { led: false, uplink: MAC.sw, clients: 1 });
unifiWlan('fox_home', 'Fox Home', '64b0a1c2d3e4f5a6b7c8d901', { clients: 4 });
unifiWlan('fox_guest', 'Fox Guest', '64b0a1c2d3e4f5a6b7c8d902', { clients: 1 });
unifiWlan('fox_iot', 'Fox IoT', '64b0a1c2d3e4f5a6b7c8d903', { clients: 2 });
function unifiClient(slug, name, mac, { home = true, essid = null, ap = null, radio = 'na', ip, guest = false, oui = 'Apple, Inc.', disabled = false, block = false } = {}) {
  const attrs = { friendly_name: name, source_type: 'router', mac, name, oui, host_name: slug.replace(/_/g, '-'), ...(home ? { ip, ...(essid ? { essid, ap_mac: ap, radio, radio_proto: radio === 'ng' ? 'ng' : 'ax', is_guest: guest, vlan: guest ? 20 : 1 } : {}) } : {}) };
  unifi(`device_tracker.${slug}`, `default-${mac}`, attrs, { state: home ? 'home' : 'not_home', category: null, disabled });
  if (block) unifi(`switch.${slug}_block`, `block-${mac}`, { friendly_name: name }, { state: 'on' });
}
unifiClient('toms_iphone', "Tom's iPhone", 'a4:83:e7:10:00:01', { essid: 'Fox Home', ap: MAC.lounge, ip: '192.168.1.40' });
unifiClient('sams_ipad', "Sam's iPad", 'a4:83:e7:10:00:02', { essid: 'Fox Home', ap: MAC.upstairs, ip: '192.168.1.41', block: true });
unifiClient('macbook_pro', 'MacBook Pro', 'a4:83:e7:10:00:03', { essid: 'Fox Home', ap: MAC.upstairs, ip: '192.168.1.42' });
unifiClient('living_room_tv', 'Living room TV', 'a4:83:e7:10:00:04', { essid: 'Fox Home', ap: MAC.lounge, radio: 'ng', ip: '192.168.1.43', oui: 'Samsung Electronics' });
unifiClient('ring_doorbell', 'Front Door doorbell', 'a4:83:e7:10:00:05', { essid: 'Fox IoT', ap: MAC.garden, radio: 'ng', ip: '192.168.30.10', oui: 'Ring LLC' });
unifiClient('hue_bridge', 'Hue Bridge', 'a4:83:e7:10:00:06', { ip: '192.168.30.11', oui: 'Philips Lighting' }); // wired
unifiClient('visitor_phone', 'Galaxy S24', 'a4:83:e7:10:00:07', { essid: 'Fox Guest', ap: MAC.lounge, ip: '192.168.20.5', guest: true, oui: 'Samsung Electronics' });
unifiClient('work_laptop', 'Work laptop', 'a4:83:e7:10:00:08', { home: false, oui: 'Dell Inc.' });
for (let i = 1; i <= 5; i++) unifiClient(`unknown_${i}`, `Device ${i}`, `a4:83:e7:20:00:0${i}`, { essid: 'Fox IoT', ap: MAC.garden, radio: 'ng', ip: `192.168.30.${20 + i}`, oui: 'Espressif Inc.', disabled: true });

// notify services: two phones with the Home Assistant app
const NOTIFY = ['mobile_app_toms_iphone', 'mobile_app_sams_pixel_8', 'send_message', 'persistent_notification'];

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

// ---------- a week of a physical house ----------
// Outside temperature with day/night swings and colder and milder days; two rooms that each hour
// lose a share (k) of the gap to outside (Newton's law), warm while heating (more slowly on cold
// days), and keep warming a little after the heat goes off (leftover radiator heat). Lounge holds
// its heat well; Bedroom loses it faster. What each room called for, and a daily log like the app's,
// are at GET /sim-log, so a test can give the app the week it would have recorded.
const SIM = { calls: { Lounge: [], Bedroom: [] }, days: {} };
function simulateWeek(end) {
  const start = end - 7 * 86400000; const step = 5 * 60000; const Hr = 3600000;
  const DAY_SHIFT = [3, 0, -3, -1, 2, -2, 1, 0];
  const outsideAt = (t) => {
    const d = Math.floor((t - start) / 86400000);
    const h = (new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60);
    return 7 + DAY_SHIFT[d % DAY_SHIFT.length] + 4 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
  };
  const local = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return { h: Number(p.hour) + Number(p.minute) / 60, key: `${p.year}-${p.month}-${p.day}` }; };
  const targetAt = (t) => { const { h } = local(t); return h >= 6.5 && h < 8.5 ? 20 : h >= 16.5 && h < 22.5 ? 20.5 : 15; };
  const rooms = [
    { name: 'Lounge', k: 0.045, heat: 2.6, cold: 0.05, T: 18.5, rad: 0, calling: false, ids: ['sensor.lounge_temperature', 'climate.lounge_trv'] },
    { name: 'Bedroom', k: 0.09, heat: 2.4, cold: 0.06, T: 17, rad: 0, calling: false, ids: ['climate.bedroom_trv'] },
  ];
  for (let t = start; t <= end; t += step) {
    const out = outsideAt(t); const target = targetAt(t); const dk = local(t).key;
    const day = (SIM.days[dk] ||= { boilerMin: 0, outSum: 0, outN: 0, rooms: {} });
    day.outSum += out * 5; day.outN += 5;
    let any = false;
    for (const r of rooms) {
      r.calling = r.calling ? r.T < target : r.T < target - 0.3;
      if (r.calling) { any = true; if (!r.open) r.open = t; } else if (r.open) { SIM.calls[r.name].push([r.open, t]); r.open = null; }
      // the radiator warms over ~15 min while heating and cools over ~25 min after
      r.rad = r.calling ? Math.min(1, r.rad + step / (15 * 60000)) : r.rad * Math.exp(-step / (25 * 60000));
      const heatRate = r.heat * (1 - r.cold * (12 - out) / 2); // °/h at full radiator: slower on colder days
      r.T += (-r.k * (r.T - out) + r.rad * heatRate) * (step / Hr);
      const rr = (day.rooms[r.name] ||= { callMin: 0, tempSum: 0, tempN: 0 });
      if (r.calling) rr.callMin += 5;
      rr.tempSum += r.T * 5; rr.tempN += 5;
      for (const id of r.ids) {
        const cur = Math.round(r.T * 10) / 10;
        if (id.startsWith('sensor.')) history.push({ entity: id, t, s: String(cur), a: { unit_of_measurement: '°C' } });
        else history.push({ entity: id, t, s: 'heat', a: { current_temperature: Math.round(r.T * 2) / 2, temperature: r.calling ? target : target - 0.5, hvac_action: r.calling ? 'heating' : 'idle' } });
      }
    }
    if (any) day.boilerMin += 5;
    if ((t - start) % (30 * 60000) === 0) history.push({ entity: 'weather.home', t, s: 'cloudy', a: { temperature: Math.round(out * 10) / 10, temperature_unit: '°C' } });
    history.push({ entity: 'climate.heating', t, s: 'heat', a: { hvac_action: any ? 'heating' : 'idle', temperature: any ? 30 : 7 } });
  }
  for (const r of rooms) if (r.open) SIM.calls[r.name].push([r.open, end]);
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
  // a week of room temperatures from a small physical model (see simulateWeek below)
  simulateWeek(end);
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
  const cp = /^\/api\/camera_proxy\/(camera\.\w+)(\?.*)?$/.exec(req.url);
  if (req.method === 'GET' && cp) {
    if (!/^Bearer \S+/.test(req.headers.authorization || '') && !/token=/.test(cp[2] || '')) { res.writeHead(401); return res.end(); }
    const st = states.get(cp[1]);
    if (!st || !cameraPicture[cp[1]]) { res.writeHead(404); return res.end(); }
    // live: a new picture each time (as a real camera's are); still: the same saved one; none: no answer.
    // A camera Home Assistant shows as unavailable gives none, unless told otherwise (/picture).
    const mode = pictureMode[cp[1]] || (st.state === 'unavailable' ? 'none' : 'live');
    if (mode === 'none') { res.writeHead(500); return res.end(); }
    let buf = fs.readFileSync(path.join(PICTURES, cameraPicture[cp[1]]));
    if (mode === 'live') {
      const note = Buffer.from(`mock ${Date.now()} ${Math.random()}`);
      const com = Buffer.from([0xff, 0xfe, 0, 0]); com.writeUInt16BE(note.length + 2, 2); // a JPEG comment
      buf = Buffer.concat([buf.subarray(0, 2), com, note, buf.subarray(2)]);
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length });
    return res.end(buf);
  }
  const ip = /^\/api\/image_proxy\/(image\.\w+)(\?.*)?$/.exec(req.url);
  if (req.method === 'GET' && ip) {
    if (!/^Bearer \S+/.test(req.headers.authorization || '') && !/token=/.test(ip[2] || '')) { res.writeHead(401); return res.end(); }
    if (!states.has(ip[1])) { res.writeHead(404); return res.end(); }
    const buf = fs.readFileSync(QR_PICTURE);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length });
    return res.end(buf);
  }
  const m = /^\/api\/states\/([\w]+\.[\w]+)$/.exec(req.url);
  if (req.method === 'DELETE' && m) { // as Home Assistant: removes the state, 404 if there's none
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end(); }
    const old = states.get(m[1]);
    if (!old) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ message: 'Entity not found.' })); }
    states.delete(m[1]);
    fireEvent('state_changed', { entity_id: m[1], old_state: publicState(old), new_state: null }, { id: randomUUID(), parent_id: null, user_id: null });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Entity removed.' }));
  }
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
      case 'config/entity_registry/update': {
        // as Home Assistant: turning an entity on takes effect when its integration reloads, 30 s later (here 1.5 s)
        const e = entities.find((x) => x.entity_id === m.entity_id);
        if (!e) return reply(null, false, { code: 'not_found', message: 'Entity not found' });
        calls.push({ at: Date.now(), domain: 'entity_registry', service: 'update', data: { entity_id: m.entity_id, disabled_by: m.disabled_by } });
        const was = e.disabled_by;
        if ('disabled_by' in m) e.disabled_by = m.disabled_by;
        reply({ entity_entry: e, ...(was && !e.disabled_by ? { reload_delay: 30 } : {}) });
        fireEvent('entity_registry_updated', { action: 'update', entity_id: m.entity_id, changes: { disabled_by: was } });
        if (was && !e.disabled_by && unifiDisabled.has(m.entity_id)) {
          setTimeout(() => {
            const st = unifiDisabled.get(m.entity_id); unifiDisabled.delete(m.entity_id);
            st.last_changed = st.last_updated = nowIso();
            states.set(m.entity_id, st);
            fireEvent('state_changed', { entity_id: m.entity_id, old_state: null, new_state: publicState(st) });
          }, 1500);
        }
        return;
      }
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
      case 'get_services':
        return reply({
          notify: Object.fromEntries(NOTIFY.map((n) => [n, { name: n }])),
          camera: { snapshot: {}, record: {}, turn_on: {}, turn_off: {} },
          light: { turn_on: {}, turn_off: {}, toggle: {} },
        });
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
        if (domain === 'notify') {
          calls.push({ at: Date.now(), domain, service, data: d });
          if (!NOTIFY.includes(service)) return reply(null, false, { code: 'not_found', message: `Service notify.${service} not found.` });
          return reply({ context: { id: randomUUID() } });
        }
        if (domain === 'camera' && ['snapshot', 'record'].includes(service)) {
          calls.push({ at: Date.now(), domain, service, data: d });
          const st = states.get(d.entity_id);
          if (!st) return reply(null, false, { code: 'not_found', message: `Entity ${d.entity_id} not found` });
          if (!String(d.filename || '').startsWith(MEDIA)) return reply(null, false, { code: 'home_assistant_error', message: `Cannot write \`${d.filename}\`, no access to path; \`allowlist_external_dirs\` may need to be adjusted in \`configuration.yaml\`` });
          // as Home Assistant: a camera it shows as unavailable is quietly skipped
          if (st.state === 'unavailable') return reply({ context: { id: randomUUID() } });
          if (service === 'record' && !(st.attributes.supported_features & 2)) return reply(null, false, { code: 'home_assistant_error', message: `${d.entity_id} does not support record service` });
          const from = service === 'snapshot' ? path.join(PICTURES, cameraPicture[d.entity_id]) : path.join(PICTURES, 'clip.mp4');
          // as Home Assistant: a picture straight away; a clip is written, and the call answered, once it's finished
          setTimeout(() => {
            try { fs.mkdirSync(path.dirname(d.filename), { recursive: true }); fs.copyFileSync(from, d.filename); } catch { /* ignore */ }
            reply({ context: { id: randomUUID() } });
          }, service === 'record' ? (Number(d.duration) || 30) * 1000 : 100);
          return;
        }
        if (['select', 'number', 'siren', 'button'].includes(domain) || (domain === 'switch' && service === 'toggle')) {
          const id = d.entity_id;
          calls.push({ at: Date.now(), domain, service, data: d });
          if (!states.has(id)) return reply(null, false, { code: 'not_found', message: `Entity ${id} not found` });
          const context = { id: randomUUID(), parent_id: null, user_id: 'supervisor' };
          reply({ context });
          const cur = states.get(id).state;
          const next = service === 'select_option' ? d.option : service === 'set_value' ? String(d.value)
            : service === 'press' ? nowIso() : service === 'toggle' ? (cur === 'on' ? 'off' : 'on') : service === 'turn_on' ? 'on' : 'off';
          setTimeout(() => setState(id, { state: next }, context), 150);
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
          out[id] = list.map((r, i) => ({ s: r.s, ...(i % 3 === 0 || r.s === 'on' || /^(climate|weather)\./.test(id) ? { a: r.a } : {}), lu: r.t / 1000 }));
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
  if (req.url === '/sim-log') return done(SIM);
  if (req.url === '/picture') { if (body.mode) pictureMode[body.entity] = body.mode; else delete pictureMode[body.entity]; return done({ ok: true }); }
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
