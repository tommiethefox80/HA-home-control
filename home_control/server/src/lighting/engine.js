// Control logic: works out what every group of lights and sockets should be doing,
// tells Home Assistant only when a device differs, and notices changes made elsewhere.
import { EventEmitter } from 'node:events';
import {
  stateAt, nextChange, daySegments, localDate, zonedParts, startOfWeek, livedInWeek,
  normalizeWeek, weekIsEmpty, minutesToTime, timeToMinutes, dateKey, sunTimes, describeWhen, turnOnPoint,
  inSeason, normalizeSeason, describeMonthDay, inTimeWindow, morningChange, nextLocalTime,
} from './schedule.js';
import { DEFAULT_SETTINGS } from './store.js';

const TICK_MS = 15000;
// "All off" is a one-press action, not a mode: everything off until each group's next scheduled change.
const ALL_OFF = { id: 'all-off', name: 'All off', until: 'next', others: 'off', groups: {} };
const ALL_OFF_NAMES = ['all-off', 'all off', 'all_off', 'alloff', 'off'];
const FADE_OFF_MIN = 3;     // seconds: shorter fades to off are just switched off
// A light that comes back on by itself within this long of being switched off, with nobody behind it
// (no one in Home Assistant, no automation), is the light misbehaving: some Zigbee bulbs come back on
// at full brightness a good few seconds after being switched off, and only report it late.
const BOUNCE_MS = 60000;
// After a command, ask Home Assistant to read the light's real state back from the device. After an
// off, keep checking for a minute, to catch a bulb that comes back on later without saying so.
const READ_BACK_ON = [4000];
const READ_BACK_OFF = [4000, 20000, 50000];
const VERIFY_WINDOW_MS = 5000;
// Integrations where Home Assistant can read a device's real state on request. Zigbee bulbs often
// don't report changes they make themselves, so Home Assistant can believe "off" while it's on.
const READ_BACK = new Set(['zha', 'deconz', 'zwave_js']);
const SEND_GAP_MS = 400;
const MAX_TRIES = 3;
const ACTIVITY_MAX = 300;
const TARGET_KEEP_MS = 2 * 86400000;
const DEVICE_DOMAINS = ['light', 'switch'];
const COLOR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isDevice = (id) => typeof id === 'string' && DEVICE_DOMAINS.includes(id.split('.')[0]) && /^[a-z_]+\.[a-z0-9_]+$/.test(id);

/** Holds where the app sends nothing: a person's change, or "leave it as it is" after a schedule edit. */
function handsOff(ov) { return !!ov && (ov.type === 'manual' || ov.type === 'leave'); }

function slug(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'group';
}

function levelOf(l) {
  if (!l || !l.on) return 0;
  return l.brightness ?? 100;
}

export class Engine extends EventEmitter {
  constructor({ ha, store, log = console, now = () => Date.now() }) {
    super();
    this.ha = ha;
    this.store = store;
    this.log = log;
    this.now = now;
    this.states = new Map();
    this.config = { time_zone: 'Europe/London', latitude: null, longitude: null };
    this.reg = { entities: new Map(), devices: new Map(), areas: new Map(), users: new Map() };
    this.sent = new Map();          // entity -> { value, sig, at, graceUntil, confirmed, tries, warned }
    this.ourContexts = new Set();
    this.queue = new Map();         // entity -> { want, reason }
    this.sending = false;
    this.motion = new Map();        // groupId -> { active, offAt }
    this.verifying = new Map();     // entity -> until: state changes now are the device's real state being read back
    this.lastLevels = new Map();    // groupId -> number, for the target log
    this.ready = false;
    this.startedAt = this.now();
  }

  get data() { return this.store.data; }
  get settings() { return { ...DEFAULT_SETTINGS, ...this.data.settings }; }

  start() {
    this.ha.on('ready', () => this._onReady().catch((err) => this.log.error?.(`Startup failed: ${err.stack || err}`)));
    this.ha.on('state_changed', (d, c) => this._onState(d, c));
    this.ha.on('event', (type, data) => this._onHaEvent(type, data));
    this.ha.on('disconnected', () => { this.ready = false; this.downSince = this.now(); this.changed(); });
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.ha.start();
  }

  async _onReady() {
    const [config, states] = await Promise.all([this.ha.getConfig(), this.ha.getStates()]);
    this.config = config;
    this.states = new Map(states.map((s) => [s.entity_id, s]));
    await this.ha.subscribeStateChanged();
    for (const type of ['lighting_control_scene', 'lighting_control_mode']) {
      try { await this.ha.subscribeEvent(type); } catch (err) { this.log.warn?.(`Couldn't listen for ${type}: ${err.message}`); }
    }
    await this._loadRegistries();
    this._seedScenes();
    this._initMotion();
    this._migrateAllOffMode();
    const firstStart = !this.ready && !this._adopted;
    this.ready = true;
    if (this.downSince) this.addActivity('Reconnected to Home Assistant.');
    this.downSince = null;
    if (firstStart) this._adoptOnStart();
    this.tick();
  }

  /** Older versions had All off as a mode. Move to Schedules, keeping everything as it is until each group's next change. */
  _migrateAllOffMode() {
    if (this.data.mode !== 'off') return;
    this.data.mode = 'schedule';
    const ms = this.now();
    for (const g of this.data.groups) {
      const until = this.overrideEnd(g, ms);
      const ov = this.data.overrides[g.id];
      if (ov) { if (ov.until == null) ov.until = until; continue; }
      this.data.overrides[g.id] = { type: 'hold', since: ms, until, by: 'here', scene: 'All off', level: { on: false, fade: 0 } };
    }
    this.addActivity('All off is now a button rather than a mode. Everything stays as it is until its next scheduled change.');
    this.store.save();
  }

  async _loadRegistries() {
    const { entities, devices, areas } = await this.ha.registries();
    this.reg.entities = new Map((entities || []).map((e) => [e.entity_id, e]));
    this.reg.devices = new Map((devices || []).map((d) => [d.id, d]));
    this.reg.areas = new Map((areas || []).map((a) => [a.area_id, a]));
    this.reg.users = new Map();
    try {
      const users = await this.ha.send('config/auth/list');
      for (const u of users || []) this.reg.users.set(u.id, u.name);
    } catch { /* not allowed: fall back to person entities */ }
    for (const s of this.states.values()) {
      if (s.entity_id.startsWith('person.') && s.attributes?.user_id) {
        this.reg.users.set(s.attributes.user_id, s.attributes.friendly_name);
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    this.queue.clear();
    this.addActivity('Lighting app stopped. Lights and sockets were left as they are.');
    this.data.lastAlive = this.now();
    this.store.flush();
    this.ha.stop();
  }

  // ---------- context and lookups ----------

  ctx() {
    const tz = this.config.time_zone || 'Europe/London';
    const sun = {};
    const sunId = this.sunEntity();
    const st = sunId && this.states.get(sunId);
    if (st?.attributes) {
      for (const [attr, key] of [['next_rising', 'sunrise'], ['next_setting', 'sunset']]) {
        const ms = Date.parse(st.attributes[attr]);
        if (Number.isFinite(ms)) {
          const k = dateKey(localDate(ms, tz));
          sun[k] = { ...(sun[k] || {}), [key]: ms };
        }
      }
    }
    return { tz, lat: this.config.latitude, lon: this.config.longitude, sun };
  }

  sunEntity() {
    const s = this.settings.sunEntity;
    if (s && s !== 'auto') return s;
    if (this.states.has('sun.sun')) return 'sun.sun';
    for (const id of this.states.keys()) if (id.startsWith('sun.')) return id;
    return null;
  }

  groupOf(entityId) {
    return this.data.groups.find((g) => g.devices.includes(entityId)) || null;
  }

  areaName(entityId) {
    const e = this.reg.entities.get(entityId);
    const areaId = e?.area_id || (e?.device_id && this.reg.devices.get(e.device_id)?.area_id);
    return areaId ? this.reg.areas.get(areaId)?.name || null : null;
  }

  friendly(entityId) {
    const st = this.states.get(entityId);
    return st?.attributes?.friendly_name || this.reg.entities.get(entityId)?.name || entityId;
  }

  deviceInfo(id, groupName = '') {
    const domain = id.split('.')[0];
    const st = this.states.get(id);
    const reg = this.reg.entities.get(id);
    const name = this.friendly(id);
    const a = st?.attributes || {};
    const dc = a.device_class || reg?.device_class || reg?.original_device_class;
    const kind = domain === 'light' ? 'light' : (dc === 'outlet' || /plug|socket|outlet/i.test(name) ? 'socket' : 'switch');
    const modes = Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [];
    const dimmable = domain === 'light' && (modes.length ? modes.some((m) => m !== 'onoff') : a.brightness != null);
    const ct = domain === 'light' && modes.includes('color_temp');
    const on = st?.state === 'on';
    const available = !!st && st.state !== 'unavailable' && st.state !== 'unknown';
    let short = name;
    if (groupName && short.toLowerCase().startsWith(groupName.toLowerCase() + ' ')) short = short.slice(groupName.length + 1);
    short = short.charAt(0).toUpperCase() + short.slice(1);
    return {
      id, domain, kind, name, short, available, missing: !st, on,
      dimmable, ct, colour: domain === 'light' && modes.some((m) => COLOR_MODES.includes(m)),
      brightness: on ? (a.brightness != null ? Math.round((a.brightness / 255) * 100) : 100) : 0,
      kelvin: on && a.color_temp_kelvin ? Math.round(a.color_temp_kelvin) : null,
      minK: Math.round(a.min_color_temp_kelvin || 2000),
      maxK: Math.round(a.max_color_temp_kelvin || 6500),
      area: this.areaName(id),
    };
  }

  // ---------- working out targets ----------

  weekFor(g, ms = this.now()) {
    const mode = this.data.mode;
    if (mode === 'schedule') return this.activeSchedule(g, ms);
    if (mode === 'away' && g.livedIn) {
      const ctx = this.ctx();
      return livedInWeek(g.id, startOfWeek(ms, ctx.tz), ctx, { offTime: this.settings.awayOffTime, brightness: this.settings.awayBrightness });
    }
    return null;
  }

  /** The group's schedule if it's running today: not empty, and inside its season if it has one. */
  activeSchedule(g, ms = this.now()) {
    const w = this.data.schedules[g.id];
    if (weekIsEmpty(w)) return null;
    if (g.season && !inSeason(localDate(ms, this.ctx().tz), g.season)) return null;
    return w;
  }

  /** When a hold "until the morning" ends: the first scheduled change after the morning time. */
  morningEnd(g, ms = this.now()) {
    const ctx = this.ctx();
    const w = this.weekFor(g, ms);
    const { morning, change } = w ? morningChange(w, ms, ctx, this.settings.morningTime) : { morning: nextLocalTime(ms, this.settings.morningTime, ctx.tz), change: null };
    return change?.at ?? morning;
  }

  motionBrightness(g, ms = this.now()) {
    const n = g.motion?.night;
    if (n && inTimeWindow(zonedParts(ms, this.ctx().tz).minutes, n.from, n.to)) return n.brightness;
    return g.motion?.brightness ?? 100;
  }

  /** When an override made now should end: the next change in the current mode, or null (until the mode changes). */
  overrideEnd(g, ms = this.now()) {
    const w = this.weekFor(g, ms);
    return w ? nextChange(w, ms, this.ctx())?.at ?? null : null;
  }

  motionUntil(g) {
    const m = this.motion.get(g.id);
    if (!m || !g.motion?.entity) return 0;
    const span = (g.motion.minutes || 5) * 60000;
    return m.active ? this.now() + span : (m.offAt || 0) + span;
  }

  luxValue(g) {
    if (!g.lux?.entity) return null;
    const v = Number(this.states.get(g.lux.entity)?.state);
    return Number.isFinite(v) ? v : null;
  }

  /** The group's target before per-device adjustments. */
  groupTarget(g, ms = this.now()) {
    const mode = this.data.mode;
    const ctx = this.ctx();
    let level = null; let source = 'none'; let until = null; let next = null; let pointInfo = null;

    if (mode === 'off') {
      level = { on: false }; source = 'off';
    } else {
      const week = this.weekFor(g, ms);
      if (week) {
        const st = stateAt(week, ms, ctx);
        if (st) { level = st.point; pointInfo = st; }
        next = nextChange(week, ms, ctx);
        source = mode === 'away' ? 'away' : 'schedule';
      } else if (mode === 'away') {
        level = { on: false }; source = 'away';
      }
      if (mode === 'schedule' && (!level || !level.on)) {
        const mu = this.motionUntil(g);
        if (mu > ms) {
          level = { on: true, brightness: this.motionBrightness(g, ms), kelvin: null, fade: 1 };
          source = 'motion'; until = mu;
        }
      }
    }

    const ov = this.data.overrides[g.id];
    let override = null;
    if (ov && !(ov.until && ov.until <= ms)) {
      override = ov;
      until = ov.until;
      if (handsOff(ov)) { level = null; }
      else if (ov.level) { level = ov.level; }
      source = 'override';
    }

    const lux = this.luxValue(g);
    const luxBlocked = !!(g.lux?.entity && lux != null && lux > (g.lux.threshold ?? 100) && ['schedule', 'motion', 'away'].includes(source));
    return { level, source, until, next, override, luxBlocked, lux, since: pointInfo?.since ?? null };
  }

  wantFor(g, info, gt) {
    if (handsOff(gt.override)) return null;
    const lvl = gt.override?.devices?.[info.id] ?? gt.level;
    if (!lvl) return null;
    if (!lvl.on) return { on: false, fade: lvl.fade ?? 0 };
    const fade = lvl.fade ?? this.settings.defaultTransition;
    return {
      on: true,
      brightness: info.dimmable ? clamp(lvl.brightness ?? 100, 1, 100) : null,
      kelvin: info.ct && lvl.kelvin ? clamp(lvl.kelvin, info.minK, info.maxK) : null,
      fade,
    };
  }

  differs(info, want) {
    if (!info.available || !want) return false;
    if (info.on !== want.on) return true;
    if (!want.on) return false;
    if (want.brightness != null && Math.abs(info.brightness - want.brightness) > 2) return true;
    if (want.kelvin != null && info.kelvin != null && Math.abs(info.kelvin - want.kelvin) > 150) return true;
    if (want.kelvin != null && info.kelvin == null) return true;
    return false;
  }

  // ---------- the loop ----------

  tick() {
    if (!this.ready || this.data.paused) { this.changed(); return; } // paused: another app is still in charge
    const ms = this.now();
    this._checkPresence(ms);
    for (const g of this.data.groups) {
      const ov = this.data.overrides[g.id];
      if (ov?.until && ov.until <= ms) {
        delete this.data.overrides[g.id];
        this.addActivity(`${g.name}: ${this._backTo()}`, g.id);
        this.store.save();
      }
      const gt = this.groupTarget(g, ms);
      this._recordTarget(g, gt, ms);
      for (const id of g.devices) {
        const info = this.deviceInfo(id, g.name);
        const want = this.wantFor(g, info, gt);
        if (!want || !this.differs(info, want)) continue;
        if (want.on && !info.on && gt.luxBlocked && !gt.override?.devices?.[id]) continue; // bright enough
        this._maybeSend(g, info, want, gt);
      }
    }
    if (!this._aliveSaved || ms - this._aliveSaved > 60000) {
      this.data.lastAlive = ms;
      this._aliveSaved = ms;
      this.store.save();
    }
    this.changed();
  }

  _backTo() {
    return this.data.mode === 'away' ? 'back to Away' : this.data.mode === 'off' ? 'back to all off' : 'back to schedule';
  }

  _sig(want) { return `${want.on}|${want.brightness ?? ''}|${want.kelvin ?? ''}`; }

  _maybeSend(g, info, want, gt) {
    const ms = this.now();
    const s = this.sent.get(info.id);
    const sig = this._sig(want);
    let tries = 0;
    if (s && s.sig === sig) {
      if (ms < s.graceUntil) return;
      if (s.tries >= MAX_TRIES) {
        if (!s.warned) {
          s.warned = true;
          this.addActivity(`${g.name}: ${info.short} isn't responding. Check it's powered and connected to Home Assistant.`, g.id);
        }
        return;
      }
      tries = s.tries;
    }
    this.queue.set(info.id, { want: tries ? { ...want, fade: 0 } : want, group: g, tries: tries + 1 });
    this._pump();
  }

  async _pump() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.size) {
        // Devices that need exactly the same command go in one call, so a group changes together.
        const [firstId, first] = this.queue.entries().next().value;
        const key = this._jobKey(firstId, first);
        const batch = [];
        for (const [id, job] of this.queue) if (this._jobKey(id, job) === key) batch.push([id, job]);
        for (const [id] of batch) this.queue.delete(id);
        await this._send(batch);
        if (this.queue.size) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
      }
    } finally {
      this.sending = false;
    }
  }

  _callKey(id, want) {
    const domain = id.split('.')[0];
    return domain === 'light' ? `light|${this._sig(want)}|${want.fade ?? ''}` : `${domain}|${want.on}`;
  }

  _jobKey(id, job) {
    return `${this._callKey(id, job.want)}|${job.plain ? 'plain' : ''}`;
  }

  async _send(batch) {
    const [firstId, first] = batch[0];
    const { want } = first;
    const domain = firstId.split('.')[0];
    const ms = this.now();
    const fade = want.fade || 0;
    // Many Zigbee bulbs mishandle "turn off with a transition" (some jump to full brightness), so a
    // fade to off is done as: dim to 1% over the fade, then a plain off once the fade is done.
    const dimFirst = domain === 'light' && !want.on && fade >= FADE_OFF_MIN && !first.plain;
    // Bulbs don't all keep time: some take longer than asked to fade, and Home Assistant may hear late.
    const graceMs = (this.settings.graceSeconds + fade * 1.5) * 1000;
    const settleUntil = ms + (fade ? fade * 1.5 + 10 : 4) * 1000; // reports in this window may be mid-transition
    for (const [id, job] of batch) {
      const info = this.deviceInfo(id);
      const old = this.sent.get(id);
      this.verifying.delete(id); // a read-back from an earlier command is over
      // Remember recent commands too: a late report from an earlier one isn't a person.
      // where it started from, so a late report from part-way through a fade is recognised
      const from = info.on ? (info.brightness ?? 100) : 0;
      const recent = [...(old?.recent || []).filter((r) => ms - r.at < graceMs), { value: want, at: ms, settleUntil, from }];
      if (dimFirst) recent.push({ value: { on: true, brightness: 1 }, at: ms, settleUntil, from });
      this.sent.set(id, {
        value: want, sig: this._sig(want), at: ms, graceUntil: ms + graceMs, settleUntil, recent: recent.slice(-6),
        prev: { on: info.on, brightness: info.brightness },
        confirmed: false, tries: job.tries, warned: false,
        // after a plain off, a light that comes straight back on is the light misbehaving, not a person
        offAt: !want.on && !dimFirst ? ms : null,
        bounces: old && !old.value.on && !want.on ? old.bounces || 0 : 0,
      });
    }
    const ids = batch.map(([id]) => id);
    let service = want.on ? 'turn_on' : 'turn_off';
    const data = { entity_id: ids.length === 1 ? ids[0] : ids };
    if (domain === 'light' && want.on) {
      if (fade) data.transition = fade;
      if (want.brightness != null) data.brightness_pct = want.brightness;
      if (want.kelvin != null) data.color_temp_kelvin = want.kelvin;
    } else if (dimFirst) {
      service = 'turn_on';
      data.brightness_pct = 1;
      data.transition = fade;
    }
    try {
      const res = await this.ha.callService(domain, service, data);
      const ctxId = res?.context?.id;
      if (ctxId) {
        this.ourContexts.add(ctxId);
        if (this.ourContexts.size > 500) this.ourContexts.delete(this.ourContexts.values().next().value);
      }
      this._trace(ids, `${service === 'turn_off' ? 'off' : dimFirst ? `dimming to 1% over ${fade} s, then off` : want.on ? `on${data.brightness_pct != null ? ` ${data.brightness_pct}%` : ''}${data.color_temp_kelvin ? ` ${data.color_temp_kelvin} K` : ''}${data.transition ? ` over ${data.transition} s` : ''}` : 'off'}${first.plain ? ' (end of fade or putting it back)' : ''}`);
      if (dimFirst) setTimeout(() => this._finishFadeOff(ids, first.group, ms), fade * 1000 + 500);
      else this._scheduleReadBack(ids, want.on ? READ_BACK_ON : READ_BACK_OFF);
    } catch (err) {
      this.log.warn?.(`Command to ${ids.join(', ')} failed: ${err.message}`);
      if (first.tries === 1) {
        const g = first.group;
        const names = ids.map((id) => this.deviceInfo(id, g.name).short).join(', ');
        this.addActivity(`${g.name}: couldn't change ${names}. ${err.message}.`, g.id);
      }
    }
  }

  /** A few seconds after a command, ask Home Assistant to read the lights' real state back from the devices. */
  _scheduleReadBack(ids, delays) {
    const list = ids.filter((id) => READ_BACK.has(this.reg.entities.get(id)?.platform));
    if (!list.length) return;
    const sentAt = new Map(list.map((id) => [id, this.sent.get(id)?.at]));
    for (const delay of delays) {
      setTimeout(async () => {
        if (!this.ready) return;
        // only while that command is still the latest one for the light
        const still = list.filter((id) => this.sent.get(id)?.at === sentAt.get(id));
        if (!still.length) return;
        const until = this.now() + VERIFY_WINDOW_MS;
        for (const id of still) this.verifying.set(id, until);
        try {
          await this.ha.callService('homeassistant', 'update_entity', { entity_id: still });
        } catch (err) {
          this.log.warn?.(`Couldn't read back ${still.join(', ')}: ${err.message}`);
        }
      }, delay);
    }
  }

  /** A line in the app's log for each command and each surprise, for working out what a light did. */
  _trace(ids, text) {
    const names = [].concat(ids).map((id) => this.deviceInfo(id).short || id).join(', ');
    this.log.info?.(`Lights: ${names}: ${text}`);
  }

  /** The dim part of a fade to off is done: switch off, unless the target changed or someone took over. */
  _finishFadeOff(ids, g, startedAt) {
    const ov = this.data.overrides[g.id];
    if (ov?.type === 'manual' && ov.since > startedAt) return;
    for (const id of ids) {
      const s = this.sent.get(id);
      if (!s || s.at !== startedAt || s.value.on) continue; // replaced by a newer command
      this.queue.set(id, { want: { on: false, fade: 0 }, group: g, tries: 1, plain: true });
    }
    this._pump();
  }

  /** We switched a light off and it came straight back on by itself: switch it off again, a couple of times. */
  _bounced(g, info, s) {
    s.bounces = (s.bounces || 0) + 1;
    if (s.bounces <= 2) {
      if (s.bounces === 1) {
        const secs = s.offAt ? Math.max(1, Math.round((this.now() - s.offAt) / 1000)) : null;
        this.addActivity(`${g.name}: ${info.short} came back on by itself${info.dimmable && info.brightness ? ` at ${info.brightness}%` : ''}${secs ? ` ${secs} s` : ''} after being switched off, so it was switched off again.`, g.id);
      }
      this.queue.set(info.id, { want: { on: false, fade: 0 }, group: g, tries: 1, plain: true });
      this._pump();
    } else if (!s.warned) {
      s.warned = true;
      this.addActivity(`${g.name}: ${info.short} keeps coming back on by itself after being switched off. Check it isn't on a smart plug or paired to a remote or another automation. If it's a Zigbee bulb, setting its start-up behaviour to "Previous" or "Off" in Home Assistant can help.`, g.id);
    }
    this.changed();
  }

  /** A new target replaces the old one: send it even if the old command is still in its wait, but keep
   *  the wait itself so late reports from the old command aren't mistaken for a person. */
  _retarget(ids) {
    for (const id of ids) {
      const s = this.sent.get(id);
      if (s) { s.sig = null; s.tries = 0; s.warned = false; }
    }
  }

  _recordTarget(g, gt, ms) {
    const lvl = handsOff(gt.override) ? null : gt.level;
    const value = lvl ? levelOf(lvl) : null;
    if (this.lastLevels.has(g.id) && this.lastLevels.get(g.id) === value) return;
    this.lastLevels.set(g.id, value);
    const list = (this.data.targets[g.id] ||= []);
    list.push({ at: ms, level: value });
    while (list.length && list[0].at < ms - TARGET_KEEP_MS) list.shift();
    this.store.save();
  }

  /** On first start, lights that differ from the schedule are left alone unless a scheduled change was missed while we were stopped. */
  _adoptOnStart() {
    this._adopted = true;
    const ms = this.now();
    const lastAlive = this.data.lastAlive || 0;
    for (const g of this.data.groups) {
      if (this.data.overrides[g.id]) continue;
      const gt = this.groupTarget(g, ms);
      if (!gt.level || gt.source === 'off') continue;
      if (gt.since && gt.since > lastAlive) continue; // missed a change: catch up
      const differs = g.devices.some((id) => {
        const info = this.deviceInfo(id, g.name);
        return this.differs(info, this.wantFor(g, info, gt));
      });
      if (!differs) continue;
      const until = this.overrideEnd(g, ms);
      this.data.overrides[g.id] = { type: 'manual', since: ms, until, by: 'before the app started' };
      this.addActivity(`${g.name}: left as it was when the app started, ${this._untilText(until)}.`, g.id);
    }
    this.store.save();
  }

  // ---------- events from HA ----------

  _initMotion() {
    for (const g of this.data.groups) {
      if (!g.motion?.entity) continue;
      const on = this.states.get(g.motion.entity)?.state === 'on';
      this.motion.set(g.id, { active: on, offAt: on ? 0 : this.now() - 3600000 });
    }
  }

  _onState(data, evCtx) {
    const id = data?.entity_id;
    if (!id) return;
    const ns = data.new_state; const os = data.old_state;
    if (ns) this.states.set(id, ns); else this.states.delete(id);
    if (!this.ready) return;

    if (id.startsWith('person.')) {
      if (ns?.attributes?.user_id) this.reg.users.set(ns.attributes.user_id, ns.attributes.friendly_name);
      if (ns?.state !== os?.state) this._onPersonChange(id, os?.state, ns?.state);
      return;
    }

    // Motion and lux sensors
    let motionHit = false;
    for (const g of this.data.groups) {
      if (g.motion?.entity === id && ns?.state !== os?.state) {
        const m = this.motion.get(g.id) || {};
        if (ns?.state === 'on') { m.active = true; }
        else if (m.active) { m.active = false; m.offAt = this.now(); }
        this.motion.set(g.id, m);
        motionHit = true;
      }
      if (g.lux?.entity === id) motionHit = true;
    }
    if (motionHit) { this._soon(); return; }

    if (this.data.paused) { this.changed(); return; }
    const g = this.groupOf(id);
    if (!g) { if (id === this.sunEntity()) this.changed(); return; }
    const info = this.deviceInfo(id, g.name);
    if (!info.available || !this._relevant(os, ns)) { this.changed(); return; }

    const context = ns?.context || evCtx || {};
    const s = this.sent.get(id);
    // Our own change landing (or the device catching up): recheck soon, in case the target moved meanwhile.
    if (context.id && this.ourContexts.has(context.id)) {
      if (s && info.on === s.value.on) s.confirmed = true;
      this._soon();
      return;
    }
    if (this.queue.has(id)) { this.changed(); return; } // we're about to change it anyway
    // The device's real state, read back on our request: it's never a person.
    const readBack = (this.verifying.get(id) ?? 0) > this.now();
    if (s && s.offAt && !s.value.on && info.on && (readBack || (!context.user_id && !context.parent_id)) && this.now() - s.offAt < BOUNCE_MS) {
      this._trace(id, `came back on by itself${info.dimmable ? ` at ${info.brightness}%` : ''}, ${Math.round((this.now() - s.offAt) / 1000)} s after being switched off${readBack ? ' (found by reading it back)' : ''}`);
      this._bounced(g, info, s);
      return;
    }
    if (readBack) { this._soon(); return; }
    if (s && this.now() < s.graceUntil && this._looksLikeOurs(info, s)) { this._soon(); return; }
    if (!this.settings.detectManual) { this._soon(); return; }

    const gt = this.groupTarget(g);
    const want = this.wantFor(g, info, gt);
    const who = this._who(context);
    const what = info.on
      ? (info.dimmable ? `set to ${info.brightness}%` : 'turned on')
      : 'turned off';
    if (want && !this.differs(info, want)) { this.changed(); return; }
    if (!want && !handsOff(gt.override)) { this.changed(); return; } // not managed right now: nothing to hold

    const until = handsOff(gt.override) ? gt.override.until : this.overrideEnd(g);
    this._trace(id, `${what} ${who}${s ? ` (${Math.round((this.now() - s.at) / 1000)} s after the app last changed it)` : ''}: leaving it alone`);
    this.data.overrides[g.id] = { type: 'manual', since: this.now(), until, by: who, device: id };
    this.sent.delete(id); // a person has it now
    this.addActivity(`${g.name}: ${info.short} ${what} ${who}. Leaving it ${this._untilText(until)}.`, g.id);
    this.store.save();
    this.changed();
  }

  /** Is a report during the wait after a command just the device catching up? */
  _looksLikeOurs(info, s) {
    const ms = this.now();
    const want = s.value;
    if (info.on === want.on) s.confirmed = true;
    // Matches something we asked for recently, or is part-way through one of our fades.
    for (const r of s.recent || []) {
      if (r.value.on !== info.on) continue;
      if (!info.on || !info.dimmable || r.value.brightness == null) return true;
      if (Math.abs(info.brightness - r.value.brightness) <= 2) return true;
      if (ms < r.settleUntil) return true;
      // a late report from part-way through one of our fades: between where it started and where it was going
      if (r.from != null) {
        const lo = Math.min(r.from, r.value.brightness) - 3; const hi = Math.max(r.from, r.value.brightness) + 3;
        if (info.brightness >= lo && info.brightness <= hi) return true;
      }
    }
    if (info.on !== want.on) return !s.confirmed; // the old on/off showing up before ours landed
    if (info.dimmable && s.prev?.on && Math.abs(info.brightness - s.prev.brightness) <= 2) return true; // old level reported late
    return false;
  }

  _relevant(os, ns) {
    if (!os || !ns) return true;
    if (os.state !== ns.state) return true;
    if (ns.state !== 'on') return false;
    const a = os.attributes || {}; const b = ns.attributes || {};
    if (Math.abs((a.brightness ?? 0) - (b.brightness ?? 0)) > 4) return true;
    if (Math.abs((a.color_temp_kelvin ?? 0) - (b.color_temp_kelvin ?? 0)) > 60) return true;
    return false;
  }

  _who(context) {
    if (context?.user_id) {
      const name = this.reg.users.get(context.user_id);
      return name ? `by ${name}` : 'in Home Assistant';
    }
    if (context?.parent_id) return 'by an automation or voice assistant';
    return 'at the switch';
  }

  _untilText(until) {
    if (!until) return this.data.mode === 'schedule' ? 'until changed again' : 'until you change mode';
    const tz = this.ctx().tz;
    const p = zonedParts(until, tz);
    const t = minutesToTime(p.minutes);
    const today = dateKey(localDate(this.now(), tz));
    const that = dateKey(localDate(until, tz));
    if (that === today) return `until ${t}`;
    const tomorrow = new Date(this.now() + 86400000);
    if (that === dateKey(localDate(tomorrow.getTime(), tz))) return `until ${t} tomorrow`;
    return `until ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][p.dow]} ${t}`;
  }

  _soon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.tick(), 250);
  }

  // ---------- actions from the app ----------

  setMode(mode, { reason = null, auto = false } = {}) {
    if (mode === 'off') { this.runScene('all-off', { from: reason ? 'Home Assistant' : null }); return; } // older dashboards and scripts
    if (!['schedule', 'away'].includes(mode)) throw new UserError('Unknown mode');
    if (mode === this.data.mode) return;
    this.data.mode = mode;
    this.data.overrides = {};
    this._retarget([...this.sent.keys()]);
    // Changed by hand while everyone is out: don't flip straight back to Away; wait for someone to come home first.
    if (!auto) this.presenceHold = this.settings.autoAway && mode !== 'away' && this._presence().allOut;
    const what = mode === 'schedule' ? 'Back on schedules.' : mode === 'away' ? 'Away mode on.' : 'Everything switched off. Schedules paused.';
    this.addActivity(reason ? `${reason} ${what}` : what);
    this.store.save();
    this.tick();
  }

  setGroup(groupId, body, opts = {}) {
    const g = this.data.groups.find((x) => x.id === groupId);
    if (!g) throw new UserError('That group no longer exists');
    const ms = this.now();
    const minutes = body.minutes != null ? clamp(Math.round(Number(body.minutes)) || 0, 0, 24 * 60) : 0;
    const gt = this.groupTarget(g, ms);
    const prev = this.data.overrides[g.id];
    const current = this._currentLevel(g);
    const base = (prev && !handsOff(prev) && prev.level) || (gt.level && !handsOff(gt.override) ? gt.level : null) || current;
    const turnOn = this.turnOnLevel(g, ms);
    const merge = (was) => {
      const on = body.on != null ? !!body.on : (body.brightness != null || body.kelvin != null ? true : !!was?.on);
      // Switching on from off without a brightness: use the level the schedule uses at this time of day.
      const from = on && !was?.on ? turnOn : was;
      return {
        on,
        brightness: on ? (body.brightness != null ? clamp(Math.round(Number(body.brightness)), 1, 100) : from?.on ? from.brightness ?? 100 : 100) : null,
        kelvin: on ? (body.kelvin != null ? clamp(Math.round(Number(body.kelvin)), 2000, 6500) : from?.kelvin ?? null) : null,
        fade: 0.5,
      };
    };
    const until = opts.until !== undefined ? opts.until : minutes ? ms + minutes * 60000 : this.overrideEnd(g, ms);
    const ov = { type: opts.type || (minutes ? 'timer' : 'hold'), since: ms, until, by: 'here', ...(opts.scene ? { scene: opts.scene } : {}) };
    if (body.device) {
      if (!g.devices.includes(body.device)) throw new UserError('That light or socket isn\'t in this group');
      const info = this.deviceInfo(body.device, g.name);
      ov.level = base;
      ov.devices = { ...(!handsOff(prev) ? prev?.devices : null), [body.device]: merge(info.on ? { on: true, brightness: info.brightness, kelvin: info.kelvin } : { on: false }) };
      // Lock the rest of the group to what they are doing now, so one change doesn't move the others.
      if (!ov.level) {
        for (const id of g.devices) {
          if (id === body.device || ov.devices[id]) continue;
          const o = this.deviceInfo(id, g.name);
          ov.devices[id] = o.on ? { on: true, brightness: o.brightness, kelvin: o.kelvin, fade: 0.5 } : { on: false, fade: 0.5 };
        }
      }
      this.addActivity(`${g.name}: ${info.short} ${this._levelText(ov.devices[body.device], info.dimmable)} here, ${this._untilText(until)}.`, g.id);
    } else {
      ov.level = merge(base);
      if (!opts.quiet) this.addActivity(`${g.name}: ${this._levelText(ov.level, g.devices.some((id) => this.deviceInfo(id).dimmable))} here, ${this._untilText(until)}.`, g.id);
    }
    this.data.overrides[g.id] = ov;
    this._retarget(g.devices);
    this.store.save();
    this.tick();
  }

  /** What a group comes on at when someone turns it on by hand. */
  turnOnLevel(g, ms = this.now()) {
    const week = this.activeSchedule(g, ms);
    const hit = week ? turnOnPoint(week, ms, this.ctx()) : null;
    if (hit) {
      const when = hit.point.time ? minutesToTime(zonedParts(hit.at, this.ctx().tz).minutes) : describeWhen(hit.point);
      return {
        on: true, brightness: hit.point.brightness ?? 100, kelvin: hit.point.kelvin ?? null,
        note: hit.at > ms ? `the level due at ${when}` : `the level from ${when}`,
      };
    }
    return { on: true, brightness: g.onBrightness ?? 100, kelvin: null, note: 'this group\'s usual level' };
  }

  _levelText(l, dimmable) {
    if (!l?.on) return 'turned off';
    return dimmable && l.brightness != null ? `set to ${l.brightness}%` : 'turned on';
  }

  _currentLevel(g) {
    return this._levelFrom(g.devices.map((id) => this.deviceInfo(id, g.name)));
  }

  /** The group's level as one value: on if anything is on, average brightness of the dimmable ones that are on. */
  _levelFrom(infos) {
    const on = infos.filter((i) => i.available && i.on);
    if (!on.length) return { on: false };
    const dim = on.filter((i) => i.dimmable);
    const ks = on.filter((i) => i.kelvin);
    return {
      on: true,
      brightness: dim.length ? Math.round(dim.reduce((s, i) => s + i.brightness, 0) / dim.length) : 100,
      kelvin: ks.length ? Math.round(ks.reduce((s, i) => s + i.kelvin, 0) / ks.length / 50) * 50 : null,
    };
  }

  /** True while a command we sent is still landing: the device may report old or in-between values. */
  _settling(id, want) {
    if (this.queue.has(id)) return true;
    const s = this.sent.get(id);
    if (!s || !want || s.sig !== this._sig(want)) return false;
    const ms = this.now();
    return ms < s.settleUntil || (!s.confirmed && ms < s.graceUntil);
  }

  /** What to show for a device: what we asked for while it's settling, otherwise what it reports. */
  _shown(info, want) {
    if (!info.available || !want || !this._settling(info.id, want)) return { ...info, settling: false };
    return {
      ...info,
      settling: true,
      on: want.on,
      brightness: want.on ? (info.dimmable ? want.brightness ?? 100 : 100) : 0,
      kelvin: want.on ? want.kelvin ?? info.kelvin : null,
    };
  }

  resume(groupId) {
    const g = this.data.groups.find((x) => x.id === groupId);
    if (!g) throw new UserError('That group no longer exists');
    if (this.data.overrides[g.id]) {
      delete this.data.overrides[g.id];
      this._retarget(g.devices);
      this.addActivity(`${g.name}: ${this._backTo()}.`, g.id);
      this.store.save();
    }
    this.tick();
  }

  // ---------- configuration ----------

  saveGroup(input, existingId = null) {
    const name = String(input?.name ?? '').trim().slice(0, 40);
    if (!name) throw new UserError('Give the group a name');
    const devices = [...new Set((Array.isArray(input.devices) ? input.devices : []).filter(isDevice))].slice(0, 60);
    let g = existingId ? this.data.groups.find((x) => x.id === existingId) : null;
    if (existingId && !g) throw new UserError('That group no longer exists');
    if (!g) {
      let id = slug(name); let n = 2;
      while (this.data.groups.some((x) => x.id === id)) id = `${slug(name)}-${n++}`;
      g = { id, name, devices: [] };
      this.data.groups.push(g);
      this.data.schedules[id] = this.data.schedules[id] || normalizeWeek({});
    }
    // A device lives in one group only, so schedules never fight.
    const moved = [];
    for (const other of this.data.groups) {
      if (other === g) continue;
      const before = other.devices.length;
      other.devices = other.devices.filter((d) => !devices.includes(d));
      if (other.devices.length !== before) moved.push(other.name);
    }
    g.name = name;
    g.devices = devices;
    const night = input.motion?.night;
    g.motion = input.motion?.entity && /^binary_sensor\.[a-z0-9_]+$/.test(input.motion.entity)
      ? {
        entity: input.motion.entity,
        minutes: clamp(Math.round(Number(input.motion.minutes) || 5), 1, 120),
        brightness: clamp(Math.round(Number(input.motion.brightness) || 80), 1, 100),
        night: night && timeToMinutes(night.from) != null && timeToMinutes(night.to) != null && night.from !== night.to
          ? { brightness: clamp(Math.round(Number(night.brightness) || 5), 1, 100), from: night.from, to: night.to }
          : null,
      }
      : null;
    g.season = input.season ? normalizeSeason(input.season) : null;
    g.lux = input.lux?.entity && /^sensor\.[a-z0-9_]+$/.test(input.lux.entity)
      ? { entity: input.lux.entity, threshold: clamp(Math.round(Number(input.lux.threshold) || 0), 0, 100000) }
      : null;
    g.livedIn = !!input.livedIn;
    g.onBrightness = input.onBrightness != null && input.onBrightness !== '' ? clamp(Math.round(Number(input.onBrightness)) || 100, 1, 100) : 100;
    if (g.motion && !this.motion.has(g.id)) this.motion.set(g.id, { active: this.states.get(g.motion.entity)?.state === 'on', offAt: 0 });
    this.addActivity(existingId ? `${name} group updated.` : `${name} group added.`, g.id);
    this.store.save();
    this.tick();
    return { group: g, movedFrom: moved };
  }

  deleteGroup(id) {
    const i = this.data.groups.findIndex((g) => g.id === id);
    if (i < 0) throw new UserError('That group no longer exists');
    const [g] = this.data.groups.splice(i, 1);
    delete this.data.schedules[id];
    delete this.data.overrides[id];
    delete this.data.targets[id];
    for (const sc of this.data.scenes || []) if (sc.groups) delete sc.groups[id];
    this.addActivity(`${g.name} group removed. Its lights and sockets are no longer controlled by this app.`);
    this.store.save();
    this.tick();
  }

  reorderGroups(ids) {
    if (!Array.isArray(ids)) throw new UserError('Expected a list of groups');
    const byId = new Map(this.data.groups.map((g) => [g.id, g]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const g of this.data.groups) if (!ordered.includes(g)) ordered.push(g);
    this.data.groups = ordered;
    this.store.save();
    this.changed();
  }

  setSchedule(groupId, week) {
    const g = this.data.groups.find((x) => x.id === groupId);
    if (!g) throw new UserError('That group no longer exists');
    this.data.schedules[groupId] = normalizeWeek(week);
    this.addActivity(`${g.name}: schedule updated.`, g.id);
    this._afterScheduleEdit(g);
  }

  copySchedule(fromId, toIds) {
    const from = this.data.groups.find((x) => x.id === fromId);
    if (!from) throw new UserError('That group no longer exists');
    const targets = this.data.groups.filter((g) => Array.isArray(toIds) && toIds.includes(g.id) && g.id !== fromId);
    if (!targets.length) throw new UserError('Pick at least one group to copy to');
    for (const g of targets) {
      this.data.schedules[g.id] = normalizeWeek(JSON.parse(JSON.stringify(this.data.schedules[fromId] || {})));
      this._afterScheduleEdit(g, false);
    }
    this.addActivity(`${from.name}'s schedule copied to ${targets.map((g) => g.name).join(', ')}.`);
    this.store.save();
    this.tick();
    return targets.length;
  }

  _afterScheduleEdit(g, finish = true) {
    // Saving a schedule never changes lights there and then: the new schedule takes over from its next
    // change. Until then, anything already holding carries on, and anything else is left as it is.
    if (this.data.mode === 'schedule') this.leaveAsIsUntilNext(g, 'schedule edit');
    this._retarget(g.devices);
    if (finish) { this.store.save(); this.tick(); }
  }

  /** Leave a group exactly as it is until its next scheduled change (if it differs from the schedule now). */
  leaveAsIsUntilNext(g, by = 'start') {
    const ms = this.now();
    const until = this.overrideEnd(g, ms);
    const ov = this.data.overrides[g.id];
    if (ov) { ov.until = until ?? ov.until; return; }
    if (!until) return;
    const gt = this.groupTarget(g, ms);
    const differs = g.devices.some((id) => {
      const info = this.deviceInfo(id, g.name);
      return this.differs(info, this.wantFor(g, info, gt));
    });
    if (differs) this.data.overrides[g.id] = { type: 'leave', since: ms, until, by };
  }

  saveSettings(input) {
    const s = { ...this.settings };
    if (input.sunEntity !== undefined) s.sunEntity = input.sunEntity === 'auto' || /^sun\.[a-z0-9_]+$/.test(input.sunEntity) ? input.sunEntity : 'auto';
    if (input.graceSeconds !== undefined) s.graceSeconds = clamp(Math.round(Number(input.graceSeconds)) || 20, 5, 300);
    if (input.detectManual !== undefined) s.detectManual = !!input.detectManual;
    if (input.defaultTransition !== undefined) s.defaultTransition = clamp(Math.round(Number(input.defaultTransition)) || 0, 0, 60);
    if (input.awayOffTime !== undefined && timeToMinutes(input.awayOffTime) != null) s.awayOffTime = input.awayOffTime;
    if (input.awayBrightness !== undefined) s.awayBrightness = clamp(Math.round(Number(input.awayBrightness)) || 70, 1, 100);
    if (input.stepSize !== undefined) s.stepSize = [5, 10, 20, 25].includes(Number(input.stepSize)) ? Number(input.stepSize) : 10;
    if (input.autoAway !== undefined) s.autoAway = !!input.autoAway;
    if (input.autoAwayPeople !== undefined) {
      s.autoAwayPeople = Array.isArray(input.autoAwayPeople) ? input.autoAwayPeople.filter((id) => /^person\.[a-z0-9_]+$/.test(id)) : 'auto';
      if (Array.isArray(s.autoAwayPeople) && !s.autoAwayPeople.length) s.autoAwayPeople = 'auto';
    }
    if (input.autoAwayDelay !== undefined) s.autoAwayDelay = clamp(Math.round(Number(input.autoAwayDelay)), 0, 120) || 0;
    if (input.morningTime !== undefined && timeToMinutes(input.morningTime) != null) s.morningTime = input.morningTime;
    if (input.dashboardPath !== undefined) {
      const p = String(input.dashboardPath).trim();
      s.dashboardPath = p.startsWith('/') && !p.startsWith('//') ? p.slice(0, 200) : '/';
    }
    this.data.settings = s;
    this.addActivity('Settings saved.');
    this.store.save();
    this.tick();
    return s;
  }

  // ---------- presence: automatic Away ----------

  _people() {
    const all = [...this.states.keys()].filter((id) => id.startsWith('person.')).sort();
    const pick = this.settings.autoAwayPeople;
    return Array.isArray(pick) ? pick.filter((id) => this.states.has(id)) : all;
  }

  _presence() {
    const people = this._people();
    const st = (id) => this.states.get(id)?.state;
    const home = people.filter((id) => st(id) === 'home');
    const known = people.filter((id) => st(id) && st(id) !== 'unknown' && st(id) !== 'unavailable');
    return { people, home, allOut: people.length > 0 && known.length === people.length && home.length === 0 };
  }

  _onPersonChange(id, from, to) {
    if (!this.settings.autoAway) return;
    if (to === 'home') {
      this.presenceHold = false;
      this.awaySince = null;
      if (from !== 'home' && this.data.mode === 'away' && this._people().includes(id)) {
        this.setMode('schedule', { reason: `${this.friendly(id)} is home.`, auto: true });
        return;
      }
    }
    this._soon();
  }

  _checkPresence(ms) {
    if (!this.settings.autoAway) { this.awaySince = null; return; }
    const { allOut } = this._presence();
    if (!allOut) { this.awaySince = null; this.presenceHold = false; return; }
    if (this.presenceHold || this.data.mode !== 'schedule') { this.awaySince = null; return; }
    this.awaySince ||= ms;
    if (ms - this.awaySince >= this.settings.autoAwayDelay * 60000) {
      this.awaySince = null;
      this.setMode('away', { reason: 'Everyone has left.', auto: true });
    }
  }

  // ---------- scenes ----------

  _seedScenes() {
    if (this.data.scenesSeeded) return;
    this.data.scenesSeeded = true;
    if (!this.data.scenes?.length) {
      this.data.scenes = [{ id: 'goodnight', name: 'Goodnight', until: 'morning', others: 'off', groups: {} }];
      this.store.save();
    }
  }

  sceneEntry(sc, g) {
    return sc.groups?.[g.id] ?? { action: sc.others === 'off' ? 'off' : 'leave' };
  }

  runScene(idOrName, { from = null } = {}) {
    const key = String(idOrName ?? '').trim().toLowerCase();
    const sc = (this.data.scenes || []).find((x) => x.id === key || x.name.toLowerCase() === key)
      || (ALL_OFF_NAMES.includes(key) ? ALL_OFF : null);
    if (!sc) throw new UserError(`There's no scene called "${idOrName}"`);
    const ms = this.now();
    let n = 0;
    for (const g of this.data.groups) {
      const e = this.sceneEntry(sc, g);
      if (e.action !== 'on' && e.action !== 'off') continue;
      const until = e.minutes ? ms + e.minutes * 60000 : sc.until === 'morning' ? this.morningEnd(g, ms) : this.overrideEnd(g, ms);
      const body = e.action === 'off' ? { on: false } : { on: true, ...(e.brightness ? { brightness: e.brightness } : {}), ...(e.kelvin ? { kelvin: e.kelvin } : {}) };
      this.setGroup(g.id, body, { until, scene: sc.name, quiet: true, type: e.minutes ? 'timer' : 'hold' });
      n++;
    }
    const by = from ? ` (from ${from})` : '';
    if (sc === ALL_OFF) this.addActivity(`All off${by}: everything switched off until its next scheduled change.`);
    else {
      const tail = sc.until === 'morning' ? ' until the morning' : ' until their next scheduled change';
      this.addActivity(`${sc.name}${by}: ${n} ${n === 1 ? 'group' : 'groups'} set${tail}.`);
    }
    return n;
  }

  saveScene(input, existingId = null) {
    const name = String(input?.name ?? '').trim().slice(0, 30);
    if (!name) throw new UserError('Give the scene a name');
    let sc = existingId ? this.data.scenes.find((x) => x.id === existingId) : null;
    if (existingId && !sc) throw new UserError('That scene no longer exists');
    if (this.data.scenes.some((x) => x !== sc && x.name.toLowerCase() === name.toLowerCase())) throw new UserError('There\'s already a scene with that name');
    if (!sc) {
      let id = slug(name); let n = 2;
      while (this.data.scenes.some((x) => x.id === id)) id = `${slug(name)}-${n++}`;
      sc = { id };
      this.data.scenes.push(sc);
    }
    sc.name = name;
    sc.until = input.until === 'morning' ? 'morning' : 'next';
    sc.others = input.others === 'off' ? 'off' : 'leave';
    sc.groups = {};
    for (const [gid, e] of Object.entries(input.groups || {})) {
      if (!this.data.groups.some((g) => g.id === gid) || !e) continue;
      const action = ['on', 'off', 'leave'].includes(e.action) ? e.action : 'leave';
      const num = (v, lo, hi) => (v == null || v === '' ? null : clamp(Math.round(Number(v)) || lo, lo, hi));
      sc.groups[gid] = {
        action,
        brightness: action === 'on' ? num(e.brightness, 1, 100) : null,
        kelvin: action === 'on' ? num(e.kelvin, 2000, 6500) : null,
        minutes: action === 'leave' ? null : num(e.minutes, 1, 720),
      };
    }
    this.addActivity(existingId ? `${name} scene updated.` : `${name} scene added.`);
    this.store.save();
    this.changed();
    return sc;
  }

  deleteScene(id) {
    const i = this.data.scenes.findIndex((x) => x.id === id);
    if (i < 0) throw new UserError('That scene no longer exists');
    const [sc] = this.data.scenes.splice(i, 1);
    this.addActivity(`${sc.name} scene removed.`);
    this.store.save();
    this.changed();
  }

  _onHaEvent(type, data) {
    try {
      if (this.data.paused) { this.addActivity('Home Assistant asked for a scene or mode, but lighting is paused while you switch over.'); return; }
      if (type === 'lighting_control_scene') this.runScene(data.scene ?? data.name ?? data.id, { from: 'Home Assistant' });
      else if (type === 'lighting_control_mode') {
        const m = String(data.mode || '').toLowerCase();
        if (ALL_OFF_NAMES.includes(m)) this.runScene('all-off', { from: 'Home Assistant' });
        else if (this.modeRequest) this.modeRequest(m === 'schedules' ? 'schedule' : m, 'From Home Assistant:'); // the house: Away is shared with the heating
        else this.setMode(m === 'schedules' ? 'schedule' : m, { reason: 'From Home Assistant:' });
      }
    } catch (err) {
      this.addActivity(`Home Assistant asked for something the app couldn't do: ${err.message}.`);
    }
  }

  // ---------- activity ----------

  addActivity(text, group = null) {
    this.data.activity.push({ at: this.now(), text, group });
    if (this.data.activity.length > ACTIVITY_MAX) this.data.activity.splice(0, this.data.activity.length - ACTIVITY_MAX);
    this.store.save();
    this.changed();
  }

  changed() { this.emit('change'); }

  // ---------- snapshots for the web app ----------

  statusFor(g, gt, infos) {
    const tz = this.ctx().tz;
    const fmtT = (ms) => minutesToTime(zonedParts(ms, tz).minutes);
    if (infos.length && infos.every((i) => !i.available)) return { text: 'Can\'t reach these right now. Check they\'re powered and connected to Home Assistant.', tone: 'warn' };
    if (!infos.length) return { text: 'No lights or sockets yet. Add some in Settings.', tone: 'warn' };
    const dimmable = infos.some((i) => i.dimmable);
    const nextText = () => {
      if (!gt.next) return '';
      const p = gt.next.point;
      const lvl = !p.on ? 'Turns off' : dimmable && p.brightness != null ? `${p.brightness}%` : 'Comes on';
      const when = p.anchor ? `${fmtT(gt.next.at)} (${describeWhen(p)})` : fmtT(gt.next.at);
      return !p.on || !(dimmable && p.brightness != null) ? `${lvl} at ${when}` : `${lvl} from ${when}`;
    };
    const ov = gt.override;
    if (ov) {
      const until = this._untilText(ov.until);
      if (ov.type === 'leave') return { text: ov.by === 'start' ? `Left as it is ${until}, then its schedule takes over` : `Left as it is ${until}, then the new schedule takes over`, tone: 'hold' };
      if (ov.type === 'manual') return { text: ov.by === 'before the app started' ? `Left as it was, ${until}` : `Changed ${ov.by} ${until}`, tone: 'hold' };
      if (ov.scene) return { text: `${ov.scene} ${until}`, tone: 'hold' };
      if (ov.type === 'timer') return { text: `Set here ${until}`, tone: 'hold' };
      return { text: `Set here ${until}`, tone: 'hold' };
    }
    if (gt.source === 'off') return { text: 'All off. Schedules paused.', tone: 'quiet' };
    if (gt.source === 'motion') return { text: `On for movement until ${fmtT(gt.until)}`, tone: 'normal' };
    if (gt.luxBlocked && gt.level?.on && infos.some((i) => !i.on)) return { text: 'Bright enough. Will come on when it gets darker.', tone: 'normal' };
    if (gt.source === 'away') {
      if (!g.livedIn) return { text: 'Away. Kept off.', tone: 'quiet' };
      return { text: `Away, looking lived in. ${nextText()}`.trim(), tone: 'normal' };
    }
    if (gt.source === 'schedule') {
      const n = nextText();
      return { text: n ? `On schedule. ${n}` : 'On schedule', tone: 'normal' };
    }
    if (this.data.mode === 'schedule' && g.season && !weekIsEmpty(this.data.schedules[g.id])) {
      return { text: `Schedule sleeping until ${describeMonthDay(g.season.from)}. Changes here last until you change them again.`, tone: 'quiet' };
    }
    return { text: 'No schedule. Changes here last until you change them again.', tone: 'quiet' };
  }

  todaySegments(g, ms = this.now()) {
    const ctx = this.ctx();
    if (this.data.mode === 'off') return [{ from: 0, to: 1440, on: false, brightness: 0, kelvin: null }];
    const w = this.weekFor(g, ms);
    if (!w) return this.data.mode === 'away' ? [{ from: 0, to: 1440, on: false, brightness: 0, kelvin: null }] : [];
    return daySegments(w, localDate(ms, ctx.tz), ctx);
  }

  snapshot() {
    const ms = this.now();
    const ctx = this.ctx();
    const today = localDate(ms, ctx.tz);
    const sun = sunTimes(today, ctx);
    let lightsOn = 0; let total = 0;
    const onIn = [];
    let nextAny = null;
    const groups = this.data.groups.map((g) => {
      const gt = this.groupTarget(g, ms);
      // Show what was asked for while a change is landing, so the screen doesn't jump to in-between values.
      const infos = g.devices.map((id) => {
        const info = this.deviceInfo(id, g.name);
        const w = this.wantFor(g, info, gt);
        return { ...this._shown(info, w), target: w ? { on: w.on, brightness: w.brightness, kelvin: w.kelvin } : null };
      });
      const cur = this._levelFrom(infos);
      const onCount = infos.filter((i) => i.on).length;
      total += infos.length; lightsOn += onCount;
      if (onCount) onIn.push(g.name);
      if (gt.next && !gt.override && (!nextAny || gt.next.at < nextAny.at)) nextAny = { at: gt.next.at, group: g.name, point: gt.next.point };
      const tgt = handsOff(gt.override) ? null : gt.level;
      return {
        id: g.id, name: g.name, livedIn: !!g.livedIn,
        devices: infos,
        current: { ...cur, onCount, total: infos.length },
        settling: infos.some((i) => i.settling),
        turnOn: (({ brightness, kelvin, note }) => ({ brightness, kelvin, note }))(this.turnOnLevel(g, ms)),
        season: g.season ? { ...g.season, active: inSeason(today, g.season), text: `${describeMonthDay(g.season.from)} to ${describeMonthDay(g.season.to)}` } : null,
        target: tgt ? { on: !!tgt.on, brightness: tgt.on ? tgt.brightness ?? 100 : null, kelvin: tgt.kelvin ?? null } : null,
        source: gt.source,
        override: gt.override ? { type: gt.override.type, until: gt.override.until, by: gt.override.by } : null,
        status: this.statusFor(g, gt, infos),
        dimmable: infos.some((i) => i.dimmable),
        ct: infos.some((i) => i.ct),
        minK: Math.min(...infos.filter((i) => i.ct).map((i) => i.minK), 6500),
        maxK: Math.max(...infos.filter((i) => i.ct).map((i) => i.maxK), 2000),
        segments: this.todaySegments(g, ms),
        hasSchedule: !weekIsEmpty(this.data.schedules[g.id]),
        motion: g.motion ? { ...g.motion, name: this.friendly(g.motion.entity), active: this.motionUntil(g) > ms, missing: !this.states.has(g.motion.entity) } : null,
        lux: g.lux ? { ...g.lux, name: this.friendly(g.lux.entity), value: gt.lux, missing: !this.states.has(g.lux.entity) } : null,
      };
    });
    const manualToday = this.data.activity.filter((a) => a.at > ms - 86400000 && /(at the switch|by |in Home Assistant|automation)/.test(a.text) && /Leaving it/.test(a.text)).length;
    return {
      now: ms,
      connected: this.ha.connected && this.ready,
      haError: this.ha.connected ? null : this.ha.lastError,
      downFor: this.ready ? 0 : ms - (this.downSince ?? this.startedAt),
      mode: this.data.mode,
      ctx: { tz: ctx.tz, lat: ctx.lat, lon: ctx.lon, sun: ctx.sun },
      today: { ...today, minutes: zonedParts(ms, ctx.tz).minutes, sunrise: sun.sunrise, sunset: sun.sunset },
      sunFound: this.sunEntity(),
      settings: { dashboardPath: this.settings.dashboardPath, stepSize: this.settings.stepSize, detectManual: this.settings.detectManual },
      groups,
      scenes: (this.data.scenes || []).map((sc) => ({ id: sc.id, name: sc.name })),
      presence: this.settings.autoAway ? (() => {
        const p = this._presence();
        return { enabled: true, people: p.people.length, home: p.home.map((id) => this.friendly(id)), allOut: p.allOut, awaySince: this.awaySince || null, delay: this.settings.autoAwayDelay, waiting: !!this.presenceHold };
      })() : { enabled: false },
      stats: {
        lightsOn, total, onIn,
        next: nextAny ? { at: nextAny.at, group: nextAny.group, on: !!nextAny.point.on, brightness: nextAny.point.brightness ?? null, when: describeWhen(nextAny.point) } : null,
        manualToday,
      },
    };
  }

  /** Everything Settings needs: candidate entities, areas, current config. */
  configSnapshot() {
    const devices = []; const motion = []; const lux = []; const suns = []; const people = [];
    for (const s of this.states.values()) {
      const id = s.entity_id; const domain = id.split('.')[0];
      const reg = this.reg.entities.get(id);
      if (reg?.entity_category || reg?.disabled_by) continue;
      const dc = s.attributes?.device_class || reg?.device_class || reg?.original_device_class;
      if (domain === 'light' || domain === 'switch') {
        const info = this.deviceInfo(id);
        const g = this.groupOf(id);
        devices.push({ id, name: info.name, kind: info.kind, dimmable: info.dimmable, ct: info.ct, area: info.area, group: g?.id || null, hidden: !!reg?.hidden_by });
      } else if (domain === 'binary_sensor' && ['motion', 'occupancy', 'presence'].includes(dc)) {
        motion.push({ id, name: this.friendly(id), area: this.areaName(id) });
      } else if (domain === 'sensor' && dc === 'illuminance') {
        lux.push({ id, name: this.friendly(id), area: this.areaName(id), unit: s.attributes?.unit_of_measurement || 'lx' });
      } else if (domain === 'sun') {
        suns.push({ id, name: this.friendly(id) });
      } else if (domain === 'person') {
        people.push({ id, name: this.friendly(id), state: s.state });
      }
    }
    const byName = (a, b) => (a.area || '~').localeCompare(b.area || '~') || a.name.localeCompare(b.name);
    devices.sort(byName); motion.sort(byName); lux.sort(byName);
    const areas = [];
    for (const a of this.reg.areas.values()) {
      const ids = devices.filter((d) => d.area === a.name && !d.hidden).map((d) => d.id);
      if (ids.length) areas.push({ id: a.area_id, name: a.name, devices: ids });
    }
    areas.sort((a, b) => a.name.localeCompare(b.name));
    return {
      connected: this.ha.connected && this.ready,
      settings: this.settings,
      sunFound: this.sunEntity(),
      groups: this.data.groups,
      candidates: { devices, motion, lux, suns, people },
      scenes: this.data.scenes || [],
      areas,
      registryAvailable: this.reg.areas.size > 0 || this.reg.entities.size > 0,
    };
  }

  schedulesSnapshot() {
    return { schedules: this.data.schedules, mode: this.data.mode };
  }
}

export class UserError extends Error {}
