// The heating brain: works out each room's target, drives the TRVs, and fires
// the boiler when any room is calling for heat.
import { EventEmitter } from 'node:events';
import { scheduledAt, localWeekPosition, normaliseSchedule, defaultSchedule, DAYS } from './schedule.js';
import { scheduledTemp } from './learn.js';
import { IntegrationWatch } from './integrations.js';
import { repairUnreachable } from './repair.js';
import { recordMode, modeLogFromActivity, unusualSpans, daysTouched } from './modelog.js';
import { detectOutsideEntity, readOutside } from './history.js';
import { nextHeat, heatingUntil, outsideCurve, toFive } from './forecast.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const UNAVAILABLE = new Set(['unavailable', 'unknown']);
const AWAY_MIN = 5; const AWAY_MAX = 21; // Away temperatures, the house's and each room's
const BLIP_MS = 3 * 60000; // unavailable for less than this is a blip, not an outage
// Test-only: shrink the learning time windows (1 = real time).
const TS = Number(process.env.HC_TIME_SCALE) || 1;

// a snooze "until I turn it back on" never runs out; stored as the latest possible date so every
// `until > now` comparison keeps working
const FOREVER = 8.64e15;

export class Engine extends EventEmitter {
  constructor(ha, store, log = console.log) {
    super();
    this.ha = ha;
    this.store = store;
    this.log = log;
    this.calling = new Map();      // zoneId -> bool (hysteresis memory)
    this.lastCmd = new Map();      // entity -> { temp, mode, at }
    this.recent = new Map();       // entity -> [{ temp, at }]: values we set or saw replaced, for spotting late reports
    this.queue = Promise.resolve();
    this.tickTimer = null;
    this.views = [];
    this.heatSess = {};            // zoneId -> { at, temp, outside, target } while calling (warm-up learning)
    this.tempHist = new Map();     // zoneId -> [{ t, v }] recent readings (open-window detection)
    this.callSince = {};           // zoneId -> { at, temp } when it started calling (stuck-radiator check)
    this.attention = [];
    this.startedAt = Date.now();
    this.model = null;             // { k: { zoneId: k }, houseK, at }: how fast each room loses heat (roomstats.js)
    this.outsideForecast = null;   // [{ t, temp }] hourly, from the weather entity
    this.nextCache = {};           // zoneId -> { at, key, value }: when each room next needs heat
    this.boilerNext = null;        // { at, rooms } when the boiler is off
    this.boilerUntil = null;       // when it's on: about when the last room calling is warm
    this.joined = {};              // zoneId -> { at, with, reason, target, readyBy, until, due }: started early with another room
    this.integrations = new IntegrationWatch({ engine: this, scale: TS }); // Hive (or another) not working
    this.heatingReal = new Map();  // zoneId -> bool: calling, and able to heat (the boiler and its radiators reachable)
  }

  /**
   * Can the boiler be reached in Home Assistant? Not while its entity is unavailable or its
   * integration isn't working (Hive down): asking it to fire then does nothing, so it isn't
   * counted as running, and isn't switched (it's put right as soon as it's back).
   */
  boilerReachable() {
    const b = this.s.boiler?.entity;
    if (!b) return true; // no boiler here: nothing to reach
    return !this.#gone(b);
  }

  /** When the house was on Away or had the heating off (modelog.js): filled in from Activity the first time. */
  modeLog() {
    if (!Array.isArray(this.rt.modeLog)) this.rt.modeLog = modeLogFromActivity(this.store.log, { current: this.rt.mode });
    return this.rt.modeLog;
  }

  /** Times between from and to that aren't the house's usual: Away or off, and the two days after. */
  unusualSpans(from, to = Date.now()) { return unusualSpans(this.modeLog(), from, to); }

  /** The days in the last `days` that those times touch. */
  unusualDays(days = 60, now = Date.now()) {
    return daysTouched(this.unusualSpans(now - days * 86400000, now), this.ha.timeZone || 'UTC');
  }

  /** What a room drops to while the house is Away: its own, or the house's. */
  awayTempFor(zone) {
    return zone?.awayTemp != null && Number.isFinite(Number(zone.awayTemp)) ? Number(zone.awayTemp) : this.s.awayTemp;
  }

  /** Can't be reached in Home Assistant: its integration not working, or unavailable for a few minutes.
   *  A short blip (Home Assistant restarting, Hive reloading) doesn't count: the device carries on as
   *  it was told meanwhile, and a heat-up shouldn't be cut short for it. */
  #gone(id) {
    if (this.integrations.covers(id)) return true;
    const st = this.ha.get(id);
    if (!st) return true;
    if (!UNAVAILABLE.has(st.state)) return false;
    const since = Date.parse(st.last_changed || '');
    return !Number.isFinite(since) || Date.now() - since >= BLIP_MS;
  }

  /** Can this room really heat now: the boiler reachable, and a radiator of its own (or it's always open)? */
  canHeat(zone) {
    if (!this.boilerReachable()) return false;
    const own = (zone.trvs || []).filter((e) => e !== this.s.boiler?.entity);
    if (!own.length) return true;
    return own.some((e) => !this.#gone(e));
  }

  /** Is the boiler firing now, as it reports it (Hive's hvac_action, or the switch), for the day's totals? */
  boilerFiring() {
    const b = this.s.boiler?.entity;
    if (!b || !this.boilerReachable()) return false;
    const st = this.ha.get(b);
    if (UNAVAILABLE.has(st.state)) return !!this.rt.boiler.on; // a blip: as it was told
    if (b.startsWith('climate.')) {
      const a = st.attributes?.hvac_action;
      if (a != null) return a === 'heating';
    } else if (st.state === 'on' || st.state === 'off') return st.state === 'on';
    return !!this.rt.boiler.on;
  }

  get s() { return this.store.data.settings; }
  get rt() { return this.store.data.runtime; }
  get zones() { return this.store.data.zones; }
  // Kept at least 0.1° inside the start threshold so rooms can't flick on/off.
  // How a room decides when to stop early: 'auto' (learned), 'fixed' (its own %), or 'house'.
  stopModeFor(zone) {
    if (['auto', 'fixed', 'house'].includes(zone.stopEarlyMode)) return zone.stopEarlyMode;
    return zone.stopEarlyPct != null && zone.stopEarlyPct !== '' ? 'fixed' : 'auto';
  }
  // How far below target a room stops calling, in degrees.
  stopMarginFor(zone, target) {
    const mode = this.stopModeFor(zone);
    const house = Math.max(0, Number(this.s.stopEarly) || 0);
    if (mode === 'fixed') {
      const pct = Number(zone.stopEarlyPct);
      return Number.isFinite(pct) ? Math.max(0, Math.round(target * pct) / 100) : house;
    }
    if (mode === 'auto') return this.rt.learn?.[zone.id]?.margin ?? house;
    return house;
  }
  /** A room whose radiator is always open (no TRV of its own, e.g. the room with the boiler
   *  thermostat): it gets heat whenever the boiler runs, for any room. Set per room, or worked out. */
  openRadiator(zone) {
    if (zone.openRadiator === true || zone.openRadiator === false) return zone.openRadiator;
    return !(zone.trvs || []).some((e) => e !== this.s.boiler.entity);
  }
  // How far below target a room must fall before it heats again (at least 0.2°, so the boiler
  // can't flick on and off). Not pushed lower by stopping early: a room that isn't still warming
  // from its own leftover heat only cools, so waiting longer would just leave it cold.
  startGap() { return Math.max(0.2, Number(this.s.hysteresis) || 0); }
  /**
   * How far below target this heat-up stops: the room's stop-early margin, but less for a smaller
   * heat-up (a radiator that's only been on a little while has less heat left in it to give), and
   * always at least 0.2° above where it started, so it heats for a while rather than flicking on
   * and off. `from`: the temperature the heat-up started at (null if not known: the full margin).
   */
  heatMarginFor(zone, target, from) {
    const m = this.stopMarginFor(zone, target);
    if (from == null || !Number.isFinite(from)) return m;
    const rise = target - from;
    return Math.round(Math.max(0, Math.min(m, rise / 2, rise - 0.2)) * 100) / 100;
  }
  /**
   * Stopped early a moment ago and still warming from the radiators' leftover heat: it doesn't heat
   * again while that lasts. Only while it's actually rising: no new high for 20 minutes, or falling
   * back from it, and the leftover heat is spent (it won't rise again on its own).
   */
  coastingUp(zone, target, current, now) {
    const c = this.rt.coast?.[zone.id];
    if (!c || c.done || current == null || c.target !== target || !(c.margin > 0.05)) return false;
    if (current >= target || now - c.at > 90 * 60000 * TS) return false;
    return now - c.peakAt <= 20 * 60000 * TS && current > c.peak - 0.05;
  }

  /**
   * Once (1.13.1): forget the stop-early margins learned before, which counted any warming after the
   * heat went off (a shower, people, the sun) as leftover radiator heat. Rooms relearn from their
   * next few heat-ups.
   */
  forgetOldLearning() {
    if (this.rt.learnRules >= 2) return;
    const learned = Object.entries(this.rt.learn || {})
      .map(([id, l]) => ({ zone: this.zones.find((z) => z.id === id), margin: l?.margin }))
      .filter((x) => x.zone && x.margin > 0.05 && this.stopModeFor(x.zone) === 'auto');
    this.rt.learn = {};
    this.rt.coast = {};
    this.rt.learnRules = 2;
    this.store.save();
    if (learned.length) {
      const list = learned.map((x) => `${x.zone.name} (${Math.round(x.margin * 10) / 10}°)`).join(', ');
      this.note(`Stop early: forgot what was learned (${list}), as it counted any warming after the heat went off, such as a shower or people in the room. Rooms relearn from their next few heat-ups.`);
    }
  }

  /** Home Assistant's users, to say who changed a radiator. */
  async #loadUsers() {
    const users = new Map();
    try {
      for (const u of (await this.ha.send({ type: 'config/auth/list' })) || []) users.set(u.id, u.name);
    } catch { /* not allowed: people's names only */ }
    for (const s of this.ha.states?.values?.() || []) {
      if (s.entity_id.startsWith('person.') && s.attributes?.user_id && !users.has(s.attributes.user_id)) users.set(s.attributes.user_id, s.attributes.friendly_name);
    }
    this.users = users;
  }

  /** Who changed a radiator, from the change's context in Home Assistant. */
  whoChanged(context) {
    if (context?.user_id) {
      const name = this.users?.get(context.user_id);
      if (name === 'Home Assistant Cloud') return 'through Home Assistant Cloud (Alexa or Google)';
      return name ? `by ${name} in Home Assistant` : 'in Home Assistant';
    }
    if (context?.parent_id) return 'by an automation, script or voice assistant';
    return 'on the radiator itself, or in its own app (Hive)';
  }

  start() {
    this.forgetOldLearning();
    this.ha.on('status', (ok) => { if (ok) { this.requestTick(); this.#loadUsers(); } this.emit('change'); });
    this.ha.on('state', (id, ns, os) => this.#onState(id, ns, os));
    this.ha.on('event', (type, data) => { if (type === 'mobile_app_notification_action') this.phoneAction(data?.action); });
    setInterval(() => this.tick(), 30000);
    // is the integration behind the radiators and boiler (Hive) working? every 30 s
    const look = () => {
      if (this.disabled || !this.ha.connected) return;
      this.integrations.check().then(() => this.requestTick(200)).catch((e) => this.log(`Integration check failed: ${e.message}`));
      // once: take back out the time counted as heating while the boiler couldn't be reached
      if (!this.repairing && !(this.rt.repairs?.unreachable >= 1)) {
        this.repairing = true;
        repairUnreachable(this).then((r) => {
          if (r?.minutes) {
            const h = Math.floor(r.minutes / 60); const m = r.minutes % 60;
            this.note(`Heating records: took out ${h ? `${h} h ${m} min` : `${m} min`} that rooms were counted as heating while the boiler couldn't be reached in Home Assistant, from the last 10 days`);
          }
        }).catch((e) => this.log(`Couldn't repair the heating records: ${e.message}`)).finally(() => { this.repairing = false; });
      }
    };
    setInterval(look, 30000);
    setTimeout(look, 20000);
    this.requestTick();
  }

  // Run a tick soon. A new request can bring the tick forward but never push it back,
  // so a sensor that reports every second can't keep postponing it.
  requestTick(delay = 800) {
    const due = Date.now() + delay;
    if (this.tickTimer && this.tickDue <= due) return;
    clearTimeout(this.tickTimer);
    this.tickDue = due;
    this.tickTimer = setTimeout(() => { this.tickTimer = null; this.tick(); }, delay);
  }

  note(msg, kind = null) {
    this.log(msg);
    this.store.addLog(msg, kind);
  }

  // ---- service calls, serialised and spaced out (Hive is a cloud API) ----
  #call(domain, service, data) {
    if (this.disabled) return this.queue; // heating is turned off in Home Control's settings
    this.queue = this.queue.then(async () => {
      try { await this.ha.callService(domain, service, data); }
      catch (e) { this.note(`Failed ${domain}.${service}${data.entity_id ? ` on ${data.entity_id}` : ''}: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 400));
    });
    return this.queue;
  }

  #name(entityId) {
    return this.ha.get(entityId)?.attributes?.friendly_name || this.lastName?.(entityId) || entityId;
  }

  // ---- target calculation ----
  // `now` can be a time to come (for predicting when a room will next need heat): a hold or boost
  // running out hands back to what was under it, and Away with an end time ends. Warming early
  // depends on the room's temperature then, so a prediction leaves it out ({ preheat: false }).
  targetFor(zone, now = Date.now(), { preheat = true } = {}) {
    const pos = localWeekPosition(new Date(now), this.ha.timeZone);
    const sched = scheduledAt(zone.schedule, pos);
    let ov = this.rt.overrides[zone.id];
    if (ov && ov.until <= now && ov.prev?.until > now) ov = ov.prev;
    if (this.rt.mode === 'off') return { temp: this.s.frostTemp, source: 'off', sched };
    const win = this.rt.windowPause?.[zone.id];
    if (win && win.until > now) return { temp: this.s.frostTemp, source: 'window', until: win.until, sched };
    if (ov && ov.until > now) return { temp: ov.temp, source: ov.kind, until: ov.until, by: ov.by, via: ov.via, forever: !!ov.forever, sched };
    if (this.rt.mode === 'away' && !(this.rt.awayUntil && this.rt.awayUntil <= now)) return { temp: this.awayTempFor(zone), source: 'away', until: this.rt.awayUntil, sched };
    if (!sched) return { temp: this.s.frostTemp, source: 'no-schedule', sched };
    const pre = preheat ? this.#preheat(zone, sched, now) : null;
    if (pre) return { temp: pre.temp, source: 'preheat', until: pre.until, readyBy: pre.readyBy, sched };
    // stop early before a drop: the lower temperature takes over a little before its time
    const ease = this.#easeOff(zone, sched);
    if (ease != null) return { temp: sched.next.temp, source: 'ease-off', until: now + sched.next.inMinutes * 60000, early: ease, sched };
    return { temp: sched.temp, source: 'schedule', sched };
  }

  /** Why a room started or stopped heating, for Activity. */
  #callNote(zone, t, current, { calling, start, stop, joined, now }) {
    const d = (x) => `${Math.round(x * 10) / 10}°`;
    const clock = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: this.ha.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
    const names = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
    const before = (this.views || []).find((v) => v.id === zone.id)?.target;
    if (calling) {
      if (current == null) return null;
      if (joined && !(current < t.temp - start)) return null; // "heating now with …" has said why
      let why;
      switch (t.source) {
        case 'preheat': {
          const mins = t.until ? Math.round((t.until - now) / 60000 / TS) : null;
          const rate = this.warmRateFor(zone, t.temp);
          why = `warming early to be ${d(t.temp)} by ${t.readyBy}: ${d(current)} now${rate ? `, and it warms about ${d(rate)} an hour` : ''}${mins != null ? `, so it started ${mins} min before` : ''}`;
          break;
        }
        case 'boost': why = `boosted to ${d(t.temp)} until ${clock(t.until)} (${d(current)} now)`; break;
        case 'hold': why = `held at ${d(t.temp)} until ${clock(t.until)} (${d(current)} now)`; break;
        case 'manual': why = `changed on ${t.by || 'the radiator'} to ${d(t.temp)} (${d(current)} now)`; break;
        case 'snooze': why = `${d(current)} is below its snooze temperature of ${d(t.temp)}`; break;
        case 'away': why = `${d(current)} is below Away's ${d(t.temp)}`; break;
        case 'off': why = `${d(current)} is below frost protection (${d(t.temp)})`; break;
        default:
          why = before != null && t.temp > before + 0.05
            ? `its schedule went up to ${d(t.temp)} (${d(current)} now)`
            : `${d(current)} fell below ${d(t.temp - start)}, where it starts (${d(t.temp)} target)`;
      }
      const others = this.zones.filter((z) => z.id !== zone.id && z.enabled && this.calling.get(z.id)).map((z) => z.name);
      const boiler = this.rt.boiler.on ? (others.length ? `. The boiler was already on for ${names(others)}` : '. The boiler was still on') : '';
      return `${zone.name}: heating, ${why}${boiler}`;
    }
    if (['ease-off', 'window'].includes(t.source)) return null; // those say why themselves
    const since = this.callSince[zone.id];
    const mins = since ? Math.max(1, Math.round((now - since.at) / 60000 / TS)) : null;
    const took = mins ? `, after ${mins} min${since.temp != null && current != null ? ` (from ${d(since.temp)})` : ''}` : '';
    if (current == null) return `${zone.name}: stopped heating, no temperature reading${took}`;
    if (t.source === 'off') return `${zone.name}: stopped heating, the heating is off${took}`;
    // warming early, and warm already: ready for the scheduled time
    const was = (this.views || []).find((v) => v.id === zone.id);
    if (was?.source === 'preheat' && current >= was.target - (was.stopMargin ?? 0) - 0.05) {
      return `${zone.name}: warm enough at ${d(current)}, ready for ${d(was.target)} by ${was.readyBy}${took}`;
    }
    if (before != null && t.temp < before - 0.05) return `${zone.name}: stopped heating, its target went down to ${d(t.temp)}${took}`;
    return stop > 0.05
      ? `${zone.name}: warm enough at ${d(current)}, stopping ${d(stop)} early so the radiators' leftover heat takes it to ${d(t.temp)}${took}`
      : `${zone.name}: reached ${d(current)} (${d(t.temp)} target)${took}`;
  }

  /** How fast a room loses heat (share of the gap to outside per hour): measured, corrected by how its predictions have done. */
  lossRate(zone) {
    const own = this.model?.k?.[zone.id];
    const k = own ?? this.model?.houseK ?? null;
    if (k == null) return null;
    return k * (this.predictionLog?.scaleFor(zone.id) ?? 1);
  }

  /**
   * Stop early before a drop: how many minutes before a scheduled drop from `temp` the room can
   * stop heating and still lose no more than the set amount by then (null: not on, or the room's
   * heat loss isn't known yet).
   */
  easeOffMinutes(zone, temp, { out = this.outsideNow(), always = false } = {}) {
    const e = this.s.easeOff;
    if ((!e?.enabled && !always) || temp == null) return null;
    const k = this.lossRate(zone);
    if (!k) return null;
    const drop = Number(e.drop) || 0.5;
    const max = Number(e.maxMinutes) || 60;
    // a mild day (outside close to the room): it hardly cools, so the longest
    if (out == null || temp - drop - out <= 0.3) return max;
    return Math.min(max, Math.round((Math.log((temp - out) / (temp - drop - out)) / k) * 60));
  }

  #easeOff(zone, sched) {
    if (!this.s.easeOff?.enabled || !sched?.next || sched.next.temp >= sched.temp) return null;
    const mins = this.easeOffMinutes(zone, sched.temp);
    return mins != null && sched.next.inMinutes <= mins ? mins : null;
  }

  // ---- outside temperature (for warm-up predictions) ----
  outsideNow() {
    const id = this.s.outsideEntity || detectOutsideEntity(this.ha);
    return id ? readOutside(this.ha, id) : null;
  }

  // ---- warm by the scheduled time ----
  // Predicted warm-up speed (°/hour) for a room, scaled for how cold it is outside
  // compared with the conditions it was learned in.
  warmRateFor(zone, target, out = this.outsideNow()) {
    const w = this.rt.warm?.[zone.id];
    if (!w?.rate || !w.samples) return null;
    if (out == null || w.gap == null) return w.rate;
    const gap = Math.max(2, target - out);
    return w.rate * Math.min(1.5, Math.max(0.6, w.gap / gap));
  }

  #preheat(zone, sched, now) {
    const p = this.s.preheat || {};
    if (!p.enabled || !sched?.next || sched.next.temp <= sched.temp) return null;
    const current = this.currentTemp(zone);
    if (current == null) return null;
    if (sched.next.temp - current <= 0.1) return null;
    const lead = this.preheatLead(zone, sched.next.temp, current);
    if (lead == null || sched.next.inMinutes > lead) return null;
    return { temp: sched.next.temp, until: now + sched.next.inMinutes * 60000, readyBy: sched.next.time };
  }

  /** Minutes a room needs to warm from `from` to `to` (at most the setting's limit), or null if it hasn't learned. */
  preheatLead(zone, to, from, out = this.outsideNow()) {
    const p = this.s.preheat || {};
    if (!p.enabled) return null;
    const rate = this.warmRateFor(zone, to, out);
    if (!rate) return null;
    return Math.min(Number(p.maxMinutes) || 120, ((to - from) / rate) * 60 + 10);
  }

  // ---- when each room next needs heat, so when the boiler next fires ----
  #nextFor(zone, v, views, now) {
    if (!zone.enabled || v.current == null) return null;
    if (v.calling) {
      // its stop point as time goes on: the schedule (or a boost ending) can lower it
      const stopAt = (t) => {
        const target = v.source === 'preheat' && t < (v.until || 0) ? v.target : this.targetFor(zone, t, { preheat: false }).temp;
        return target - this.heatMarginFor(zone, target, this.callSince[zone.id]?.temp ?? v.current);
      };
      const h = heatingUntil({ now, current: v.current, stopAt, rate: v.warmRate });
      return { heating: true, until: h ? toFive(h.at) : null, warm: h ? h.warm : null, temp: h?.temp ?? null, path: h?.path || null };
    }
    // an always-open radiator is warming whenever the boiler runs for another room
    if (this.openRadiator(zone) && views.some((o) => o.id !== zone.id && o.enabled && o.calling)) return { withOthers: true };
    const own = this.model?.k?.[zone.id];
    const k = this.lossRate(zone);
    const c = this.rt.coast?.[zone.id];
    // still warming from its leftover heat: held up while that lasts (20 minutes after its last rise)
    const settleUntil = v.coasting && c?.peakAt ? c.peakAt + 20 * 60000 * TS : 0;
    const r = nextHeat({
      now, current: v.current, k, settleUntil,
      outsideAt: outsideCurve(this.outsideForecast, this.outsideNow(), now),
      targetAt: (t) => this.targetFor(zone, t, { preheat: false }),
      startGapFor: () => this.startGap(),
      leadFor: (to, from, out) => this.preheatLead(zone, to, from, out),
    });
    return {
      at: r.at ? toFive(r.at) : null, exact: r.at, reason: r.reason, target: r.target ?? null, threshold: r.threshold ?? null,
      readyBy: r.readyBy ?? null, riseAt: r.riseAt ?? null, temp: r.temp ?? null,
      basis: own != null ? 'room' : k != null ? 'house' : 'none', k, settleUntil, path: r.path,
    };
  }

  // Fire rooms together: while the boiler runs for a room, start any room that would need heat
  // within the set minutes (and is below the point it stops at), so the boiler runs once, not twice.
  #together(views, now) {
    const set = this.s.together;
    if (!set?.enabled) return;
    const firing = views.filter((v) => v.enabled && v.calling && !this.joined[v.id]);
    if (!firing.length) return;
    const names = firing.map((v) => v.name);
    let added = false;
    for (const v of views) {
      const n = v.next;
      if (!v.enabled || v.calling || v.coasting || this.joined[v.id] || !n?.at || v.current == null) continue;
      if (!['cooling', 'preheat'].includes(n.reason) || n.at - now > (Number(set.minutes) || 30) * 60000) continue;
      const zone = this.zones.find((z) => z.id === v.id);
      const target = n.reason === 'preheat' ? n.target : v.target;
      if (v.current >= target - this.heatMarginFor(zone, target, v.current) - 0.05) continue; // nothing to gain: it's above where it would stop
      this.joined[v.id] = { at: now, with: names, reason: n.reason, target, readyBy: n.readyBy, until: n.riseAt, due: n.at };
      const due = new Intl.DateTimeFormat('en-GB', { timeZone: this.ha.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(n.at));
      this.note(`${v.name}: heating now with ${names.join(' and ')}, as it would have needed heat at about ${due}, so the boiler runs once`, 'room');
      added = true;
    }
    if (added) this.requestTick(300);
  }

  #forecast(views, now) {
    for (const v of views) {
      const zone = this.zones.find((z) => z.id === v.id);
      const others = this.openRadiator(zone) && views.some((o) => o.id !== v.id && o.enabled && o.calling);
      const key = [v.calling, v.target, v.source, v.current, v.stopAt, others, this.model?.at, this.outsideForecastAt, this.settingsAt].join('|');
      const c = this.nextCache[v.id];
      if (c && c.key === key && now - c.at < 60000) { v.next = c.value; continue; }
      let value = null;
      try { value = this.#nextFor(zone, v, views, now); } catch (e) { this.log(`${v.name}: couldn't work out when it next needs heat: ${e.message}`); }
      this.nextCache[v.id] = { at: now, key, value };
      v.next = value;
      // kept to check against what happens (Insights → How good the predictions are)
      if (value && !value.heating && !value.withOthers) this.predictionLog?.note(v.id, now, value, { current: v.current, outside: this.outsideNow(), source: v.source });
    }
    this.predictionLog?.sweep(now, views);
    this.#together(views, now);
    const upcoming = views.filter((v) => v.enabled && v.next?.at).sort((a, b) => a.next.at - b.next.at);
    const first = upcoming[0];
    this.boilerNext = !this.rt.boiler.on && first
      ? { at: first.next.at, rooms: upcoming.filter((v) => v.next.at - first.next.at <= 10 * 60000).map((v) => v.name) }
      : null;
    const heating = views.filter((v) => v.enabled && v.calling);
    this.boilerUntil = this.rt.boiler.on && heating.length && heating.every((v) => v.next?.until)
      ? Math.max(...heating.map((v) => v.next.until)) : null;
  }

  // Learn warm-up speed from each heat-up that lasted at least 20 minutes.
  #trackWarm(zone, wasCalling, calling, current, target, now) {
    const s = this.heatSess[zone.id];
    if (!wasCalling && calling && current != null) {
      this.heatSess[zone.id] = { at: now, temp: current, outside: this.outsideNow(), target };
      return;
    }
    if (!s) return;
    if (target !== s.target && calling) { s.target = target; return; } // e.g. preheat handing over to the schedule: same heat-up
    if (wasCalling && !calling) {
      delete this.heatSess[zone.id];
      const mins = (now - s.at) / 60000;
      const rise = current - s.temp;
      if (mins < 20 * TS || rise < 0.3 || current == null) return;
      const rate = rise / (mins / 60) * TS; // °/hour (scaled back to real time in tests)
      const gap = s.outside != null ? target - s.outside : null;
      const W = (this.rt.warm ||= {});
      const w = W[zone.id] || { rate: null, gap: null, samples: 0, history: [] };
      w.rate = w.rate == null ? rate : 0.7 * w.rate + 0.3 * rate;
      if (gap != null) w.gap = w.gap == null ? gap : 0.7 * w.gap + 0.3 * gap;
      w.rate = Math.round(w.rate * 100) / 100;
      if (w.gap != null) w.gap = Math.round(w.gap * 10) / 10;
      w.samples += 1;
      w.history = [...(w.history || []), { at: now, rate: Math.round(rate * 100) / 100, minutes: Math.round(mins / TS), rise: Math.round(rise * 10) / 10, outside: s.outside }].slice(-10);
      W[zone.id] = w;
      this.store.save();
    }
  }

  // ---- open window detection ----
  #trackWindow(zone, current, now) {
    if (current == null) return;
    const h = this.tempHist.get(zone.id) || [];
    if (!h.length || h[h.length - 1].v !== current || now - h[h.length - 1].t > 60000) h.push({ t: now, v: current });
    const w = this.s.window || {};
    const span = (Number(w.minutes) || 10) * 60000 * TS;
    while (h.length && now - h[0].t > span) h.shift();
    this.tempHist.set(zone.id, h);
    if (!w.enabled || this.rt.mode === 'off') return;
    if (this.#snoozeUnder(zone.id, now)) return; // a snoozed room is meant to cool down
    const P = (this.rt.windowPause ||= {});
    const cur = P[zone.id];
    if (cur && cur.until > now) return;
    if (cur && now - cur.until < 30 * 60000 * TS) return; // cooling-off after a pause
    const peak = Math.max(...h.map((x) => x.v));
    const drop = Math.round((peak - current) * 10) / 10;
    if (drop >= (Number(w.drop) || 1)) {
      const until = now + (Number(w.pauseMinutes) || 20) * 60000 * TS;
      P[zone.id] = { at: now, until, from: peak, to: current };
      this.tempHist.set(zone.id, [{ t: now, v: current }]);
      this.store.save();
      const took = Math.round((now - h[0].t) / 60000 / TS);
      this.note(`${zone.name}: dropped ${drop}° in ${took < 1 ? 'under a minute' : `${took} min`}, window open? Heating paused until ${this.#fmtTime(until)}`);
      this.requestTick(100); // apply the pause straight away
      this.#alert('window', [], null, false, { room: zone.name, drop, until });
    }
  }

  resumeWindow(zoneId) {
    const z = this.zones.find((x) => x.id === zoneId);
    if (this.rt.windowPause?.[zoneId]) {
      this.rt.windowPause[zoneId].until = Date.now();
      this.store.save();
      if (z) this.note(`${z.name}: heating resumed (window closed)`);
    }
    this.requestTick(100);
  }

  // ---- away automatically ----
  presenceView(all = false) {
    const p = this.s.presence || {};
    const people = [...this.ha.states.values()].filter((s) => s.entity_id.startsWith('person.'));
    const chosen = !all && p.people?.length ? people.filter((s) => p.people.includes(s.entity_id)) : people;
    const home = this.ha.get('zone.home')?.attributes;
    const miles = (a) => {
      if (!home || a?.latitude == null || a?.longitude == null) return null;
      const R = 3958.8, rad = Math.PI / 180;
      const dLat = (a.latitude - home.latitude) * rad, dLon = (a.longitude - home.longitude) * rad;
      const x = Math.sin(dLat / 2) ** 2 + Math.cos(home.latitude * rad) * Math.cos(a.latitude * rad) * Math.sin(dLon / 2) ** 2;
      return Math.round(2 * R * Math.asin(Math.sqrt(x)) * 10) / 10;
    };
    return chosen.map((s) => ({
      entity_id: s.entity_id, name: s.attributes?.friendly_name || s.entity_id, state: s.state,
      home: s.state === 'home', miles: s.state === 'home' ? 0 : miles(s.attributes),
    }));
  }

  #presence(now) {
    const p = this.s.presence || {};
    if (!p.enabled) return;
    const people = this.presenceView();
    if (!people.length) return;
    const st = (this.rt.presence ||= { emptySince: null, suppress: false });
    const near = Number(p.nearMiles) || 2;
    const back = people.find((x) => x.home) || people.find((x) => x.miles != null && x.miles <= near);
    if (back) {
      st.emptySince = null;
      st.suppress = false;
      if (this.rt.mode === 'away' && this.rt.presenceAway) {
        this.setMode('auto', null, { by: 'presence', why: back.home ? `${back.name} is home` : `${back.name} is ${back.miles} miles away` });
      }
      return;
    }
    if (st.emptySince == null) { st.emptySince = now; this.store.save(); }
    const waited = now - st.emptySince >= (Number.isFinite(Number(p.delayMinutes)) ? Number(p.delayMinutes) : 15) * 60000 * TS;
    if (waited && this.rt.mode === 'auto' && !st.suppress) {
      this.setMode('away', null, { by: 'presence', why: 'everyone is out' });
    }
  }

  // ---- the heating's come on with everyone out: ask the phones ----
  // Asked once while everyone's out (again after someone's been home), and only when nothing else
  // is about to deal with it: not while Away automatically is waiting to switch to Away itself, nor
  // when someone's on their way home, nor for a boost or hold someone asked for.
  #emptyCfg() {
    const c = this.s.notify?.empty || {};
    return { enabled: !!c.enabled, services: Array.isArray(c.services) ? c.services : [], minutes: Number(c.minutes) || 120 };
  }

  #askIfEmpty(calling, now) {
    const cfg = this.#emptyCfg();
    if (!cfg.enabled || !cfg.services.length || this.rt.mode !== 'auto') return;
    const p = this.s.presence || {};
    const people = this.presenceView();
    if (!people.length || people.some((x) => x.home)) return;
    const near = Number(p.nearMiles) || 2;
    if (people.some((x) => x.miles != null && x.miles <= near)) return; // someone's on the way home
    if (p.enabled && !this.rt.presence?.suppress) return; // Away automatically will switch to Away itself
    if (this.rt.emptyAsk) return; // asked already while everyone's been out
    const asked = ['boost', 'hold', 'manual'];
    if (calling.length && calling.every((v) => asked.includes(v.source))) return; // someone wanted this
    const nonce = Math.random().toString(36).slice(2, 8);
    this.rt.emptyAsk = { nonce, at: now };
    this.store.save();
    const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
    const rooms = calling.map((v) => v.name);
    const hours = cfg.minutes === 60 ? '1 hour' : `${cfg.minutes / 60} hours`;
    const message = `The boiler's come on${rooms.length ? ` for ${list(rooms)}` : ''}, but no one's home. Turn the heating off?`;
    this.#sendEmpty('Heating on, everyone\'s out', message, [
      { action: `HC_HEAT_FOR_${nonce}`, title: `Off for ${hours}` },
      { action: `HC_HEAT_HOME_${nonce}`, title: 'Off until we\'re back' },
      { action: `HC_HEAT_NEAR_${nonce}`, title: 'Off until we\'re nearly home' },
    ]);
    this.note(`Heating on with everyone out: asked ${cfg.services.join(', ')} whether to turn it off`);
  }

  #sendEmpty(title, message, actions = null) {
    for (const svc of this.#emptyCfg().services) {
      const [, service] = svc.split('.');
      this.#call('notify', service, { title, message, data: { tag: 'home-control-empty', group: 'heating-control', ...(actions ? { actions } : {}) } });
    }
  }

  /** A button pressed on the phone alert: Away for a while, until someone's home, or until someone's nearly home. */
  phoneAction(action) {
    const m = /^HC_HEAT_(FOR|HOME|NEAR)_(\w+)$/.exec(String(action || ''));
    if (!m) return false;
    const ask = this.rt.emptyAsk;
    // only the latest question, and not one from long ago
    if (!ask || ask.nonce !== m[2] || Date.now() - ask.at > 12 * 3600000) { this.note('An old "everyone\'s out" alert was answered: nothing changed'); return false; }
    const near = Number(this.s.presence?.nearMiles) || 2;
    if (m[1] === 'FOR') {
      const until = Date.now() + this.#emptyCfg().minutes * 60000;
      this.setMode('away', until, { by: 'phone', why: 'from the phone alert, everyone out' });
      this.#sendEmpty('Heating off', `Away until ${this.#fmtTime(until)}, then back to the schedules.`);
    } else {
      this.setMode('away', null, { by: 'phone', why: `from the phone alert, until someone's ${m[1] === 'HOME' ? 'home' : 'nearly home'}` });
      this.rt.awayBack = m[1] === 'HOME' ? 'home' : 'near';
      this.store.save();
      this.#sendEmpty('Heating off', m[1] === 'HOME' ? 'Away until someone\'s home, then back to the schedules.' : `Away until someone's within ${near} miles of home, then back to the schedules.`);
    }
    ask.answered = { action: m[1], at: Date.now() };
    this.store.save();
    this.emit('change');
    return true;
  }

  /** Away "until we're back": back to the schedules when someone's home (or nearly). Also, once someone's
   *  been home, the "everyone's out" question can be asked again. */
  #awayBack(now) {
    const people = this.presenceView();
    if (!people.length) return;
    const home = people.find((x) => x.home);
    if (home && this.rt.emptyAsk) { this.rt.emptyAsk = null; this.store.save(); }
    if (this.rt.mode !== 'away' || !this.rt.awayBack) return;
    const near = Number(this.s.presence?.nearMiles) || 2;
    const back = home || (this.rt.awayBack === 'near' ? people.find((x) => x.miles != null && x.miles <= near) : null);
    if (back) this.setMode('auto', null, { by: 'presence', why: back.home ? `${back.name} is home` : `${back.name} is ${back.miles} miles away` });
  }

  // ---- needs attention ----
  batteryFor(climateId) {
    const a = this.ha.get(climateId)?.attributes || {};
    const own = num(a.battery ?? a.battery_level);
    if (own != null) return own;
    const id = this.ha.companionFor?.(climateId, (e, st) => e.startsWith('sensor.') && (st.attributes?.device_class === 'battery' || /battery/i.test(e)));
    return id ? num(this.ha.get(id)?.state) : null;
  }

  #computeAttention(views, now) {
    const out = [];
    // the integration behind the devices isn't working (Hive, say): first, and instead of each device's own notice
    for (const p of this.integrations.problems()) {
      out.push({ key: `integration-${p.key}`, text: p.text, href: `/config/integrations/integration/${p.domain}`, hrefText: `Open ${p.name} in Home Assistant` });
    }
    const covered = (id) => this.integrations.covers(id);
    const mins = (ms) => Math.round(ms / 60000 / TS);
    for (const v of views) {
      if (!v.enabled) continue;
      const cs = this.callSince[v.id];
      if (v.heating && cs && now - cs.at > 60 * 60000 * TS && v.current != null && v.current - cs.temp < 0.2) {
        out.push({ key: `stuck-${v.id}`, room: v.name, text: `${v.name} has been calling for heat for ${mins(now - cs.at)} min without warming (${cs.temp}° then, ${v.current}° now). Check its radiator is getting hot and the valve isn't stuck.` });
      }
      for (const t of v.trvs) {
        if (t.role === 'boiler') continue;
        if (!t.available && !covered(t.entity_id)) out.push({ key: `off-${t.entity_id}`, room: v.name, text: `${t.name} is offline. Check its batteries, or that it's in range of its hub.` });
        const b = this.batteryFor(t.entity_id);
        if (b != null && b <= 20) out.push({ key: `bat-${t.entity_id}`, room: v.name, text: `${t.name} battery is at ${Math.round(b)}%. Replace it soon.` });
      }
    }
    // a room losing heat faster than usual (heatloss.js)
    // (unless it's been dismissed: hidden until it's back to normal)
    for (const h of this.heatLoss?.elevated?.() || []) {
      if (h.dismissed) continue;
      const v = views.find((x) => x.id === h.id && x.enabled);
      if (v) out.push({ key: `loss-${v.id}`, room: v.name, dismiss: `heatloss/${v.id}`, text: `${v.name} has been losing heat at least ${h.percent}% faster than usual over the last two days, allowing for the weather${h.windMatched ? ' and the wind' : ''}. Check for a window or trickle vent left open, or a new draught.` });
    }
    const b = this.s.boiler;
    if (b.entity) {
      const st = this.ha.get(b.entity);
      if (!st || UNAVAILABLE.has(st.state)) { if (!covered(b.entity)) out.push({ key: 'boiler-offline', text: `${this.#name(b.entity)} (boiler control) is offline, so the boiler can't be fired. Check the Hive hub and receiver.` }); }
      else {
        const askedSince = Math.max(this.rt.boiler.lastSwitch || 0, this.startedAt);
        if (b.entity.startsWith('climate.') && this.rt.boiler.on && st.attributes?.hvac_action != null && st.attributes.hvac_action !== 'heating'
          && now - askedSince > 10 * 60000 * TS) {
          out.push({ key: 'boiler-silent', text: `The boiler was asked to fire ${mins(now - askedSince)} min ago, but ${this.#name(b.entity)} isn't reporting that it's heating. Hive may be slow or offline.` });
        }
      }
    }
    this.attention = out;
  }

  currentTemp(zone) {
    if (zone.sensor) {
      const st = this.ha.get(zone.sensor);
      const v = st && !UNAVAILABLE.has(st.state) ? num(st.state) : null;
      if (v != null) return v;
    }
    const vals = (zone.trvs || [])
      .map((e) => num(this.ha.get(e)?.attributes?.current_temperature))
      .filter((v) => v != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  }

  // ---- housekeeping ----
  #expire(now) {
    let changed = false;
    const endedBoost = [];
    for (const [id, ov] of Object.entries(this.rt.overrides)) {
      if (!ov || ov.until <= now) {
        const z = this.zones.find((x) => x.id === id);
        const prev = ov?.prev && ov.prev.until > now ? ov.prev : null;
        if (prev) this.rt.overrides[id] = prev; else delete this.rt.overrides[id];
        if (ov?.group === 'house') endedBoost.push(z?.name);
        else if (z) this.note(`${z.name}: ${ov?.kind || 'override'} ended, back to ${prev?.kind === 'snooze' ? 'its snooze' : prev ? 'its earlier setting' : 'schedule'}`);
        changed = true;
      }
    }
    if (endedBoost.length) this.note(`House boost ended, ${endedBoost.length} room${endedBoost.length === 1 ? '' : 's'} back to what they were doing before`);
    if (this.rt.houseBoost && this.rt.houseBoost.until <= now) { this.rt.houseBoost = null; changed = true; }
    for (const [id, w] of Object.entries(this.rt.windowPause || {})) {
      if (w.until <= now && !w.ended) {
        w.ended = true;
        const z = this.zones.find((x) => x.id === id);
        if (z) this.note(`${z.name}: window pause over, heating back to normal`);
        changed = true;
      }
    }
    if (this.rt.mode === 'away' && this.rt.awayUntil && this.rt.awayUntil <= now) {
      this.rt.modeLog = recordMode(this.modeLog(), 'auto', this.rt.awayUntil);
      this.rt.mode = 'auto';
      this.rt.awayUntil = null;
      this.note('Away mode ended, back to schedules');
      changed = true;
    }
    if (changed) this.store.save();
  }

  // ---- main loop ----
  async tick() {
    // turned off in Home Control's settings: something else looks after the heating
    if (this.disabled) { this.views = []; this.emit('change'); return; }
    const now = Date.now();
    this.#expire(now);
    const next = Math.min(...Object.values(this.rt.overrides).map((o) => o.until), Infinity);
    if (next - now < 30000) { clearTimeout(this.expiryTimer); this.expiryTimer = setTimeout(() => this.tick(), Math.max(200, next - now + 50)); }
    if (this.ha.connected) { this.#presence(now); this.#awayBack(now); }
    const views = [];
    for (const zone of this.zones) views.push(this.#runZone(zone, now));
    this.#forecast(views, now);
    this.views = views;
    if (this.ha.connected) await this.#runBoiler(views, now);
    this.#computeAttention(views, now);
    this.dailyLog?.sample(now, this, views);
    // the call log is what really heated: not while the boiler or radiators couldn't be reached
    this.callLog?.update(views.map((v) => (v.calling && !v.heating ? { ...v, calling: false } : v)), now);
    this.emit('change');
  }

  #runZone(zone, now) {
    let t = this.targetFor(zone, now);
    const current = this.currentTemp(zone);
    const warnings = [];
    const known = this.calling.has(zone.id); // not the first look since the app started
    const wasCalling = this.calling.get(zone.id) || false;
    let calling = wasCalling;
    // fire rooms together: a room started early with another warms early to its next temperature
    let j = this.joined[zone.id];
    if (j && (now - j.at > 3 * 3600000 || !this.s.together?.enabled)) { delete this.joined[zone.id]; j = null; }
    if (j?.reason === 'preheat' && t.source === 'schedule' && j.until > now && j.target > t.temp) {
      t = { temp: j.target, source: 'preheat', until: j.until, readyBy: j.readyBy, sched: t.sched };
    }
    // the room's stop-early margin (learned, a fixed % or the house's), and this heat-up's share of it
    const margin = this.stopMarginFor(zone, t.temp);
    const from = wasCalling ? (this.callSince[zone.id]?.temp ?? current) : current;
    const stop = current == null ? margin : this.heatMarginFor(zone, t.temp, from);
    const gap = this.startGap();
    // just stopped early and still rising on leftover heat: not again until that's done
    const coasting = !!zone.enabled && !wasCalling && this.coastingUp(zone, t.temp, current, now);
    const start = coasting ? Infinity : gap;
    if (!zone.enabled) {
      calling = false;
    } else if (current == null) {
      calling = false;
      warnings.push('No temperature reading');
    } else if (wasCalling) {
      calling = current < t.temp - stop; // heating: until this heat-up's stop point
    } else if (current < t.temp - start) {
      calling = true; // (a heat-up starting here always stops at least 0.2° higher)
    } else if (j && current < t.temp - stop) {
      calling = true; // below its stop point and due soon: starting now, with the room the boiler's on for
    }
    if (!calling && j) { delete this.joined[zone.id]; j = null; }
    if (calling !== wasCalling && zone.enabled) {
      this.log(`${zone.name}: ${calling ? 'calling for heat' : 'satisfied'} (${current}° vs ${t.temp}°, stops at ${Math.round((t.temp - stop) * 10) / 10}°)`);
      if (!calling && t.source === 'ease-off') {
        const next = t.sched?.next;
        this.note(`${zone.name}: stopped heating ${t.early} min before its drop to ${next?.temp}° at ${next?.time}, as the radiators' leftover heat carries it`, 'room');
      }
      // every room starting or stopping, and why, in Activity (not only when the boiler itself switches)
      // (not just after the app has started: a room already heating then isn't news)
      const why = known ? this.#callNote(zone, t, current, { calling, start, stop, joined: !!j, now }) : null;
      if (why) this.note(why, 'room');
      // check how the prediction made earlier did (not for starts someone asked for, or started early with another room)
      if (calling) this.predictionLog?.started(zone.id, now, { forced: !!j && !(current < t.temp - start), source: t.source });
    }
    this.calling.set(zone.id, calling);
    // calling for heat isn't heating if the boiler or its radiators can't be reached (Hive down):
    // it isn't counted, learned from or checked as a heat-up until it really can heat
    const wasReal = this.heatingReal.get(zone.id) || false;
    const real = calling && !!zone.enabled && this.canHeat(zone);
    this.heatingReal.set(zone.id, real);
    if (calling && !real) delete this.heatSess[zone.id]; // a heat-up cut short like this teaches nothing
    if (zone.enabled) {
      this.#trackCoast(zone, wasReal, real, current, t.temp, now, { stop, margin });
      if (t.source !== 'window') this.#trackWarm(zone, wasReal, real, current, t.temp, now);
      this.#trackWindow(zone, current, now);
      if (real && !wasReal) this.callSince[zone.id] = { at: now, temp: current };
      if (!real) delete this.callSince[zone.id];
    }
    if (zone.enabled) this.targetLog?.record(zone.id, t.temp, now);

    const trvs = (zone.trvs || []).map((e) => {
      const st = this.ha.get(e);
      const available = !!st && !UNAVAILABLE.has(st.state);
      if (!available) warnings.push(`${this.#name(e)} unavailable`);
      const isBoiler = e === this.s.boiler.entity;
      // While the room isn't calling, turn the valve down to the stop point so it closes
      // too (otherwise it stays open whenever the boiler fires for another room).
      const lowered = !calling && margin > 0 && !['off', 'window'].includes(t.source) && t.temp > this.s.frostTemp;
      const valveTarget = lowered ? t.temp - Math.max(margin, gap) : t.temp;
      if (zone.enabled && available && this.ha.connected && !isBoiler) this.#driveTrv(e, st, valveTarget, now);
      return {
        entity_id: e,
        role: isBoiler ? 'boiler' : 'trv',
        name: this.#name(e),
        available,
        mode: st?.state,
        current: num(st?.attributes?.current_temperature),
        target: num(st?.attributes?.temperature),
        action: st?.attributes?.hvac_action || null,
        childLock: this.#childLockView(e),
      };
    });

    // where it stops: this heat-up's point, where it stopped (warming from leftover heat), or where
    // the next heat-up would stop (from its start point)
    const c = this.rt.coast?.[zone.id];
    const stopShown = calling ? stop : coasting && c ? t.temp - c.stoppedAt : this.heatMarginFor(zone, t.temp, t.temp - gap);
    return {
      stopAt: Math.round((t.temp - stopShown) * 10) / 10,
      readyBy: t.readyBy || null,
      warm: this.rt.warm?.[zone.id] || null,
      warmRate: this.warmRateFor(zone, t.temp),
      windowPause: t.source === 'window' ? this.rt.windowPause[zone.id] : null,
      stopMargin: Math.round(stopShown * 100) / 100,
      margin: Math.round(margin * 100) / 100, // its stop-early margin for a full heat-up
      stopMode: this.stopModeFor(zone),
      coast: this.rt.coast?.[zone.id] || null,
      learn: this.rt.learn?.[zone.id] || null,
      coasting,
      heating: real,                // calling, and really able to heat
      blocked: calling && !real,    // wants heat, but the boiler or its radiators can't be reached
      openRadiator: this.openRadiator(zone),
      awayTemp: this.awayTempFor(zone), awayOwn: zone.awayTemp != null,
      openRadiatorSet: zone.openRadiator === true || zone.openRadiator === false,
      // below its target but not heating: it starts again under startAt (so the boiler doesn't flick on and off)
      waiting: !!zone.enabled && !calling && current != null && current < t.temp && !['off', 'window'].includes(t.source),
      startAt: Math.round((t.temp - gap) * 10) / 10,
      startGap: Math.round(gap * 100) / 100,
      joined: j && calling ? { with: j.with, due: j.due, at: j.at } : null,
      early: t.early ?? null, // easing off: minutes before the drop it stopped
      // for Settings: how early it would stop before its next drop, on or off
      easeOffMinutes: t.sched?.next && t.sched.next.temp < t.sched.temp ? this.easeOffMinutes(zone, t.sched.temp, { always: true }) : null,
      id: zone.id, name: zone.name, icon: zone.icon || 'room', enabled: zone.enabled,
      current, target: t.temp, source: t.source, until: t.until || null, by: t.by || null, via: t.via || null, forever: !!t.forever,
      snoozedUnder: this.#snoozeUnder(zone.id, now) ? true : false,
      scheduled: t.sched, calling, trvs, sensor: zone.sensor || null, warnings,
    };
  }

  // After heating stops, watch how far the room keeps rising (leftover radiator heat), for up to
  // an hour (a rise after that isn't the radiators). The result teaches it how early to stop.
  #trackCoast(zone, wasCalling, calling, current, target, now, { stop = 0, margin = stop } = {}) {
    const rt = (this.rt.coast ||= {});
    const c = rt[zone.id];
    if (wasCalling && !calling && current != null) {
      const since = this.callSince[zone.id];
      rt[zone.id] = {
        target, stoppedAt: current, margin: stop, full: margin, from: since?.temp ?? null,
        peak: current, peakAt: now, at: now,
        heatedFor: this.heatStart?.[zone.id] ? Math.round((now - this.heatStart[zone.id]) / 60000 / TS) : null, done: false,
      };
      this.store.save();
      return;
    }
    if (!wasCalling && calling) (this.heatStart ||= {})[zone.id] = now;
    if (!c || c.done) return;
    if (target !== c.target) { c.done = true; c.discard = 'target changed'; this.store.save(); return; }
    // a radiator that's always open keeps getting heat while the boiler runs for other rooms:
    // that rise isn't this room's own leftover heat, so it mustn't teach it to stop earlier
    if (!calling && this.openRadiator(zone) && (this.views || []).some((v) => v.id !== zone.id && v.enabled && v.calling)) {
      c.done = true; c.discard = 'heated with other rooms'; this.store.save(); return;
    }
    if (!calling && current != null && current > c.peak && now - c.at <= 60 * 60000 * TS) { c.peak = current; c.peakAt = now; this.store.save(); }
    const pastPeak = current != null && current <= c.peak - 0.2 && now - c.peakAt > 10 * 60000 * TS;
    const timedOut = now - c.at > 90 * 60000 * TS;
    if (pastPeak || timedOut || calling) {
      c.done = true;
      if (calling && !pastPeak && c.peak <= c.stoppedAt + 0.05 && now - c.at < 20 * 60000 * TS) c.discard = 'heating restarted too soon';
      if (!c.discard) { const why = this.#notLeftoverHeat(c); if (why) c.discard = why; }
      if (!c.discard) this.#learn(zone, c, now);
      this.store.save();
    }
  }

  /**
   * A rise after the heat went off that can't be the radiators' leftover heat (a shower, people,
   * the sun, another heater): more than it rose while heating, or faster. Not learned from.
   */
  #notLeftoverHeat(c) {
    const rise = c.peak - c.stoppedAt;
    if (c.from == null || rise < 0.3) return null;
    const heated = c.stoppedAt - c.from;
    if (rise > Math.max(0.5, heated)) return 'it rose more after the heat went off than while heating, so something else warmed it (a shower, people, the sun)';
    const mins = (c.peakAt - c.at) / 60000 / TS;
    if (c.heatedFor >= 10 && heated > 0 && mins > 0 && rise / mins > 1.5 * (heated / c.heatedFor)) return 'it warmed faster after the heat went off than while heating, so something else warmed it (a shower, people, the sun)';
    return null;
  }

  // One step of learning per heat-up: nudge the margin by half the overshoot (or undershoot),
  // at most 0.3° per cycle, kept between 0 and 1.5°. A small heat-up (stopped less early than the
  // full margin) only teaches it to stop less early: if even that much leftover heat didn't come.
  #learn(zone, c, now) {
    const L = (this.rt.learn ||= {});
    const cur = L[zone.id] || { margin: Math.max(0, Number(this.s.stopEarly) || 0), cycles: 0, history: [] };
    const err = Math.round((c.peak - c.target) * 100) / 100;
    const small = c.full != null && c.margin < c.full - 0.01;
    let step = 0.5 * err;
    if (Math.abs(err) < 0.1 || (small && err > 0)) step = 0; // close enough, or a small heat-up's overshoot: leave it
    step = Math.max(-0.3, Math.min(0.3, step));
    const margin = Math.round(Math.max(0, Math.min(1.5, (c.full ?? c.margin ?? cur.margin) + step)) * 20) / 20;
    cur.history = [...(cur.history || []), { at: now, target: c.target, from: c.from ?? null, stoppedAt: c.stoppedAt, peak: c.peak, err, margin }].slice(-12);
    cur.cycles = (cur.cycles || 0) + 1;
    const changed = Math.abs(margin - cur.margin) >= 0.05;
    cur.margin = margin;
    cur.updated = now;
    L[zone.id] = cur;
    if (this.stopModeFor(zone) === 'auto' && changed) {
      this.note(`${zone.name}: ${err > 0 ? `overshot by ${err}°` : `stopped ${Math.abs(err)}° short`}, now stops ${margin.toFixed(2).replace(/0$/, '')}° early`);
    }
  }

  resetLearning(zoneId) {
    const z = this.zones.find((x) => x.id === zoneId);
    if (!z) throw new Error('Unknown room');
    if (this.rt.learn) delete this.rt.learn[zoneId];
    if (this.rt.coast) delete this.rt.coast[zoneId];
    this.store.save();
    this.note(`${z.name}: forgot what it had learned about its radiators`);
    this.requestTick(100);
  }

  #remember(entity, now, ...temps) {
    const grace = this.s.commandGraceSeconds * 1000;
    // one entry per value (a repeat refreshes it), so a burst of commands, such as a nudge,
    // "Back to schedule" and a house boost within seconds, can't push an earlier value out
    // before Hive's late report of it arrives
    const list = (this.recent.get(entity) || []).filter((r) => now - r.at < grace && !temps.includes(r.temp));
    for (const t of new Set(temps)) if (t != null) list.push({ temp: t, at: now });
    this.recent.set(entity, list.slice(-16));
  }

  #childLockView(trv) {
    const id = this.ha.childLockFor(trv);
    if (!id) return null;
    const st = this.ha.get(id);
    const on = id.startsWith('lock.') ? st?.state === 'locked' : st?.state === 'on';
    return { entity_id: id, on, available: !!st && !UNAVAILABLE.has(st.state) };
  }

  async setChildLock(ids, on) {
    const known = new Set(this.zones.flatMap((z) => (z.trvs || []).map((t) => this.ha.childLockFor(t))).filter(Boolean));
    const targets = ids === 'all' ? [...known] : ids.filter((id) => known.has(id));
    if (!targets.length) throw new Error('No child locks found');
    for (const id of targets) {
      const [domain] = id.split('.');
      await this.#call(domain, domain === 'lock' ? (on ? 'lock' : 'unlock') : (on ? 'turn_on' : 'turn_off'), { entity_id: id });
    }
    this.note(`Child lock ${on ? 'on' : 'off'} for ${targets.length === 1 ? this.#name(targets[0]).replace(/ child ?lock/i, '') : `${targets.length} radiators`}`);
    this.requestTick(800);
  }

  #driveTrv(entity, st, wanted, now) {
    const a = st.attributes || {};
    const step = num(a.target_temp_step) || 0.5;
    let temp = Math.round(wanted / step) * step;
    if (num(a.min_temp) != null) temp = Math.max(temp, num(a.min_temp));
    if (num(a.max_temp) != null) temp = Math.min(temp, num(a.max_temp));
    temp = Math.round(temp * 10) / 10;
    const grace = this.s.commandGraceSeconds * 1000;
    const last = this.lastCmd.get(entity) || {};

    if (this.s.takeOverTrvMode && st.state !== 'heat' && (a.hvac_modes || []).includes('heat')) {
      if (!last.modeAt || now - last.modeAt > grace) {
        this.lastCmd.set(entity, { ...last, modeAt: now });
        this.note(`${this.#name(entity)}: switching to manual heat mode (was ${st.state})`);
        this.#call('climate', 'set_hvac_mode', { entity_id: entity, hvac_mode: 'heat' });
      }
    }
    const cur = num(a.temperature);
    if (cur != null && Math.abs(cur - temp) < 0.05) return;
    if (last.temp === temp && now - last.at < grace) return; // waiting for Hive to catch up
    this.lastCmd.set(entity, { ...this.lastCmd.get(entity), temp, at: now, prev: cur });
    this.#remember(entity, now, temp, cur);
    this.log(`${this.#name(entity)}: set ${temp}° (was ${cur}°)`);
    this.#call('climate', 'set_temperature', { entity_id: entity, temperature: temp });
  }

  async #runBoiler(views, now) {
    const b = this.s.boiler;
    if (!b.entity) return;
    // can't be reached (Hive down): nothing's switched, said or alerted; put right when it's back
    if (!this.boilerReachable()) return;
    const demand = views.filter((v) => v.enabled && v.calling).map((v) => v.name);
    const want = demand.length > 0;
    const bs = this.rt.boiler;
    const since = (now - (bs.lastSwitch || 0)) / 60000;
    if (want !== bs.on) {
      const minWait = bs.on ? b.minOnMinutes : b.minOffMinutes;
      if (since >= minWait) {
        const ranFor = bs.on && bs.lastSwitch ? Math.round((now - bs.lastSwitch) / 60000) : null;
        bs.on = want;
        bs.lastSwitch = now;
        this.store.save();
        this.note(want ? `Boiler ON — ${demand.join(', ')} calling for heat` : 'Boiler OFF — all rooms satisfied', 'boiler');
        this.#alert(want ? 'on' : 'off', views.filter((v) => v.enabled && v.calling), ranFor);
        if (want) this.#askIfEmpty(views.filter((v) => v.enabled && v.calling), now);
      }
    }
    this.#assertBoiler(now);
  }

  // Make the real device match what we want (also undoes Hive's own schedule).
  #assertBoiler(now) {
    const b = this.s.boiler;
    const st = this.ha.get(b.entity);
    if (!st || UNAVAILABLE.has(st.state)) return;
    const on = this.rt.boiler.on;
    const domain = b.entity.split('.')[0];
    const grace = this.s.commandGraceSeconds * 1000;
    const last = this.lastCmd.get(b.entity) || {};

    if (domain === 'climate') {
      const a = st.attributes || {};
      if (st.state !== 'heat' && (a.hvac_modes || []).includes('heat') && (!last.modeAt || now - last.modeAt > grace)) {
        this.lastCmd.set(b.entity, { ...last, modeAt: now });
        this.#call('climate', 'set_hvac_mode', { entity_id: b.entity, hvac_mode: 'heat' });
      }
      const want = on ? b.onTemp : b.offTemp;
      const cur = num(a.temperature);
      if (cur != null && Math.abs(cur - want) < 0.05) return;
      if (last.temp === want && now - last.at < grace) return;
      this.lastCmd.set(b.entity, { ...this.lastCmd.get(b.entity), temp: want, at: now, prev: cur });
      this.#remember(b.entity, now, want, cur);
      this.#call('climate', 'set_temperature', { entity_id: b.entity, temperature: want });
    } else {
      const isOn = st.state === 'on';
      if (isOn === on) return;
      if (last.on === on && now - last.at < 30000) return;
      this.lastCmd.set(b.entity, { on, at: now });
      this.#call(domain === 'input_boolean' ? 'input_boolean' : 'homeassistant', on ? 'turn_on' : 'turn_off', { entity_id: b.entity });
    }
  }

  // ---- phone alerts when the heating comes on / goes off ----
  #alertText(which, calling, ranFor, extra) {
    const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
    if (which === 'integration') {
      return extra || { title: 'Hive isn\'t working', message: 'Hive isn\'t working in Home Assistant: it failed to set up. Home Control can\'t change your radiators or the boiler until it\'s fixed. (This is a test.)' };
    }
    if (which === 'heatloss') {
      const e = extra || { room: 'Bedroom', percent: 45 };
      return { title: `${e.room}: losing heat faster`, message: `${e.room} has been losing heat at least ${e.percent}% faster than usual over the last two days, allowing for the weather. Worth checking for a window or trickle vent left open, or a new draught.` };
    }
    if (which === 'window') {
      const e = extra || { room: 'Kitchen', drop: 1.2, until: Date.now() + 20 * 60000 };
      return { title: `${e.room}: window open?`, message: `${e.room} dropped ${e.drop}° in a few minutes, so its heating is paused until ${this.#fmtTime(e.until)}.` };
    }
    if (which === 'on') {
      const rooms = calling.map((v) => (v.current != null ? `${v.name} ${v.current}° (wants ${v.target}°)` : v.name));
      return { title: 'Heating on', message: rooms.length ? `Boiler fired for ${list(rooms)}.` : 'Boiler fired.' };
    }
    const dur = ranFor == null ? '' : ranFor < 1 ? ' It ran for less than a minute.' : ranFor < 60 ? ` It ran for ${ranFor} min.` : ` It ran for ${Math.floor(ranFor / 60)} h ${ranFor % 60} min.`;
    return { title: 'Heating off', message: `No rooms need heat now, so the boiler has stopped.${dur}` };
  }

  #alert(which, calling, ranFor, test = false, extra = null) {
    const n = this.s.notify || {};
    const cfg = n[which] || {};
    if (!cfg.service || (!cfg.enabled && !test)) return false;
    const { title, message } = this.#alertText(which, calling, ranFor, extra);
    const [, service] = cfg.service.split('.');
    this.#call('notify', service, {
      title: test ? `${title} (test)` : title,
      message,
      data: { tag: 'heating-control', group: 'heating-control' },
    });
    return true;
  }

  /** Home Assistant renamed an entity's ID: rooms, the boiler and the sensors chosen follow it. */
  /** Every entity ID heating uses (so a renamed one can be followed, see renames.js). */
  entityIds() {
    const s = this.s;
    return [
      ...this.zones.flatMap((z) => [...(z.trvs || []), z.sensor]),
      s.boiler?.entity, s.outsideEntity, s.costEntity, ...(s.presence?.people || []),
    ].filter(Boolean);
  }

  renameEntity(from, to) {
    const hit = [];
    for (const z of this.zones) {
      let c = false;
      if ((z.trvs || []).includes(from)) { z.trvs = z.trvs.map((e) => (e === from ? to : e)); c = true; }
      if (z.sensor === from) { z.sensor = to; c = true; }
      if (c) hit.push(z.name);
    }
    const s = this.s;
    if (s.boiler?.entity === from) { s.boiler.entity = to; hit.push('the boiler'); }
    if (s.outsideEntity === from) { s.outsideEntity = to; hit.push('the outside temperature'); }
    if (s.costEntity === from) { s.costEntity = to; hit.push('the gas cost'); }
    if (s.presence?.people?.includes(from)) { s.presence.people = s.presence.people.map((p) => (p === from ? to : p)); hit.push('Away automatically'); }
    if (!hit.length) return false;
    const names = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
    this.store.save();
    this.ha.refreshRegistry?.();
    this.note(`Home Assistant renamed ${from} to ${to}: ${names(hit)} ${hit.length === 1 ? 'follows' : 'follow'} it`);
    this.requestTick(200);
    return true;
  }

  /** Hide a room's losing-heat notice until it's back to its usual. */
  dismissHeatLoss(zoneId) {
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone) throw new Error('No such room');
    if (this.heatLoss?.dismiss(zoneId)) this.note(`${zone.name}: losing heat faster notice dismissed, until it's back to normal`);
  }

  /** A room losing heat faster than usual: the phone alert (if it's on), and a line in Activity. */
  heatLossAlert(zoneId, percent) {
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone?.enabled) return;
    this.note(`${zone.name}: losing heat at least ${percent}% faster than usual over the last two days, allowing for the weather`);
    this.#alert('heatloss', [], null, false, { room: zone.name, percent });
  }

  /**
   * An integration behind the devices stopped working, or is working again (integrations.js):
   * Activity, Home Assistant's notifications (unless turned off) and the phone alert (if on).
   */
  integrationAlert({ kind, rec, text }) {
    const cfg = this.s.notify?.integration || {};
    const id = `home_control_${rec.domain}`;
    this.note(text);
    if (cfg.ha !== false) {
      if (kind === 'broken') this.#call('persistent_notification', 'create', { notification_id: id, title: `${rec.name} isn't working`, message: `${text}\n\n[Open ${rec.name} in Home Assistant](/config/integrations/integration/${rec.domain})` });
      else this.#call('persistent_notification', 'dismiss', { notification_id: id });
    }
    this.#alert('integration', [], null, false, { title: kind === 'broken' ? `${rec.name} isn't working` : `${rec.name} is working again`, message: text });
  }

  sendTestAlert(which) {
    if (which === 'empty') {
      const cfg = this.#emptyCfg();
      if (!cfg.services.length) throw new Error('Pick a phone first');
      // test buttons: pressing one changes nothing (it isn't the latest question)
      this.#sendEmpty('Heating on, everyone\'s out (test)', 'This is how the question looks. Pressing a button on this test changes nothing.', [
        { action: 'HC_HEAT_FOR_test', title: `Off for ${cfg.minutes === 60 ? '1 hour' : `${cfg.minutes / 60} hours`}` },
        { action: 'HC_HEAT_HOME_test', title: 'Off until we\'re back' },
        { action: 'HC_HEAT_NEAR_test', title: 'Off until we\'re nearly home' },
      ]);
      this.note(`Sent a test "Heating on, everyone's out" alert to ${cfg.services.join(', ')}`);
      return;
    }
    if (!['on', 'off', 'window', 'heatloss', 'integration'].includes(which)) throw new Error('Unknown alert');
    const calling = this.views.filter((v) => v.enabled && v.calling);
    const sample = calling.length ? calling : this.views.filter((v) => v.enabled).slice(0, 1);
    if (!this.#alert(which, sample, which === 'off' ? 42 : null, true)) throw new Error('Pick a device first');
    this.note(`Sent a test "${{ on: 'Heating on', off: 'Heating off', window: 'Window open', heatloss: 'Losing heat faster', integration: 'Hive isn\'t working' }[which]}" alert to ${this.s.notify[which].service}`);
  }

  boilerView() {
    const b = this.s.boiler;
    const st = b.entity ? this.ha.get(b.entity) : null;
    return {
      entity: b.entity || null,
      name: b.entity ? this.#name(b.entity) : null,
      // on only if it can be reached: asked to fire while Hive's down, it isn't
      on: this.rt.boiler.on && this.boilerReachable(),
      reachable: this.boilerReachable(),
      available: !!st && !UNAVAILABLE.has(st.state),
      action: st?.attributes?.hvac_action || st?.state || null,
      lastSwitch: this.rt.boiler.lastSwitch || null,
      next: this.boilerNext,    // off: about when it next fires, and for which rooms
      until: this.boilerUntil,  // on: about when the last room calling is warm
    };
  }

  // ---- someone turned a TRV knob / changed it in the Hive app ----
  #onState(id, ns, os) {
    if (this.disabled) return;
    const zone = this.zones.find((z) => z.enabled && ((z.trvs || []).includes(id) || z.sensor === id));
    if (/child_?lock/i.test(id)) this.requestTick(200);
    else if (zone || id === this.s.boiler.entity) this.requestTick(1500);
    if (!zone || !ns || !os || !(zone.trvs || []).includes(id)) return;
    if (!this.s.respectManualChanges || this.rt.mode === 'off') return;
    const nt = num(ns.attributes?.temperature);
    const ot = num(os.attributes?.temperature);
    if (nt == null || ot == null || nt === ot) return;
    const now = Date.now();
    const last = this.lastCmd.get(id);
    if (last && last.temp === nt) return;                              // our own command landing
    if (id === this.s.boiler.entity && (nt === this.s.boiler.onTemp || nt === this.s.boiler.offTemp)) return;
    if (last && now - last.at < this.s.commandGraceSeconds * 1000 && nt === last.prev) return; // stale Hive poll showing the old value
    const grace = this.s.commandGraceSeconds * 1000;
    if ((this.recent.get(id) || []).some((r) => r.temp === nt && now - r.at < grace)) return; // a late report of an earlier command
    const t = this.targetFor(zone, now);
    if (Math.abs(t.temp - nt) < 0.05) return;
    const until = this.#nextChangeAt(zone, now) || now + 2 * 3600000;
    const snz = this.#snoozeUnder(zone.id, now);
    const via = this.whoChanged(ns.context);
    this.rt.overrides[zone.id] = { temp: nt, until, kind: 'manual', by: this.#name(id), via, ...(snz ? { prev: snz } : {}) };
    this.lastCmd.set(id, { temp: nt, at: now });
    this.store.save();
    // what people do, not what an automation does at the same time every day
    const byAutomation = !!ns.context?.parent_id && !ns.context?.user_id;
    if (this.rt.mode === 'auto' && !byAutomation) this.emit('learn', { item: zone.id, at: now, value: nt, base: scheduledTemp(zone, now, this.ha.timeZone), until, src: ns.context?.user_id ? 'ha' : 'radiator' });
    this.note(`${zone.name}: ${this.#name(id)} changed to ${nt}° ${via} (it was ${ot}°, and Home Control wanted ${t.temp}°) — holding until ${this.#fmtTime(until)}`);
  }

  #nextChangeAt(zone, now) {
    const sched = scheduledAt(zone.schedule, localWeekPosition(new Date(now), this.ha.timeZone));
    return sched?.next ? now + sched.next.inMinutes * 60000 : null;
  }

  #fmtTime(ms) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.ha.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  }

  // On shutdown: hand Hive devices back to their own schedules so nothing is
  // left stuck (e.g. the thermostat at 30°). Zigbee valves without an 'auto'
  // mode keep their last setpoint.
  /** Turned back on in Home Control's settings: forget what was last sent, so every device is put right now. */
  resume() {
    this.lastCmd.clear();
    this.recent.clear();
    this.requestTick(200);
  }

  async handBack(timeoutMs = 5000) {
    if (!this.ha.connected) return;
    const ids = [...new Set([this.s.boiler.entity, ...this.zones.filter((z) => z.enabled).flatMap((z) => z.trvs || [])])];
    const jobs = [];
    for (const id of ids) {
      const st = id && this.ha.get(id);
      if (st && id.startsWith('climate.') && (st.attributes?.hvac_modes || []).includes('auto') && st.state !== 'auto') {
        jobs.push(this.ha.callService('climate', 'set_hvac_mode', { entity_id: id, hvac_mode: 'auto' }).catch(() => {}));
      }
    }
    const b = this.s.boiler.entity;
    if (b && !b.startsWith('climate.') && this.rt.boiler.on) {
      jobs.push(this.ha.callService('homeassistant', 'turn_off', { entity_id: b }).catch(() => {}));
    }
    if (jobs.length) this.log(`Handing ${jobs.length} device(s) back to their own schedules`);
    await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  // ---- actions from the GUI ----
  setOverride(zoneId, { temp, minutes, untilNext, kind, forever }) {
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone) throw new Error('Unknown room');
    const now = Date.now();
    if (kind === 'snooze') return this.#snooze(zone, { temp, minutes, forever }, now);
    const t = Math.round(Number(temp) * 2) / 2;
    if (!Number.isFinite(t) || t < 5 || t > 30) throw new Error('Temperature must be 5–30°');
    let until;
    if (minutes) until = now + Math.min(Number(minutes), 7 * 24 * 60) * 60000;
    else if (untilNext) until = this.#nextChangeAt(zone, now) || now + 2 * 3600000;
    else until = now + 3600000;
    const snz = this.#snoozeUnder(zone.id, now); // a hold or boost on a snoozed room goes back to the snooze after
    this.rt.overrides[zone.id] = { temp: t, until, kind: kind || (minutes ? 'boost' : 'hold'), ...(snz ? { prev: snz } : {}) };
    this.store.save();
    if (this.rt.mode === 'auto') this.emit('learn', { item: zone.id, at: now, value: t, base: scheduledTemp(zone, now, this.ha.timeZone), until, src: 'app' });
    this.note(`${zone.name}: set to ${t}° until ${this.#fmtTime(until)}`);
    this.requestTick(100);
  }

  // ---- snooze: ignore the schedule and keep a room cool for a while, or until turned back on ----
  #snooze(zone, { temp, minutes, forever }, now) {
    const t = temp == null || temp === '' ? this.s.frostTemp : Math.round(Number(temp) * 2) / 2;
    if (!Number.isFinite(t) || t < 5 || t > 30) throw new Error('Temperature must be 5–30°');
    let until = FOREVER;
    if (!forever) {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m < 15) throw new Error('Snooze for at least 15 minutes');
      until = now + Math.min(m, 90 * 24 * 60) * 60000;
    }
    this.rt.overrides[zone.id] = { temp: t, until, kind: 'snooze', ...(forever ? { forever: true } : {}) };
    this.store.save();
    this.emit('learn-end', { item: zone.id });
    this.note(`${zone.name}: snoozed at ${t}° ${forever ? 'until turned back on' : `until ${this.#fmtTime(until)}`}`);
    this.requestTick(100);
  }

  // the room's snooze, whether it's in charge now or waiting under a hold, boost or radiator change
  #snoozeUnder(id, now = Date.now()) {
    const ov = this.rt.overrides[id];
    if (ov?.kind === 'snooze' && ov.until > now) return ov;
    if (ov?.prev?.kind === 'snooze' && ov.prev.until > now) return ov.prev;
    return null;
  }

  // ---- house boost: every chosen room to one temperature for a while ----
  boostHouse({ temp, minutes, zoneIds }) {
    if (this.rt.mode === 'off') throw new Error('Heating is off. Switch back to Schedules or Away to boost.');
    const t = Math.round(Number(temp) * 2) / 2;
    if (!Number.isFinite(t) || t < 5 || t > 30) throw new Error('Temperature must be 5–30°');
    const mins = Math.min(Math.max(Number(minutes) || 30, 5), 12 * 60);
    const ids = (Array.isArray(zoneIds) ? zoneIds : []).filter((id) => this.zones.some((z) => z.id === id && z.enabled));
    if (!ids.length) throw new Error('Pick at least one room');
    const now = Date.now();
    const until = now + mins * 60000;
    // a fresh house boost replaces an old one rather than stacking on it
    this.#endHouseBoost(false);
    for (const id of ids) {
      const cur = this.rt.overrides[id];
      const prev = cur && cur.until > now ? cur : null;
      this.rt.overrides[id] = { temp: t, until, kind: 'boost', by: 'House boost', group: 'house', prev };
      this.emit('learn-end', { item: id });
    }
    this.rt.houseBoost = { temp: t, until, zones: ids, started: now };
    this.store.save();
    this.note(`House boost to ${t}° for ${mins} min in ${ids.length} room${ids.length === 1 ? '' : 's'}`);
    this.requestTick(100);
  }

  #endHouseBoost(log = true) {
    let n = 0;
    for (const [id, ov] of Object.entries(this.rt.overrides)) {
      if (ov?.group !== 'house') continue;
      if (ov.prev && ov.prev.until > Date.now()) this.rt.overrides[id] = ov.prev; else delete this.rt.overrides[id];
      n++;
    }
    const was = this.rt.houseBoost;
    this.rt.houseBoost = null;
    if (log && (n || was)) this.note(`House boost stopped, ${n} room${n === 1 ? '' : 's'} back to what they were doing before`);
    return n;
  }

  stopHouseBoost() {
    this.#endHouseBoost(true);
    this.store.save();
    this.requestTick(100);
  }

  // "Back to schedule" for one room: drops its hold, boost or radiator change outright
  // (including anything a house boost would have restored), so it follows its schedule
  // now, or Away if the house is in Away.
  clearOverride(zoneId) {
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone) throw new Error('Unknown room');
    const ov = this.rt.overrides[zoneId];
    if (ov) {
      delete this.rt.overrides[zoneId];
      this.emit('learn-end', { item: zoneId });
      const hb = this.rt.houseBoost;
      if (ov.group === 'house' && hb) {
        hb.zones = hb.zones.filter((id) => id !== zoneId);
        if (!hb.zones.length) this.rt.houseBoost = null;
      }
      this.store.save();
      this.note(`${zone.name}: back to ${this.rt.mode === 'away' ? 'Away' : 'schedule'}${ov.group === 'house' ? ' (left the house boost)' : ''}`);
    }
    this.requestTick(100);
  }

  setMode(mode, until, { by = 'user', why = '' } = {}) {
    if (!['auto', 'away', 'off'].includes(mode)) throw new Error('Bad mode');
    const pr = (this.rt.presence ||= { emptySince: null, suppress: false });
    this.rt.presenceAway = by === 'presence' && mode === 'away';
    if (by !== 'presence') {
      // a hand-picked mode wins: don't flip it back to Away until someone has come home
      const everyoneOut = this.s.presence?.enabled && this.presenceView().length && !this.presenceView().some((p) => p.home);
      pr.suppress = mode === 'auto' && !!everyoneOut;
      pr.emptySince = null;
    }
    this.rt.modeLog = recordMode(this.modeLog(), mode);
    this.rt.mode = mode;
    this.rt.awayUntil = mode === 'away' && until ? Number(until) : null;
    this.rt.awayBack = null; // "until someone's back" is set after, by the phone alert's button
    // a mode change wipes room-level holds and boosts, but a snoozed room stays snoozed
    const kept = {};
    for (const z of this.zones) { const snz = this.#snoozeUnder(z.id); if (snz) kept[z.id] = snz; }
    this.rt.overrides = kept;
    this.rt.houseBoost = null;
    this.store.save();
    this.emit('learn-end', { item: null });
    const label = { auto: 'Schedules', away: 'Away', off: 'Heating off (frost protection)' }[mode];
    this.note(`Mode: ${label}${this.rt.awayUntil ? ` until ${this.#fmtTime(this.rt.awayUntil)}` : ''}${by === 'presence' ? ` (automatic: ${why})` : by === 'phone' ? ` (${why})` : ''}`);
    this.requestTick(100);
  }

  upsertZone(input) {
    const clean = {
      name: String(input.name || '').trim().slice(0, 40) || 'Room',
      icon: String(input.icon || 'room').slice(0, 20),
      trvs: (input.trvs || []).filter((e) => /^climate\./.test(e)),
      sensor: /^sensor\./.test(input.sensor || '') ? input.sensor : null,
      enabled: input.enabled !== false,
      stopEarlyPct: input.stopEarlyPct === '' || input.stopEarlyPct == null || !Number.isFinite(Number(input.stopEarlyPct))
        ? null : Math.min(10, Math.max(0, Math.round(Number(input.stopEarlyPct) * 2) / 2)),
      stopEarlyMode: ['auto', 'fixed', 'house'].includes(input.stopEarlyMode) ? input.stopEarlyMode : 'auto',
      // null: worked out (no TRV of its own); true/false: set by hand
      openRadiator: input.openRadiator === true || input.openRadiator === false ? input.openRadiator : null,
    };
    // its own Away temperature, or null for the house's (left as it was if not sent)
    if (input.awayTemp !== undefined) {
      const a = input.awayTemp === '' || input.awayTemp == null ? null : num(input.awayTemp);
      clean.awayTemp = a == null ? null : Math.min(AWAY_MAX, Math.max(AWAY_MIN, Math.round(a * 2) / 2));
    }
    // what to do with changes made by hand that keep happening: suggest a schedule change (the
    // default), make it automatically, or nothing (left as it was if not sent)
    if (['off', 'suggest', 'auto'].includes(input.learn)) clean.learn = input.learn;
    let zone = this.zones.find((z) => z.id === input.id);
    if (zone) Object.assign(zone, clean);
    else {
      zone = { id: this.store.newId(), ...clean, schedule: defaultSchedule() };
      this.zones.push(zone);
      this.note(`Added room ${zone.name}`);
    }
    if (input.schedule) zone.schedule = normaliseSchedule(input.schedule);
    this.store.save();
    this.requestTick(100);
    return zone;
  }

  deleteZone(id) {
    const z = this.zones.find((x) => x.id === id);
    this.store.data.zones = this.zones.filter((x) => x.id !== id);
    delete this.rt.overrides[id];
    this.calling.delete(id);
    if (z) this.note(`Removed room ${z.name}`);
    this.store.save();
    this.requestTick(100);
  }

  /** Some days of a room's schedule, from a suggestion (or undoing one). days: { 0..6: [{ time, temp }] } */
  setScheduleDays(id, days, note) {
    const z = this.zones.find((x) => x.id === id);
    if (!z) throw new Error('Unknown room');
    const next = { ...z.schedule };
    for (const [d, pts] of Object.entries(days)) next[DAYS[Number(d)]] = pts;
    z.schedule = normaliseSchedule(next);
    this.store.save();
    if (note) this.note(note);
    this.requestTick(100);
  }

  setSchedule(id, schedule) {
    const z = this.zones.find((x) => x.id === id);
    if (!z) throw new Error('Unknown room');
    z.schedule = normaliseSchedule(schedule);
    this.store.save();
    this.note(`${z.name}: schedule updated`);
    this.requestTick(100);
  }

  updateSettings(input) {
    const s = this.s;
    const n = (v, lo, hi, d) => { const x = num(v); return x == null ? d : Math.min(hi, Math.max(lo, x)); };
    if (input.boiler) {
      const b = input.boiler;
      s.boiler = {
        entity: /^(climate|switch|input_boolean)\./.test(b.entity || '') ? b.entity : '',
        onTemp: n(b.onTemp, 15, 32, s.boiler.onTemp),
        offTemp: n(b.offTemp, 5, 15, s.boiler.offTemp),
        minOnMinutes: n(b.minOnMinutes, 0, 30, s.boiler.minOnMinutes),
        minOffMinutes: n(b.minOffMinutes, 0, 30, s.boiler.minOffMinutes),
      };
    }
    s.hysteresis = n(input.hysteresis, 0, 2, s.hysteresis);
    s.stopEarly = n(input.stopEarly, 0, 1.5, s.stopEarly ?? 0);
    s.frostTemp = n(input.frostTemp, 5, 12, s.frostTemp);
    s.awayTemp = n(input.awayTemp, AWAY_MIN, AWAY_MAX, s.awayTemp);
    s.houseBoostTemp = n(input.houseBoostTemp, 10, 28, s.houseBoostTemp ?? 22);
    s.houseBoostMinutes = n(input.houseBoostMinutes, 5, 720, s.houseBoostMinutes ?? 30);
    s.commandGraceSeconds = n(input.commandGraceSeconds, 30, 900, s.commandGraceSeconds);
    if (input.notify && typeof input.notify === 'object') {
      const clean = (c) => {
        let svc = String(c?.service || '').trim();
        if (svc && !svc.includes('.')) svc = `notify.${svc}`;
        return { enabled: !!c?.enabled, service: /^notify\.\w+$/.test(svc) ? svc : '' };
      };
      const e = input.notify.empty ?? s.notify?.empty ?? {};
      const empty = {
        enabled: !!e.enabled,
        services: [...new Set((Array.isArray(e.services) ? e.services : []).map((x) => String(x).trim()).filter((x) => /^notify\.\w+$/.test(x)))],
        minutes: Math.round(n(e.minutes, 30, 720, 120) / 30) * 30,
      };
      // the integration behind the devices not working: a phone alert, and Home Assistant's notifications (on unless turned off)
      const ig = input.notify.integration ?? s.notify?.integration ?? {};
      const integration = { ...clean(ig), ha: ig.ha !== false };
      s.notify = { on: clean(input.notify.on), off: clean(input.notify.off), window: clean(input.notify.window), heatloss: clean(input.notify.heatloss), empty, integration };
    }
    if (input.retention) {
      const r = input.retention;
      s.retention = {
        activityDays: Math.round(n(r.activityDays, 1, 365, s.retention?.activityDays ?? 30)),
        detailDays: Math.round(n(r.detailDays, 1, 90, s.retention?.detailDays ?? 7)),
        dailyDays: Math.round(n(r.dailyDays, 30, 1100, s.retention?.dailyDays ?? 400)),
      };
      // shortening takes effect now, not at the next write
      this.store.pruneLog(); this.store.flushLog();
      this.targetLog?.prune(); this.callLog?.prune(); this.dailyLog?.flush();
    }
    if (input.cards) s.cards = { spark: input.cards.spark !== false, fires: input.cards.fires !== false };
    if (input.preheat) s.preheat = { enabled: !!input.preheat.enabled, maxMinutes: n(input.preheat.maxMinutes, 15, 240, 120) };
    if (input.easeOff) s.easeOff = { enabled: !!input.easeOff.enabled, drop: n(input.easeOff.drop, 0.2, 2, 0.5), maxMinutes: Math.round(n(input.easeOff.maxMinutes, 10, 120, 60)) };
    if (input.together) s.together = { enabled: !!input.together.enabled, minutes: Math.round(n(input.together.minutes, 5, 90, 30)) };
    if (input.heatLoss) s.heatLoss = { percent: Math.round(n(input.heatLoss.percent, 15, 200, 40)) };
    if (input.window) {
      s.window = {
        enabled: !!input.window.enabled,
        drop: n(input.window.drop, 0.4, 3, 1),
        minutes: n(input.window.minutes, 3, 30, 10),
        pauseMinutes: n(input.window.pauseMinutes, 5, 120, 20),
      };
    }
    if (input.presence) {
      s.presence = {
        enabled: !!input.presence.enabled,
        people: (input.presence.people || []).filter((e) => /^person\.\w+$/.test(e)),
        delayMinutes: n(input.presence.delayMinutes, 0, 240, 15),
        nearMiles: n(input.presence.nearMiles, 0.2, 50, 2),
      };
    }
    for (const k of ['costEntity', 'outsideEntity']) {
      if (typeof input[k] === 'string') s[k] = /^(sensor|weather)\.\w+$/.test(input[k]) ? input[k] : '';
    }
    if (typeof input.dashboardPath === 'string') {
      const p = input.dashboardPath.trim();
      s.dashboardPath = /^\/[\w\-/.]*$/.test(p) ? p : '/';
    }
    if (typeof input.respectManualChanges === 'boolean') s.respectManualChanges = input.respectManualChanges;
    if (typeof input.takeOverTrvMode === 'boolean') s.takeOverTrvMode = input.takeOverTrvMode;
    this.settingsAt = Date.now(); // predictions are worked out again
    this.store.save();
    this.note('Settings updated');
    this.requestTick(100);
  }
}
