// Cameras: works with any camera Home Assistant knows about (UniFi Protect, Reolink, Ring, Frigate,
// Tapo, Hikvision, Amcrest, ONVIF, Nest, Blink, generic cameras…). Everything comes from Home
// Assistant's own entities, so there's nothing per make to set up:
//
// - a camera is a camera.* entity; its other entities on the same device are its movement sensors
//   (binary sensors and events: motion, person, vehicle, animal, package, doorbell…) and its
//   controls (switches, selects, numbers, lights, sirens, buttons: privacy, recording mode,
//   detection, infrared, floodlight…), grouped and named in plain words
// - movement can alert chosen phones (with a picture) and save a picture and a clip, each on its
//   own schedule: always, when everyone's out, between set times, either, or never
// - a camera that goes offline for a while is reported, and again when it's back
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zonedParts } from '../lighting/schedule.js';
import { WHEN, defaultCamera } from './store.js';

const MOVEMENT_CLASSES = new Set(['motion', 'occupancy', 'presence', 'moving', 'sound']);
const NOT_MOVEMENT_CLASSES = new Set(['connectivity', 'problem', 'battery', 'battery_charging', 'tamper', 'update', 'running', 'power', 'plug', 'light', 'door', 'opening', 'window', 'lock']);
const MOVEMENT_WORDS = /motion|movement|moving|detect|person|people|human|vehicle|animal|pet\b|package|visitor|doorbell|ding|face|occupan|presence|line ?cross|intrusion|tripwire|loiter/i;
// most specific first: an alert says the most specific thing that was seen
const KINDS = [
  ['visitor', /doorbell|ding|visitor|button ?press|\bring\b|\bpressed\b/i],
  ['person', /person|people|human|face/i],
  ['vehicle', /vehicle|\bcar\b/i],
  ['animal', /animal|\bpet\b|\bdog\b|\bcat\b/i],
  ['package', /package|parcel/i],
  ['sound', /sound|audio|baby|bark|glass ?break|alarm sound|siren detect/i],
];
const KIND_ORDER = ['visitor', 'person', 'vehicle', 'animal', 'package', 'sound', 'movement'];
const KIND_TEXT = {
  visitor: 'Someone at the door', person: 'Person seen', vehicle: 'Vehicle seen', animal: 'Animal seen',
  package: 'Package seen', sound: 'Sound heard', movement: 'Movement',
};

const CONTROL_DOMAINS = new Set(['switch', 'select', 'number', 'light', 'siren', 'button']);
const USEFUL_BUTTONS = /reboot|restart|ptz|preset|siren|alarm|chime|ring|guard|patrol|home ?position|snapshot|wake/i;
export const GROUPS = [
  ['privacy', 'Privacy', /privacy|camera enabled|disable camera|stream(ing)? enabled|^enabled$|^camera$/i],
  ['recording', 'Recording', /record|storage|sd ?card|nvr|clip|ftp|upload|e-?mail|push|notification/i],
  ['detection', 'Detection', /motion|detect|person|vehicle|animal|\bpet\b|face|package|sensitiv|\bai\b|smart|zone|tamper|line|intrusion|trigger|doorbell|visitor/i],
  ['night', 'Night vision and picture', /infrared|\bir\b|night|day ?\/? ?night|hdr|wdr|exposure|black ?and ?white|brightness|contrast|saturation|image|picture|quality|resolution|stream/i],
  ['lights', 'Lights and sound', /flood|spot ?light|light|siren|chime|speaker|volume|\bmic|microphone|audio|sound|led|status|alarm|ring/i],
  ['view', 'Moving the camera', /ptz|\bpan\b|tilt|zoom|preset|rotate|flip|mirror|position|patrol|focus|guard/i],
  ['device', 'Device', /reboot|restart|firmware|update|wake/i],
  ['other', 'Other', /.*/],
];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const TS = Number(process.env.HC_TIME_SCALE) || 1; // tests run minutes as fractions of a second
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'camera';
const MAX_EVENTS = 600;
const LIVE_FOR = 3 * 60000;     // pictures that changed this recently mean the camera is working
const PROBE_EVERY = 60000;      // how often to look at the pictures of a camera Home Assistant says is down

export class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

export class Engine extends EventEmitter {
  constructor({ ha, store, log, house, mediaDir, haMediaDir, panel, picture }) {
    super();
    this.ha = ha;
    this.store = store;
    this.data = store.data;
    this.log = log;
    this.house = house;
    this.mediaDir = mediaDir;      // where this app sees recordings
    this.haMediaDir = haMediaDir;  // the same folder as Home Assistant sees it
    this.panel = panel || (() => null);
    this.fetchPicture = picture || null; // (entity, width) => { status, buf } from Home Assistant's camera proxy
    this.pics = new Map();         // camera id -> { hash, at, liveAt, busy } while Home Assistant says it's down
    this.states = new Map();
    this.reg = { entities: new Map(), devices: new Map() };
    this.tz = 'UTC';
    this.ready = false;
    this.disabled = false;
    this.pending = new Map();      // camera id -> { kinds:Set, sensors:Set, timer } while movement is collected
    this.busyUntil = new Map();    // camera id -> time its clip finishes
    this.lastAlert = new Map();    // camera id -> time of its last movement alert
    this.offline = new Map();      // camera id -> { since, alerted }
    this.recordWarned = new Map(); // camera id -> time we last said recording failed
    this.rel = new Map();          // camera id -> its other entities (from the registries)
    this.byEntity = new Map();     // entity -> ids of the cameras it belongs to
  }

  start() {
    this.ha.on('ready', () => this._onReady().catch((err) => this.log.warn?.(`Cameras: ${err.message}`)));
    this.ha.on('state_changed', (d) => this._onState(d));
    this.ha.on('disconnected', () => { this.ready = false; this.changed(); });
    this.timer = setInterval(() => this._checkOffline(), Math.max(200, 30000 * TS));
    this.probeTimer = setInterval(() => this._probeAll(), Math.max(100, 15000 * TS));
    this.cleanTimer = setInterval(() => this.cleanUp(), 3600000);
    setTimeout(() => this.cleanUp(), 60000);
  }

  stop() { clearInterval(this.timer); clearInterval(this.probeTimer); clearInterval(this.cleanTimer); this.store.flush(); }

  changed() { this.emit('change'); }

  /** Home Assistant renamed an entity's ID: a camera (its movement sensors, its card controls) follows it. */
  /** Every entity ID the cameras use (so a renamed one can be followed, see renames.js). */
  entityIds() {
    return this.data.cameras.flatMap((c) => [c.entity, ...(Array.isArray(c.movement) ? c.movement : []), ...(Array.isArray(c.card) ? c.card : [])]).filter(Boolean);
  }

  renameEntity(from, to) {
    let hit = null;
    for (const cam of this.data.cameras) {
      let c = false;
      if (cam.entity === from) { cam.entity = to; c = true; }
      if (Array.isArray(cam.movement) && cam.movement.includes(from)) { cam.movement = cam.movement.map((e) => (e === from ? to : e)); c = true; }
      if (Array.isArray(cam.card) && cam.card.includes(from)) { cam.card = cam.card.map((e) => (e === from ? to : e)); c = true; }
      if (c) hit = cam;
    }
    if (!hit) return false;
    this.store.save();
    this.addEvent(hit, 'note', `Home Assistant renamed ${from} to ${to}: ${hit.name} follows it.`);
    this.loadRegistries().then(() => this.changed()).catch(() => this.changed());
    return true;
  }

  async _onReady() {
    const [config, states] = await Promise.all([this.ha.getConfig(), this.ha.getStates()]);
    this.tz = config?.time_zone || 'UTC';
    this.states = new Map(states.map((s) => [s.entity_id, s]));
    await this.ha.subscribeStateChanged();
    await this.loadRegistries();
    this.ready = true;
    for (const cam of this.data.cameras) this._trackOnline(cam, Date.now(), true);
    this.changed();
    clearInterval(this.regTimer);
    this.regTimer = setInterval(() => this.loadRegistries().then(() => this.changed()).catch(() => {}), 10 * 60000);
  }

  async loadRegistries() {
    const { entities, devices } = await this.ha.registries();
    this.reg.entities = new Map((entities || []).map((e) => [e.entity_id, e]));
    this.reg.devices = new Map((devices || []).map((d) => [d.id, d]));
    this.reindex();
  }

  /** Which entities belong to which camera, worked out once rather than on every state change. */
  reindex() {
    this.rel = new Map();
    this.byEntity = new Map();
    for (const cam of this.data.cameras) {
      const rel = this._related(cam.entity);
      this.rel.set(cam.id, rel);
      for (const id of [cam.entity, ...rel.map((r) => r.entity_id)]) {
        if (!this.byEntity.has(id)) this.byEntity.set(id, new Set());
        this.byEntity.get(id).add(cam.id);
      }
    }
  }

  // ---------- what Home Assistant has ----------

  friendly(id) { return this.states.get(id)?.attributes?.friendly_name || this.lastName?.(id) || id; }

  deviceOf(entity) {
    const e = this.reg.entities.get(entity);
    return e?.device_id ? this.reg.devices.get(e.device_id) || null : null;
  }

  related(entity) {
    const cam = this.data.cameras.find((c) => c.entity === entity);
    return (cam && this.rel.get(cam.id)) || this._related(entity);
  }

  /** Everything on the same device as this camera (or, without a device, sharing its name). */
  _related(entity) {
    const e = this.reg.entities.get(entity);
    const dev = e?.device_id;
    const out = [];
    if (dev) {
      for (const r of this.reg.entities.values()) {
        if (r.device_id === dev && r.entity_id !== entity && !r.disabled_by && this.states.has(r.entity_id)) out.push(r);
      }
    } else {
      const base = entity.split('.')[1];
      for (const id of this.states.keys()) {
        if (id !== entity && id.split('.')[1].startsWith(base)) out.push(this.reg.entities.get(id) || { entity_id: id });
      }
    }
    return out;
  }

  /** "Front door Privacy mode" on the Front door camera reads "Privacy mode". */
  shortName(id, deviceName) {
    const full = this.friendly(id);
    const d = String(deviceName || '').trim();
    if (d && full.toLowerCase().startsWith(d.toLowerCase()) && full.length > d.length + 1) {
      const rest = full.slice(d.length).trim();
      return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
    return full;
  }

  kindOf(id, deviceClass, name) {
    const text = `${id} ${name || ''}`;
    for (const [k, re] of KINDS) if (re.test(text)) return k;
    if (deviceClass === 'sound') return 'sound';
    return 'movement';
  }

  movementSensors(cam) {
    const dev = this.deviceOf(cam.entity);
    const devName = dev?.name_by_user || dev?.name || this.friendly(cam.entity);
    return this.related(cam.entity).filter((r) => {
      const domain = r.entity_id.split('.')[0];
      if (domain === 'event') return MOVEMENT_WORDS.test(`${r.entity_id} ${this.friendly(r.entity_id)}`);
      if (domain !== 'binary_sensor') return false;
      const dc = this.states.get(r.entity_id)?.attributes?.device_class || r.original_device_class || r.device_class;
      if (NOT_MOVEMENT_CLASSES.has(dc)) return false;
      return MOVEMENT_CLASSES.has(dc) || MOVEMENT_WORDS.test(`${r.entity_id} ${this.friendly(r.entity_id)}`);
    }).map((r) => {
      const dc = this.states.get(r.entity_id)?.attributes?.device_class || r.original_device_class;
      const name = this.shortName(r.entity_id, devName);
      return { id: r.entity_id, name, kind: this.kindOf(r.entity_id, dc, name), event: r.entity_id.startsWith('event.') };
    });
  }

  controls(cam) {
    const dev = this.deviceOf(cam.entity);
    const devName = dev?.name_by_user || dev?.name || this.friendly(cam.entity);
    return this.related(cam.entity).filter((r) => {
      const domain = r.entity_id.split('.')[0];
      if (!CONTROL_DOMAINS.has(domain)) return false;
      if (r.entity_category === 'diagnostic' && !(domain === 'button' && USEFUL_BUTTONS.test(r.entity_id))) return false;
      if (domain === 'button' && !USEFUL_BUTTONS.test(`${r.entity_id} ${this.friendly(r.entity_id)}`)) return false;
      return true;
    }).map((r) => {
      const st = this.states.get(r.entity_id);
      const a = st?.attributes || {};
      const domain = r.entity_id.split('.')[0];
      const name = this.shortName(r.entity_id, devName);
      const group = GROUPS.find(([, , re]) => re.test(`${name} ${r.entity_id.split('.')[1]}`))[0];
      return {
        id: r.entity_id, domain, name, group,
        state: st?.state ?? 'unavailable',
        available: !!st && st.state !== 'unavailable',
        ...(domain === 'select' ? { options: a.options || [] } : {}),
        ...(domain === 'number' ? { min: a.min ?? 0, max: a.max ?? 100, step: a.step ?? 1, unit: a.unit_of_measurement || '' } : {}),
        ...(domain === 'light' && st?.state === 'on' && a.brightness != null ? { brightness: Math.round((a.brightness / 255) * 100) } : {}),
      };
    }).sort((x, y) => GROUPS.findIndex((g) => g[0] === x.group) - GROUPS.findIndex((g) => g[0] === y.group) || x.name.localeCompare(y.name));
  }

  /** The camera's own "connected" sensor (Amcrest, Axis, Hikvision, Netatmo…). Only one from the
   *  camera's own integration counts: Home Assistant puts other integrations' entities for the same
   *  device (a network tracker, say) on the same device, and those can disagree with the camera. */
  connectivity(cam) {
    const platform = this.reg.entities.get(cam.entity)?.platform;
    return this.related(cam.entity).find((r) => r.entity_id.startsWith('binary_sensor.')
      && (!platform || !r.platform || r.platform === platform)
      && (this.states.get(r.entity_id)?.attributes?.device_class || r.original_device_class) === 'connectivity')?.entity_id || null;
  }

  /** What Home Assistant says is wrong with the camera (null when nothing is), in words for the page. */
  haReason(cam) {
    const st = this.states.get(cam.entity);
    if (!st) return { entity: cam.entity, missing: true, text: `Home Assistant doesn't have ${cam.entity} any more (renamed or removed?)` };
    if (st.state === 'unavailable') return { entity: cam.entity, text: `Home Assistant shows the camera (${cam.entity}) as unavailable` };
    const conn = this.connectivity(cam);
    const cs = conn && this.states.get(conn);
    if (cs?.state === 'off') {
      const dev = this.deviceOf(cam.entity);
      return { entity: conn, text: `"${this.shortName(conn, dev?.name_by_user || dev?.name)}" (${conn}) says it's disconnected` };
    }
    return null;
  }

  /** Pictures that keep changing mean the camera is working, whatever Home Assistant shows: some
   *  integrations mark a working camera unavailable (UniFi Protect can). The same picture over and
   *  over is a saved one, which some cloud cameras hand out while they're offline, so doesn't count. */
  picturesLive(cam, ms = Date.now()) {
    const p = this.pics.get(cam.id);
    return !!p?.liveAt && ms - p.liveAt < LIVE_FOR * TS;
  }

  /** Why a camera counts as offline (null when it's online). */
  offlineReason(cam) {
    const why = this.haReason(cam);
    if (!why) return null;
    if (!why.missing && this.picturesLive(cam)) return null;
    return why;
  }

  isOnline(cam) { return !this.offlineReason(cam); }

  async _probe(cam) {
    if (!this.fetchPicture) return;
    const p = this.pics.get(cam.id) || {};
    this.pics.set(cam.id, p);
    if (p.busy) return;
    p.busy = true;
    try {
      const pic = await this.fetchPicture(cam.entity, 320);
      if (pic?.buf?.length) {
        const hash = createHash('sha1').update(pic.buf).digest('hex');
        if (p.hash && p.hash !== hash) p.liveAt = Date.now();
        p.hash = hash;
      }
    } catch { /* no picture */ } finally { p.busy = false; p.at = Date.now(); p.n = (p.n || 0) + 1; }
    if (this.data.cameras.includes(cam)) this._recheck(cam);
  }

  /** Home Assistant has just said a camera's down: look at its pictures twice, a few seconds apart. */
  _checkPictures(cam) {
    const p = this.pics.get(cam.id);
    if (!this.fetchPicture || (p && (p.busy || Date.now() - (p.at || 0) < 10000 * TS))) return;
    this._probe(cam).then(() => setTimeout(() => this._probe(cam).catch(() => {}), 4000 * TS)).catch(() => {});
  }

  _probeAll(ms = Date.now()) {
    if (!this.ready || this.disabled) return;
    for (const cam of this.data.cameras) {
      const why = this.haReason(cam);
      if (!why || why.missing) { this.pics.delete(cam.id); continue; }
      const p = this.pics.get(cam.id);
      if (!p || (!p.busy && ms - (p.at || 0) >= PROBE_EVERY * TS)) this._probe(cam).catch(() => {});
      else this._recheck(cam, ms); // pictures that have stopped changing
    }
  }

  _recheck(cam, ms = Date.now()) {
    const was = this.offline.has(cam.id);
    this._trackOnline(cam, ms);
    if (was !== this.offline.has(cam.id)) this.changed();
  }

  makeOf(entity) {
    const dev = this.deviceOf(entity);
    const platform = this.reg.entities.get(entity)?.platform;
    const pretty = { unifiprotect: 'UniFi Protect', reolink: 'Reolink', ring: 'Ring', frigate: 'Frigate', onvif: 'ONVIF', nest: 'Google Nest', blink: 'Blink', tapo_control: 'Tapo', tapo: 'Tapo', hikvision: 'Hikvision', amcrest: 'Amcrest', generic: 'Generic camera', synology_dsm: 'Synology', eufy_security: 'eufy', arlo: 'Arlo', aarlo: 'Arlo', yi: 'Yi', dahua: 'Dahua', axis: 'Axis', ezviz: 'EZVIZ', tplink: 'TP-Link', xiaomi_miot: 'Xiaomi', go2rtc: 'go2rtc', mjpeg: 'MJPEG camera' };
    return { make: dev?.manufacturer || pretty[platform] || platform || '', model: dev?.model || '', integration: pretty[platform] || platform || '' };
  }

  // ---------- adding and setting up cameras ----------

  candidates() {
    const have = new Set(this.data.cameras.map((c) => c.entity));
    return [...this.states.values()]
      .filter((s) => s.entity_id.startsWith('camera.') && !have.has(s.entity_id) && !this.reg.entities.get(s.entity_id)?.disabled_by)
      .map((s) => ({ entity: s.entity_id, name: this.cleanName(s.entity_id), ...this.makeOf(s.entity_id), online: s.state !== 'unavailable' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A camera's name without stream words: "Front door High resolution channel" reads "Front door". */
  cleanName(entity) {
    const dev = this.deviceOf(entity);
    const n = dev?.name_by_user || dev?.name || this.friendly(entity);
    return String(n).replace(/\s+(high|medium|low)( resolution)?( channel)?$|\s+(fluent|clear|main|sub) ?(stream)?$|\s+live view$|\s+snapshots?$/i, '').trim() || n;
  }

  addCamera(entity) {
    if (!/^camera\.[\w]+$/.test(entity || '') || !this.states.has(entity)) throw new UserError('That camera isn\'t in Home Assistant');
    if (this.data.cameras.some((c) => c.entity === entity)) throw new UserError('That camera is already here');
    const cam = defaultCamera(entity, this.cleanName(entity));
    let id = slug(cam.name); let n = 2;
    while (this.data.cameras.some((c) => c.id === id)) id = `${slug(cam.name)}_${n++}`;
    cam.id = id;
    this.data.cameras.push(cam);
    this.reindex();
    this.addEvent(cam, 'note', `${cam.name} added.`);
    this._trackOnline(cam, Date.now(), true, true);
    this.store.save();
    this.changed();
    return cam;
  }

  updateCamera(id, input) {
    const cam = this.camera(id);
    if (typeof input.name === 'string') {
      const name = input.name.trim().slice(0, 40);
      if (!name) throw new UserError('Give the camera a name');
      cam.name = name;
    }
    if ('movement' in input) {
      const all = this.movementSensors(cam).map((m) => m.id);
      cam.movement = input.movement == null ? null : (Array.isArray(input.movement) ? input.movement.filter((x) => all.includes(x)) : cam.movement);
    }
    const sched = (cur, v, extra) => {
      if (!v || typeof v !== 'object') return cur;
      const time = (t, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(t || '') ? t : d);
      return {
        ...cur,
        when: WHEN.includes(v.when) ? v.when : cur.when,
        from: time(v.from, cur.from),
        to: time(v.to, cur.to),
        ...extra(v),
      };
    };
    if (input.alerts) cam.alerts = sched(cam.alerts, input.alerts, (v) => ({
      on: typeof v.on === 'boolean' ? v.on : cam.alerts.on,
      cooldownMinutes: v.cooldownMinutes != null ? clamp(Math.round(Number(v.cooldownMinutes) || 0), 0, 120) : cam.alerts.cooldownMinutes,
    }));
    if (input.record) cam.record = sched(cam.record, input.record, (v) => ({
      seconds: v.seconds != null ? clamp(Math.round(Number(v.seconds) || 30), 5, 300) : cam.record.seconds,
    }));
    if (typeof input.offline === 'boolean') cam.offline = input.offline;
    if (Array.isArray(input.card)) {
      const ids = this.controls(cam).map((c) => c.id);
      cam.card = input.card.filter((x) => ids.includes(x)).slice(0, 4);
    }
    this.store.save();
    this.changed();
    return cam;
  }

  removeCamera(id) {
    const cam = this.camera(id);
    this.data.cameras = this.data.cameras.filter((c) => c !== cam);
    this.store.data.cameras = this.data.cameras;
    this.offline.delete(id);
    this.pics.delete(id);
    if (this.data.toldOffline) delete this.data.toldOffline[id];
    this.reindex();
    this.store.save();
    this.changed();
  }

  reorder(ids) {
    const byId = new Map(this.data.cameras.map((c) => [c.id, c]));
    const next = ids.map((i) => byId.get(i)).filter(Boolean);
    for (const c of this.data.cameras) if (!next.includes(c)) next.push(c);
    this.data.cameras.splice(0, this.data.cameras.length, ...next);
    this.store.save();
    this.changed();
  }

  updateSettings(input) {
    const s = this.data.settings;
    if (Array.isArray(input.notify)) s.notify = [...new Set(input.notify.filter((x) => /^notify\.\w+$/.test(x)))];
    if (typeof input.picture === 'boolean') s.picture = input.picture;
    if (input.offlineMinutes != null) s.offlineMinutes = clamp(Math.round(Number(input.offlineMinutes) || 0), 0, 240);
    if (input.keepDays != null) s.keepDays = clamp(Math.round(Number(input.keepDays) || 14), 1, 365);
    this.store.save();
    this.changed();
  }

  camera(id) {
    const cam = this.data.cameras.find((c) => c.id === id);
    if (!cam) throw new UserError('That camera isn\'t here any more', 404);
    return cam;
  }

  /** Switch, choose or set one of a camera's own controls, as the app (Home Assistant logs it as such). */
  async control(id, entity, { value } = {}) {
    if (this.disabled) throw new UserError('Cameras are turned off in Home Control\'s settings.', 409);
    const cam = this.camera(id);
    const c = this.controls(cam).find((x) => x.id === entity);
    if (!c) throw new UserError('That control doesn\'t belong to this camera');
    if (!c.available) throw new UserError(`${c.name} isn't available right now`);
    const call = (domain, service, data = {}) => this.ha.callService(domain, service, { entity_id: entity, ...data });
    switch (c.domain) {
      case 'switch': case 'light': case 'siren':
        await call(c.domain, value === undefined ? 'toggle' : value ? 'turn_on' : 'turn_off');
        break;
      case 'select':
        if (!c.options.includes(value)) throw new UserError('That isn\'t one of the choices');
        await call('select', 'select_option', { option: value });
        break;
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new UserError('That isn\'t a number');
        await call('number', 'set_value', { value: clamp(n, c.min, c.max) });
        break;
      }
      case 'button':
        await call('button', 'press');
        break;
      default: throw new UserError('That can\'t be changed from here');
    }
  }

  // ---------- schedules ----------

  minutesNow(ms) { return zonedParts(ms, this.tz).minutes; }

  inTimes(sched, ms) {
    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
    const now = this.minutesNow(ms);
    const a = toMin(sched.from); const b = toMin(sched.to);
    return a <= b ? now >= a && now < b : now >= a || now < b;
  }

  activeNow(sched, ms = Date.now()) {
    const away = !!this.house?.isAway?.();
    switch (sched.when) {
      case 'always': return true;
      case 'away': return away;
      case 'times': return this.inTimes(sched, ms);
      case 'away_or_times': return away || this.inTimes(sched, ms);
      default: return false;
    }
  }

  alertsNow(cam, ms) { return !!cam.alerts.on && this.activeNow(cam.alerts, ms); }

  // ---------- movement ----------

  _onState({ entity_id: id, new_state: ns, old_state: os } = {}) {
    if (!id) return;
    if (ns) this.states.set(id, ns); else this.states.delete(id);
    if (!this.ready) return;
    // a new entity (an integration starting up): it may belong to a camera
    if (ns && !os && this.reg.entities.get(id)?.device_id) { clearTimeout(this.reindexTimer); this.reindexTimer = setTimeout(() => { this.reindex(); this.changed(); }, 2000); }
    const ids = this.byEntity.get(id);
    if (!ids) return;
    const ms = Date.now();
    for (const cam of this.data.cameras.filter((c) => ids.has(c.id))) {
      if (id === cam.entity || id === this.connectivity(cam)) { this._trackOnline(cam, ms); this.changed(); continue; }
      if (this.disabled) continue;
      const sensor = this.movementSensors(cam).find((m) => m.id === id);
      if (!sensor) continue;
      const counted = cam.movement == null || cam.movement.includes(id);
      const fired = sensor.event
        ? ns && os && ns.state !== os.state && !['unavailable', 'unknown'].includes(ns.state)
        : ns?.state === 'on' && os?.state !== 'on' && os?.state !== 'unavailable';
      if (fired && counted) this._movement(cam, sensor, ms);
      this.changed();
    }
  }

  /** Sensors on one camera often fire together (motion, then person): gather them for a moment, then act once. */
  _movement(cam, sensor, ms) {
    let p = this.pending.get(cam.id);
    if (!p) {
      p = { at: ms, kinds: new Set(), sensors: new Set() };
      p.timer = setTimeout(() => { this.pending.delete(cam.id); this._act(cam, p).catch((err) => this.log.warn?.(`Cameras: ${err.message}`)); }, 1500);
      this.pending.set(cam.id, p);
    }
    p.kinds.add(sensor.kind);
    p.sensors.add(sensor.name);
  }

  async _act(cam, p) {
    if (this.disabled || !this.data.cameras.includes(cam)) return;
    const ms = p.at;
    const kind = KIND_ORDER.find((k) => p.kinds.has(k)) || 'movement';
    // "Movement (Driveway zone)", but not "Movement (Motion)"
    const only = p.sensors.size === 1 ? [...p.sensors][0] : null;
    const text = `${KIND_TEXT[kind]}${kind === 'movement' && only && !/^(motion|movement|moving)( detected)?$/i.test(only) ? ` (${only})` : ''}`;
    const ev = this.addEvent(cam, 'movement', text, { kind, at: ms });

    // a picture and a clip, in the background: Home Assistant answers once the clip is finished
    let recording = null;
    if (this.activeNow(cam.record, ms) && (this.busyUntil.get(cam.id) || 0) < ms) recording = this._record(cam, ev, ms);
    else if ((this.busyUntil.get(cam.id) || 0) >= ms) ev.clip = this.busyClip?.get(cam.id) || null;

    // phones
    const last = this.lastAlert.get(cam.id) || 0;
    const cool = (cam.alerts.cooldownMinutes ?? 2) * 60000 * TS;
    if (this.alertsNow(cam, ms) && ms - last >= cool && this.data.settings.notify.length) {
      this.lastAlert.set(cam.id, ms);
      ev.alerted = true;
      await this.notify(cam, `${KIND_TEXT[kind]} at ${this.clock(ms)}`, { picture: this.data.settings.picture });
    }
    this.store.save();
    this.changed();
    if (recording) await recording.then(() => { this.store.save(); this.changed(); });
  }

  /** "07:16" today, "Sun 11 Oct, 07:16" before that. */
  sinceText(at, ms = Date.now()) {
    const day = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, dateStyle: 'short' }).format(new Date(t));
    if (day(at) === day(ms)) return this.clock(at);
    const d = new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(at)).replace(',', '');
    return `${d}, ${this.clock(at)}`;
  }

  clock(ms) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  }

  stamp(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`;
  }

  async _record(cam, ev, ms) {
    const dir = path.join(this.mediaDir, 'home_control', cam.id);
    const haDir = path.posix.join(this.haMediaDir, 'home_control', cam.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
      this._recordFailed(cam, `the recordings folder can't be written (${err.message})`, ms);
      return;
    }
    const name = this.stamp(ms);
    const seconds = cam.record.seconds || 30;
    this.busyUntil.set(cam.id, ms + (seconds + 10) * 1000);
    (this.busyClip ||= new Map()).set(cam.id, `${name}.mp4`);
    ev.picture = `${name}.jpg`;
    ev.clip = `${name}.mp4`;
    if (this.states.get(cam.entity)?.state === 'unavailable') {
      // Home Assistant quietly skips a camera it shows as unavailable, so save its picture from here
      ev.clip = null;
      this.busyUntil.delete(cam.id);
      try {
        const pic = this.fetchPicture && await this.fetchPicture(cam.entity, null);
        if (!pic?.buf?.length) throw new Error(`Home Assistant gave no picture (${pic?.status ?? 'no answer'})`);
        fs.writeFileSync(path.join(dir, ev.picture), pic.buf);
      } catch (err) { ev.picture = null; this._recordFailed(cam, `no picture: ${err.message}`, ms); }
      this._recordFailed(cam, `no clip: Home Assistant shows the camera (${cam.entity}) as unavailable, so it won't record from it`, ms);
      return;
    }
    const picture = this.ha.callService('camera', 'snapshot', { entity_id: cam.entity, filename: `${haDir}/${name}.jpg` })
      .catch((err) => { ev.picture = null; this._recordFailed(cam, `no picture: ${err.message}`, ms); });
    // the call lasts as long as the clip, so allow for that
    const clip = this.ha.send('call_service', { domain: 'camera', service: 'record', service_data: { entity_id: cam.entity, filename: `${haDir}/${name}.mp4`, duration: seconds, lookback: 5 } }, (seconds + 90) * 1000)
      .catch((err) => { ev.clip = null; this.busyUntil.delete(cam.id); this._recordFailed(cam, `no clip: ${err.message}`, ms); });
    await Promise.all([picture, clip]);
  }

  _recordFailed(cam, why, ms) {
    const last = this.recordWarned.get(cam.id) || 0;
    if (ms - last < 3600000) return; // say so once an hour at most
    this.recordWarned.set(cam.id, ms);
    const hint = /allowlist|no access to path/i.test(why) ? ' Home Assistant isn\'t allowed to save there: add the media folder to allowlist_external_dirs.'
      : /does not support (record|play stream)/i.test(why) ? ' This camera doesn\'t give Home Assistant a video stream it can save, so only pictures are kept.'
        : /as unavailable/.test(why) ? ' Pictures are still saved. Reloading the camera\'s integration in Home Assistant (Settings → Devices & services) usually puts this right.' : '';
    this.addEvent(cam, 'note', `Couldn't save ${why.startsWith('no picture') ? 'a picture' : 'a clip'} from ${cam.name}: ${why.replace(/^no (picture|clip): /, '')}.${hint}`);
  }

  /** Tell the chosen phones. With the Home Assistant app, a picture from the camera comes with it. */
  async notify(cam, message, { picture = false, title = null } = {}) {
    const open = this.panel() ? `${this.panel()}?section=cameras` : null;
    const data = {
      tag: `home-control-${cam.id}`,
      group: 'home-control-cameras',
      ...(open ? { url: open, clickAction: open } : {}),
      ...(picture ? { image: `/api/camera_proxy/${cam.entity}`, entity_id: cam.entity } : {}),
    };
    const results = await Promise.allSettled(this.data.settings.notify.map((svc) => this.ha.callService('notify', svc.replace(/^notify\./, ''), { title: title || cam.name, message, data })));
    const failed = results.map((r, i) => (r.status === 'rejected' ? `${this.data.settings.notify[i]} (${r.reason?.message})` : null)).filter(Boolean);
    if (failed.length) this.addEvent(cam, 'note', `Couldn't alert ${failed.join(', ')}.`);
    return results.length - failed.length;
  }

  async testAlert() {
    if (!this.data.settings.notify.length) throw new UserError('Choose a phone to alert first');
    const cam = this.data.cameras[0] || { id: 'test', name: 'Home Control', entity: null };
    const sent = await this.notify(cam.entity ? cam : { ...cam, entity: 'camera.none' }, `Test alert. This is how camera alerts will look${cam.entity ? ', with a picture' : ''}.`, { picture: !!cam.entity && this.data.settings.picture, title: cam.entity ? cam.name : 'Home Control' });
    if (!sent) throw new UserError('The alert couldn\'t be sent. Check the phone has the Home Assistant app signed in.');
    return sent;
  }

  // ---------- offline ----------

  /** quiet: starting up or just added, so offline since whenever the entity behind it last changed.
   *  added: offline when it was added, so the phones aren't told (the page shows it). */
  _trackOnline(cam, ms, quiet = false, added = false) {
    const why = this.offlineReason(cam);
    const online = !why;
    if (why && !why.missing && !this.disabled) this._checkPictures(cam);
    const o = this.offline.get(cam.id);
    // kept over restarts, so phones are told once: when they were told, or 'added' for one added while offline
    const told = this.data.toldOffline || (this.data.toldOffline = {});
    if (!online && !o) {
      if (added) { told[cam.id] = 'added'; this.store.save(); }
      this.offline.set(cam.id, { since: quiet ? (Date.parse(this.states.get(why.entity)?.last_changed) || ms) : ms, alerted: !!told[cam.id], told: typeof told[cam.id] === 'number' });
    }
    if (online && o) {
      this.offline.delete(cam.id);
      if (told[cam.id]) { delete told[cam.id]; this.store.save(); }
      if (o.told && !this.disabled) {
        const mins = Math.round((ms - o.since) / 60000);
        const took = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${Math.round(mins / 1440)} days`;
        this.addEvent(cam, 'online', `${cam.name} is back online after ${took}.`);
        if (cam.offline) this.notify(cam, `Back online at ${this.clock(ms)}.`).catch(() => {});
      }
    }
  }

  _checkOffline(ms = Date.now()) {
    if (!this.ready || this.disabled) return;
    const after = (this.data.settings.offlineMinutes || 0) * 60000 * TS;
    if (!after) return;
    for (const cam of this.data.cameras) {
      const o = this.offline.get(cam.id);
      if (!o || o.alerted || ms - o.since < after) continue;
      // Home Assistant says it's down: wait until its pictures have been looked at twice
      const p = this.pics.get(cam.id);
      if (this.fetchPicture && !this.haReason(cam)?.missing && (p?.n || 0) < 2) continue;
      o.alerted = true;
      o.told = true;
      (this.data.toldOffline ||= {})[cam.id] = o.since;
      this.addEvent(cam, 'offline', `${cam.name} has been offline since ${this.sinceText(o.since, ms)}.`);
      if (cam.offline) this.notify(cam, `Offline since ${this.sinceText(o.since, ms)}.`).catch(() => {});
      this.store.save();
      this.changed();
    }
  }

  // ---------- Activity, recordings ----------

  addEvent(cam, type, text, extra = {}) {
    const ev = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), camera: cam?.id || null, type, text, ...extra };
    this.data.events.unshift(ev);
    if (this.data.events.length > MAX_EVENTS) this.data.events.length = MAX_EVENTS;
    this.store.save();
    return ev;
  }

  recordingPath(id, file) {
    if (!/^[\w-]+$/.test(id) || !/^[\w.-]+\.(mp4|jpg)$/.test(file)) return null;
    return path.join(this.mediaDir, 'home_control', id, file);
  }

  /** Recordings and pictures older than the setting are deleted, and so are their Activity entries' links. */
  cleanUp(ms = Date.now()) {
    const cutoff = ms - (this.data.settings.keepDays || 14) * 86400000;
    const root = path.join(this.mediaDir, 'home_control');
    let removed = 0;
    try {
      for (const dir of fs.readdirSync(root)) {
        const full = path.join(root, dir);
        let files = [];
        try { files = fs.readdirSync(full); } catch { continue; }
        for (const f of files) {
          const p = path.join(full, f);
          try { if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p); removed++; } } catch { /* gone */ }
        }
      }
    } catch { /* no recordings yet */ }
    const before = this.data.events.length;
    this.data.events = this.data.events.filter((e) => e.at >= cutoff || e.type === 'note');
    this.store.data.events = this.data.events;
    if (removed || before !== this.data.events.length) { this.store.save(); this.changed(); }
    return removed;
  }

  // ---------- for the page and the dashboard ----------

  cameraView(cam, ms = Date.now()) {
    const st = this.states.get(cam.entity);
    const sensors = this.movementSensors(cam);
    const used = sensors.filter((m) => cam.movement == null || cam.movement.includes(m.id));
    const lastEv = this.data.events.find((e) => e.camera === cam.id && e.type === 'movement');
    const o = this.offline.get(cam.id);
    const why = this.offlineReason(cam);
    const ha = this.haReason(cam);
    return {
      id: cam.id, entity: cam.entity, name: cam.name, ...this.makeOf(cam.entity),
      online: !why,
      offlineSince: o?.since || null,
      offlineWhy: why?.text || null,
      haSays: !why && ha ? ha.text : null, // Home Assistant says it's down, but its pictures are coming through
      state: st?.state || 'unavailable',
      movingNow: used.some((m) => !m.event && this.states.get(m.id)?.state === 'on'),
      lastMovement: lastEv ? { at: lastEv.at, text: lastEv.text, kind: lastEv.kind } : null,
      alerts: cam.alerts, record: cam.record, offline: cam.offline, card: cam.card,
      alertsNow: !this.disabled && this.alertsNow(cam, ms),
      recordNow: !this.disabled && this.activeNow(cam.record, ms),
      movement: sensors.map((m) => ({ ...m, used: cam.movement == null || cam.movement.includes(m.id), on: !m.event && this.states.get(m.id)?.state === 'on' })),
      movementAll: cam.movement == null,
      controls: this.controls(cam),
      hasStream: !!((st?.attributes?.supported_features ?? 0) & 2),
    };
  }

  snapshot() {
    const ms = Date.now();
    return {
      connected: this.ha.connected && this.ready,
      disabled: this.disabled,
      away: !!this.house?.isAway?.(),
      timeZone: this.tz,
      cameras: this.data.cameras.map((c) => this.cameraView(c, ms)),
      candidates: this.ready ? this.candidates() : [],
      settings: this.data.settings,
      groups: GROUPS.map(([id, name]) => ({ id, name })),
    };
  }

  events({ camera = null, before = Infinity, limit = 60 } = {}) {
    const list = this.data.events.filter((e) => e.at < before && (!camera || e.camera === camera)).slice(0, limit);
    return list.map((e) => ({
      ...e,
      picture: e.picture && this.recordingPath(e.camera, e.picture) && fs.existsSync(this.recordingPath(e.camera, e.picture)) ? e.picture : null,
      clip: e.clip && this.recordingPath(e.camera, e.clip) && fs.existsSync(this.recordingPath(e.camera, e.clip)) ? e.clip : null,
    }));
  }
}
