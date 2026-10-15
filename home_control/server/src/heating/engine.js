// The heating brain: works out each room's target, drives the TRVs, and fires
// the boiler when any room is calling for heat.
import { EventEmitter } from 'node:events';
import { scheduledAt, localWeekPosition, normaliseSchedule, defaultSchedule } from './schedule.js';
import { detectOutsideEntity, readOutside } from './history.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const UNAVAILABLE = new Set(['unavailable', 'unknown']);
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
  // The start gap widens if needed so there's always 0.2° between start and stop (no flicking on/off).
  startGapFor(stop) { return Math.max(Number(this.s.hysteresis) || 0, stop + 0.2); }

  start() {
    this.ha.on('status', (ok) => { if (ok) this.requestTick(); this.emit('change'); });
    this.ha.on('state', (id, ns, os) => this.#onState(id, ns, os));
    setInterval(() => this.tick(), 30000);
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

  note(msg) {
    this.log(msg);
    this.store.addLog(msg);
  }

  // ---- service calls, serialised and spaced out (Hive is a cloud API) ----
  #call(domain, service, data) {
    this.queue = this.queue.then(async () => {
      try { await this.ha.callService(domain, service, data); }
      catch (e) { this.note(`Failed ${domain}.${service}${data.entity_id ? ` on ${data.entity_id}` : ''}: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 400));
    });
    return this.queue;
  }

  #name(entityId) {
    return this.ha.get(entityId)?.attributes?.friendly_name || entityId;
  }

  // ---- target calculation ----
  targetFor(zone, now = Date.now()) {
    const pos = localWeekPosition(new Date(now), this.ha.timeZone);
    const sched = scheduledAt(zone.schedule, pos);
    const ov = this.rt.overrides[zone.id];
    if (this.rt.mode === 'off') return { temp: this.s.frostTemp, source: 'off', sched };
    const win = this.rt.windowPause?.[zone.id];
    if (win && win.until > now) return { temp: this.s.frostTemp, source: 'window', until: win.until, sched };
    if (ov && ov.until > now) return { temp: ov.temp, source: ov.kind, until: ov.until, by: ov.by, forever: !!ov.forever, sched };
    if (this.rt.mode === 'away') return { temp: this.s.awayTemp, source: 'away', until: this.rt.awayUntil, sched };
    if (!sched) return { temp: this.s.frostTemp, source: 'no-schedule', sched };
    const pre = this.#preheat(zone, sched, now);
    if (pre) return { temp: pre.temp, source: 'preheat', until: pre.until, readyBy: pre.readyBy, sched };
    return { temp: sched.temp, source: 'schedule', sched };
  }

  // ---- outside temperature (for warm-up predictions) ----
  outsideNow() {
    const id = this.s.outsideEntity || detectOutsideEntity(this.ha);
    return id ? readOutside(this.ha, id) : null;
  }

  // ---- warm by the scheduled time ----
  // Predicted warm-up speed (°/hour) for a room, scaled for how cold it is outside
  // compared with the conditions it was learned in.
  warmRateFor(zone, target) {
    const w = this.rt.warm?.[zone.id];
    if (!w?.rate || !w.samples) return null;
    const out = this.outsideNow();
    if (out == null || w.gap == null) return w.rate;
    const gap = Math.max(2, target - out);
    return w.rate * Math.min(1.5, Math.max(0.6, w.gap / gap));
  }

  #preheat(zone, sched, now) {
    const p = this.s.preheat || {};
    if (!p.enabled || !sched?.next || sched.next.temp <= sched.temp) return null;
    const rate = this.warmRateFor(zone, sched.next.temp);
    if (!rate) return null;
    const current = this.currentTemp(zone);
    if (current == null) return null;
    const needed = sched.next.temp - current;
    if (needed <= 0.1) return null;
    const lead = Math.min(Number(p.maxMinutes) || 120, (needed / rate) * 60 + 10);
    if (sched.next.inMinutes > lead) return null;
    return { temp: sched.next.temp, until: now + sched.next.inMinutes * 60000, readyBy: sched.next.time };
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
    const mins = (ms) => Math.round(ms / 60000 / TS);
    for (const v of views) {
      if (!v.enabled) continue;
      const cs = this.callSince[v.id];
      if (v.calling && cs && now - cs.at > 60 * 60000 * TS && v.current != null && v.current - cs.temp < 0.2) {
        out.push({ key: `stuck-${v.id}`, room: v.name, text: `${v.name} has been calling for heat for ${mins(now - cs.at)} min without warming (${cs.temp}° then, ${v.current}° now). Check its radiator is getting hot and the valve isn't stuck.` });
      }
      for (const t of v.trvs) {
        if (t.role === 'boiler') continue;
        if (!t.available) out.push({ key: `off-${t.entity_id}`, room: v.name, text: `${t.name} is offline. Check its batteries, or that it's in range of its hub.` });
        const b = this.batteryFor(t.entity_id);
        if (b != null && b <= 20) out.push({ key: `bat-${t.entity_id}`, room: v.name, text: `${t.name} battery is at ${Math.round(b)}%. Replace it soon.` });
      }
    }
    const b = this.s.boiler;
    if (b.entity) {
      const st = this.ha.get(b.entity);
      if (!st || UNAVAILABLE.has(st.state)) out.push({ key: 'boiler-offline', text: `${this.#name(b.entity)} (boiler control) is offline, so the boiler can't be fired. Check the Hive hub and receiver.` });
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
      this.rt.mode = 'auto';
      this.rt.awayUntil = null;
      this.note('Away mode ended, back to schedules');
      changed = true;
    }
    if (changed) this.store.save();
  }

  // ---- main loop ----
  async tick() {
    const now = Date.now();
    this.#expire(now);
    const next = Math.min(...Object.values(this.rt.overrides).map((o) => o.until), Infinity);
    if (next - now < 30000) { clearTimeout(this.expiryTimer); this.expiryTimer = setTimeout(() => this.tick(), Math.max(200, next - now + 50)); }
    if (this.ha.connected) this.#presence(now);
    const views = [];
    for (const zone of this.zones) views.push(this.#runZone(zone, now));
    this.views = views;
    if (this.ha.connected) await this.#runBoiler(views, now);
    this.#computeAttention(views, now);
    this.dailyLog?.sample(now, this, views);
    this.callLog?.update(views, now);
    this.emit('change');
  }

  #runZone(zone, now) {
    const t = this.targetFor(zone, now);
    const current = this.currentTemp(zone);
    const warnings = [];
    const wasCalling = this.calling.get(zone.id) || false;
    let calling = wasCalling;
    const stop = this.stopMarginFor(zone, t.temp);
    const start = this.startGapFor(stop);
    if (!zone.enabled) {
      calling = false;
    } else if (current == null) {
      calling = false;
      warnings.push('No temperature reading');
    } else if (current < t.temp - start) {
      calling = true;
    } else if (current >= t.temp - stop) {
      calling = false;
    }
    if (calling !== wasCalling && zone.enabled) {
      this.log(`${zone.name}: ${calling ? 'calling for heat' : 'satisfied'} (${current}° vs ${t.temp}°, stops at ${Math.round((t.temp - stop) * 10) / 10}°)`);
    }
    this.calling.set(zone.id, calling);
    if (zone.enabled) {
      this.#trackCoast(zone, wasCalling, calling, current, t.temp, now);
      if (t.source !== 'window') this.#trackWarm(zone, wasCalling, calling, current, t.temp, now);
      this.#trackWindow(zone, current, now);
      if (calling && !wasCalling) this.callSince[zone.id] = { at: now, temp: current };
      if (!calling) delete this.callSince[zone.id];
    }
    if (zone.enabled) this.targetLog?.record(zone.id, t.temp, now);

    const trvs = (zone.trvs || []).map((e) => {
      const st = this.ha.get(e);
      const available = !!st && !UNAVAILABLE.has(st.state);
      if (!available) warnings.push(`${this.#name(e)} unavailable`);
      const isBoiler = e === this.s.boiler.entity;
      // While the room isn't calling, turn the valve down to the stop point so it closes
      // too (otherwise it stays open whenever the boiler fires for another room).
      const lowered = !calling && stop > 0 && !['off', 'window'].includes(t.source) && t.temp > this.s.frostTemp;
      const valveTarget = lowered ? t.temp - stop : t.temp;
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

    return {
      stopAt: Math.round((t.temp - stop) * 10) / 10,
      readyBy: t.readyBy || null,
      warm: this.rt.warm?.[zone.id] || null,
      warmRate: this.warmRateFor(zone, t.temp),
      windowPause: t.source === 'window' ? this.rt.windowPause[zone.id] : null,
      stopMargin: Math.round(stop * 100) / 100,
      stopMode: this.stopModeFor(zone),
      coast: this.rt.coast?.[zone.id] || null,
      learn: this.rt.learn?.[zone.id] || null,
      coasting: !calling && stop > 0 && current != null && current < t.temp && current >= t.temp - stop - 0.05,
      id: zone.id, name: zone.name, icon: zone.icon || 'room', enabled: zone.enabled,
      current, target: t.temp, source: t.source, until: t.until || null, by: t.by || null, forever: !!t.forever,
      snoozedUnder: this.#snoozeUnder(zone.id, now) ? true : false,
      scheduled: t.sched, calling, trvs, sensor: zone.sensor || null, warnings,
    };
  }

  // After heating stops, watch how far the room keeps rising (leftover radiator heat)
  // for up to 90 min. The result is shown in the room's settings to help pick a % to stop early.
  #trackCoast(zone, wasCalling, calling, current, target, now) {
    const rt = (this.rt.coast ||= {});
    const c = rt[zone.id];
    if (wasCalling && !calling && current != null) {
      rt[zone.id] = { target, stoppedAt: current, margin: this.stopMarginFor(zone, target), peak: current, peakAt: now, at: now, heatedFor: this.heatStart?.[zone.id] ? Math.round((now - this.heatStart[zone.id]) / 60000) : null, done: false };
      this.store.save();
      return;
    }
    if (!wasCalling && calling) (this.heatStart ||= {})[zone.id] = now;
    if (!c || c.done) return;
    if (target !== c.target) { c.done = true; c.discard = 'target changed'; this.store.save(); return; }
    if (!calling && current != null && current > c.peak) { c.peak = current; c.peakAt = now; this.store.save(); }
    const pastPeak = current != null && current <= c.peak - 0.2 && now - c.peakAt > 10 * 60000 * TS;
    const timedOut = now - c.at > 90 * 60000 * TS;
    if (pastPeak || timedOut || calling) {
      c.done = true;
      if (calling && !pastPeak && c.peak <= c.stoppedAt + 0.05 && now - c.at < 20 * 60000 * TS) c.discard = 'heating restarted too soon';
      if (!c.discard) this.#learn(zone, c, now);
      this.store.save();
    }
  }

  // One step of learning per heat-up: nudge the margin by half the overshoot (or undershoot),
  // at most 0.3° per cycle, kept between 0 and 1.5°.
  #learn(zone, c, now) {
    const L = (this.rt.learn ||= {});
    const cur = L[zone.id] || { margin: Math.max(0, Number(this.s.stopEarly) || 0), cycles: 0, history: [] };
    const err = Math.round((c.peak - c.target) * 100) / 100;
    let step = 0.5 * err;
    if (Math.abs(err) < 0.1) step = 0; // close enough: leave it alone
    step = Math.max(-0.3, Math.min(0.3, step));
    const margin = Math.round(Math.max(0, Math.min(1.5, (c.margin ?? cur.margin) + step)) * 20) / 20;
    cur.history = [...(cur.history || []), { at: now, target: c.target, stoppedAt: c.stoppedAt, peak: c.peak, err, margin }].slice(-12);
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
        this.note(want ? `Boiler ON — ${demand.join(', ')} calling for heat` : 'Boiler OFF — all rooms satisfied');
        this.#alert(want ? 'on' : 'off', views.filter((v) => v.enabled && v.calling), ranFor);
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

  sendTestAlert(which) {
    if (!['on', 'off', 'window'].includes(which)) throw new Error('Unknown alert');
    const calling = this.views.filter((v) => v.enabled && v.calling);
    const sample = calling.length ? calling : this.views.filter((v) => v.enabled).slice(0, 1);
    if (!this.#alert(which, sample, which === 'off' ? 42 : null, true)) throw new Error('Pick a device first');
    this.note(`Sent a test "${{ on: 'Heating on', off: 'Heating off', window: 'Window open' }[which]}" alert to ${this.s.notify[which].service}`);
  }

  boilerView() {
    const b = this.s.boiler;
    const st = b.entity ? this.ha.get(b.entity) : null;
    return {
      entity: b.entity || null,
      name: b.entity ? this.#name(b.entity) : null,
      on: this.rt.boiler.on,
      available: !!st && !UNAVAILABLE.has(st.state),
      action: st?.attributes?.hvac_action || st?.state || null,
      lastSwitch: this.rt.boiler.lastSwitch || null,
    };
  }

  // ---- someone turned a TRV knob / changed it in the Hive app ----
  #onState(id, ns, os) {
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
    this.rt.overrides[zone.id] = { temp: nt, until, kind: 'manual', by: this.#name(id), ...(snz ? { prev: snz } : {}) };
    this.lastCmd.set(id, { temp: nt, at: now });
    this.store.save();
    this.note(`${zone.name}: ${this.#name(id)} changed by hand to ${nt}° — holding until ${this.#fmtTime(until)}`);
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
    this.rt.mode = mode;
    this.rt.awayUntil = mode === 'away' && until ? Number(until) : null;
    // a mode change wipes room-level holds and boosts, but a snoozed room stays snoozed
    const kept = {};
    for (const z of this.zones) { const snz = this.#snoozeUnder(z.id); if (snz) kept[z.id] = snz; }
    this.rt.overrides = kept;
    this.rt.houseBoost = null;
    this.store.save();
    const label = { auto: 'Schedules', away: 'Away', off: 'Heating off (frost protection)' }[mode];
    this.note(`Mode: ${label}${this.rt.awayUntil ? ` until ${this.#fmtTime(this.rt.awayUntil)}` : ''}${by === 'presence' ? ` (automatic: ${why})` : ''}`);
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
    };
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
    s.awayTemp = n(input.awayTemp, 5, 18, s.awayTemp);
    s.houseBoostTemp = n(input.houseBoostTemp, 10, 28, s.houseBoostTemp ?? 22);
    s.houseBoostMinutes = n(input.houseBoostMinutes, 5, 720, s.houseBoostMinutes ?? 30);
    s.commandGraceSeconds = n(input.commandGraceSeconds, 30, 900, s.commandGraceSeconds);
    if (input.notify && typeof input.notify === 'object') {
      const clean = (c) => {
        let svc = String(c?.service || '').trim();
        if (svc && !svc.includes('.')) svc = `notify.${svc}`;
        return { enabled: !!c?.enabled, service: /^notify\.\w+$/.test(svc) ? svc : '' };
      };
      s.notify = { on: clean(input.notify.on), off: clean(input.notify.off), window: clean(input.notify.window) };
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
    this.store.save();
    this.note('Settings updated');
    this.requestTick(100);
  }
}
