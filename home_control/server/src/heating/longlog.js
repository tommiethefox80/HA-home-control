// Heating history over any range: each room's temperature, target and heating, outside, and the
// boiler, for the History chart (last 6 hours to a year, or chosen dates).
//
// Home Assistant keeps detailed history for about 10 days (its recorder), and a Hive radiator's
// temperature has no long-term statistics, so Home Control keeps its own: every half hour, each
// room's average temperature, humidity (where it has a humidity sensor) and target and the minutes
// it heated, the outside average and the minutes the boiler fired (history.json, kept as long as
// the daily figures: Settings → History).
// The first time, and after the app has been stopped, the gap is filled in from Home Assistant's
// history where it still has it.
//
// A range of up to 3½ days within Home Assistant's history is drawn from it directly (every 5 to
// 15 minutes, with each heat-up as it happened); longer ones from the half-hourly log, every 30
// minutes to a day. Before the half-hourly log starts, ranges of 90 days or more use the daily
// figures (insights.js).
import fs from 'node:fs';
import path from 'node:path';
import { rowsFor, tempOf, detectOutsideEntity } from './history.js';
import { scheduledAt, localWeekPosition } from './schedule.js';
import { localDate } from './insights.js';
import { humidOf, coldSeries } from './humidity.js';

export const HALF = 30 * 60000;
const H = 3600000; const DAY = 24 * H;
const r1 = (x) => Math.round(x * 10) / 10;
const BAD = new Set(['unavailable', 'unknown']);

export class LongLog {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'history.json') : null;
    this.data = { v: 1, step: HALF, start: null, rooms: {}, out: [], boil: [] };
    this.cur = null;  // the half hour being gathered: { b, rooms: { id: { ts, tn, gs, gn, hs, hn, h } }, os, on, boil }
    this.last = null;
    this.keepDays = () => 400; // set from Settings → History (as the daily figures)
    if (this.file) {
      try {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (d.v === 1 && d.step === HALF) { this.data = { ...this.data, ...d }; this.cur = d.cur || null; delete this.data.cur; }
      } catch { /* new */ }
    }
  }

  /** Each tick of the engine (about every 30 seconds): add to the half hour being gathered. */
  sample(now, engine, views) {
    const dt = this.last ? Math.min(now - this.last, 2 * 60000) : 0;
    this.last = now;
    if (!dt) return;
    const b = Math.floor(now / HALF) * HALF;
    if (this.cur && this.cur.b !== b) this.close();
    const c = (this.cur ||= { b, rooms: {}, os: 0, on: 0, boil: 0 });
    const mins = dt / 60000;
    if (engine.boilerFiring ? engine.boilerFiring() : engine.rt?.boiler?.on) c.boil += mins;
    const out = engine.outsideNow?.();
    if (out != null) { c.os += out * mins; c.on += mins; }
    for (const v of views) {
      if (!v.enabled) continue;
      const r = (c.rooms[v.id] ||= { ts: 0, tn: 0, gs: 0, gn: 0, h: 0 });
      if (v.current != null) { r.ts += v.current * mins; r.tn += mins; }
      if (v.humidity?.now != null) { r.hs = (r.hs || 0) + v.humidity.now * mins; r.hn = (r.hn || 0) + mins; }
      if (v.target != null) { r.gs += v.target * mins; r.gn += mins; }
      if (v.heating ?? v.calling) r.h += mins;
    }
  }

  #index(b) {
    if (this.data.start == null) this.data.start = b;
    if (b < this.data.start) { // (only from filling in from Home Assistant: earlier than anything kept)
      const add = Math.round((this.data.start - b) / HALF);
      const pad = (a) => [...Array(add).fill(null), ...a];
      for (const r of Object.values(this.data.rooms)) { r.t = pad(r.t); r.g = pad(r.g); r.h = pad(r.h); if (r.rh) r.rh = pad(r.rh); }
      this.data.out = pad(this.data.out); this.data.boil = pad(this.data.boil);
      this.data.start = b;
    }
    return Math.round((b - this.data.start) / HALF);
  }

  #room(id) { return (this.data.rooms[id] ||= { t: [], g: [], h: [] }); }

  /** Put one half hour's figures in (from what was gathered, or from Home Assistant's history). */
  put(b, { rooms = {}, out = null, boil = null }, { onlyGaps = false } = {}) {
    this.rev = (this.rev || 0) + 1; // (anything worked out from the log is out of date)
    const i = this.#index(b);
    const set = (arr, v) => { while (arr.length <= i) arr.push(null); if (!onlyGaps || arr[i] == null) arr[i] = v; };
    for (const [id, r] of Object.entries(rooms)) {
      const a = this.#room(id);
      set(a.t, r.t ?? null); set(a.g, r.g ?? null); set(a.h, r.h ?? null);
      // (humidity only for rooms that have had it)
      if (r.rh != null || a.rh) set((a.rh ||= []), r.rh ?? null);
    }
    set(this.data.out, out); set(this.data.boil, boil);
  }

  /** The half hour is over: keep its figures, and drop what's older than kept. */
  close() {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    const rooms = {};
    for (const [id, r] of Object.entries(c.rooms)) {
      rooms[id] = { t: r.tn ? r1(r.ts / r.tn) : null, g: r.gn ? r1(r.gs / r.gn) : null, h: Math.min(30, Math.round(r.h)), rh: r.hn ? r1(r.hs / r.hn) : null };
    }
    this.put(c.b, { rooms, out: c.on ? r1(c.os / c.on) : null, boil: Math.min(30, Math.round(c.boil)) });
    this.prune();
    this.flush();
  }

  prune(now = Date.now()) {
    if (this.data.start == null) return;
    const drop = Math.floor((now - this.keepDays() * DAY - this.data.start) / HALF);
    if (drop <= 0) return;
    for (const r of Object.values(this.data.rooms)) { r.t.splice(0, drop); r.g.splice(0, drop); r.h.splice(0, drop); r.rh?.splice(0, drop); }
    this.data.out.splice(0, drop); this.data.boil.splice(0, drop);
    this.data.start += drop * HALF;
  }

  /** The first half hour with anything in it, or null. */
  firstAt() {
    if (this.data.start == null) return null;
    const any = (i) => this.data.out[i] != null || Object.values(this.data.rooms).some((r) => r.t[i] != null);
    const n = Math.max(this.data.out.length, ...Object.values(this.data.rooms).map((r) => r.t.length), 0);
    for (let i = 0; i < n; i++) if (any(i)) return this.data.start + i * HALF;
    return null;
  }

  /** The last half hour kept (not the one being gathered), or null. */
  lastAt() {
    if (this.data.start == null) return null;
    const n = Math.max(this.data.out.length, ...Object.values(this.data.rooms).map((r) => r.t.length), 0);
    return n ? this.data.start + (n - 1) * HALF : null;
  }

  /** One half hour's figures (the one being gathered too, so far), or null. */
  at(b) {
    if (this.cur && this.cur.b === b) {
      const c = this.cur; const rooms = {};
      for (const [id, r] of Object.entries(c.rooms)) rooms[id] = { t: r.tn ? r1(r.ts / r.tn) : null, g: r.gn ? r1(r.gs / r.gn) : null, h: Math.round(r.h), rh: r.hn ? r1(r.hs / r.hn) : null };
      return { rooms, out: c.on ? r1(c.os / c.on) : null, boil: Math.round(c.boil) };
    }
    if (this.data.start == null || b < this.data.start) return null;
    const i = Math.round((b - this.data.start) / HALF);
    const rooms = {};
    for (const [id, r] of Object.entries(this.data.rooms)) if (r.t[i] != null || r.h[i] != null || r.rh?.[i] != null) rooms[id] = { t: r.t[i] ?? null, g: r.g[i] ?? null, h: r.h[i] ?? null, rh: r.rh?.[i] ?? null };
    const out = this.data.out[i] ?? null; const boil = this.data.boil[i] ?? null;
    return Object.keys(rooms).length || out != null || boil != null ? { rooms, out, boil } : null;
  }

  flush() {
    if (!this.file) return;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ ...this.data, cur: this.cur }));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { /* tried again at the next half hour */ }
  }

  /**
   * Fill in half hours with nothing kept, from Home Assistant's history (it keeps about 10 days):
   * the first time, and after the app was stopped. A day at a time, so no one answer is huge.
   */
  async fillFromHistory(engine, { from, to = Date.now() } = {}) {
    // a room's humidity, the first time it has one: the last 10 days of it from Home Assistant too
    const want = engine.zones.filter((z) => z.enabled)
      .map((z) => [z.id, (engine.humiditySources?.(z) || []).join(',')])
      .filter(([id, src]) => src && this.data.rhDone?.[id] !== src);
    const rhFrom = want.length ? to - 10 * DAY : Infinity;
    from = Math.min(from, rhFrom);
    const start = Math.ceil(from / HALF) * HALF;
    const end = Math.floor(to / HALF) * HALF - HALF; // whole half hours, not the one being gathered
    let filled = 0; let failed = false;
    for (let a = start; a <= end; a += DAY) {
      const b = Math.min(end + HALF, a + DAY);
      // only where nothing was kept
      const missing = [];
      for (let t = a; t < b; t += HALF) {
        const x = this.at(t);
        if (!x || (t >= rhFrom && want.some(([id]) => x.rooms[id]?.rh == null))) missing.push(t);
      }
      if (!missing.length) continue;
      const got = await halfHoursFromHistory(engine, a, b).catch(() => null);
      if (!got) { failed = true; continue; }
      for (const t of missing) {
        const x = got.get(t);
        if (x && (x.out != null || Object.values(x.rooms).some((r) => r.t != null || r.rh != null))) { this.put(t, x, { onlyGaps: true }); filled++; }
      }
    }
    if (!failed && want.length) { this.data.rhDone ||= {}; for (const [id, src] of want) this.data.rhDone[id] = src; }
    if (filled || (!failed && want.length)) { this.prune(); this.flush(); }
    return filled;
  }
}

/** Half-hour figures between a and b from Home Assistant's history, the app's log of heat-ups and targets. */
async function halfHoursFromHistory(engine, a, b) {
  const ha = engine.ha; const s = engine.s;
  const zones = engine.zones.filter((z) => z.enabled);
  const outsideId = s.outsideEntity || detectOutsideEntity(ha);
  const boilerId = s.boiler?.entity;
  const ids = new Set();
  const humid = Object.fromEntries(zones.map((z) => [z.id, engine.humiditySources?.(z) || []]));
  for (const z of zones) { if (z.sensor) ids.add(z.sensor); else (z.trvs || []).forEach((e) => ids.add(e)); humid[z.id].forEach((e) => ids.add(e)); }
  if (outsideId) ids.add(outsideId);
  if (boilerId) ids.add(boilerId);
  if (!ids.size) return new Map();
  const res = await ha.send({
    type: 'history/history_during_period', start_time: new Date(a).toISOString(), end_time: new Date(b).toISOString(),
    entity_ids: [...ids], include_start_time_state: true, significant_changes_only: false, minimal_response: false, no_attributes: false,
  }, 60000);
  // a value every 5 minutes, averaged over each half hour
  const STEP5 = 5 * 60000;
  const at5 = (rows, pick) => { const out = []; let i = 0; let cur = null; for (let t = a; t < b; t += STEP5) { while (i < rows.length && rows[i].t <= t) { cur = pick(rows[i]); i++; } out.push(cur); } return out; };
  const halves = (vals) => { const out = []; for (let k = 0; k < vals.length; k += 6) { const v = vals.slice(k, k + 6).filter((x) => x != null); out.push(v.length >= 3 ? r1(v.reduce((p, q) => p + q, 0) / v.length) : null); } return out; };
  const minutesIn = (intervals, t0) => Math.round(intervals.reduce((m, [x, y]) => m + Math.max(0, Math.min(y, t0 + HALF) - Math.max(x, t0)), 0) / 60000);
  const tz = ha.timeZone || 'UTC';
  const map = new Map();
  for (let t = a; t < b; t += HALF) map.set(t, { rooms: {}, out: null, boil: null });
  const keys = [...map.keys()];
  if (outsideId) halves(at5(rowsFor(res, outsideId), tempOf(outsideId))).forEach((v, k) => { if (keys[k] != null) map.get(keys[k]).out = v; });
  if (boilerId) {
    const rows = rowsFor(res, boilerId);
    if (rows.length) {
      const firing = (r) => (boilerId.startsWith('climate.') ? r.a?.hvac_action === 'heating' : r.s === 'on');
      const runs = []; let st = null;
      for (const r of rows) { const t = Math.max(r.t, a); if (firing(r) && st == null) st = t; if (!firing(r) && st != null) { runs.push([st, t]); st = null; } }
      if (st != null) runs.push([st, b]);
      for (const t of keys) map.get(t).boil = minutesIn(runs, t);
    }
  }
  for (const z of zones) {
    const sources = z.sensor ? [z.sensor] : (z.trvs || []);
    const series = sources.map((id) => at5(rowsFor(res, id), tempOf(id)));
    const temps = series[0] ? series[0].map((_, k) => { const v = series.map((x) => x[k]).filter((x) => x != null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; }) : [];
    const t30 = halves(temps);
    const hs = humid[z.id].map((id) => at5(rowsFor(res, id), humidOf(id)));
    const rh30 = hs.length ? halves(hs[0].map((_, k) => { const v = hs.map((x) => x[k]).filter((x) => x != null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; })) : [];
    // targets: the app's log where it has them, the schedule before that
    const log = engine.targetLog?.data?.[z.id] || [];
    const tg = keys.map((t) => {
      let v = null; for (const [at, temp] of log) { if (at <= t + HALF / 2) v = temp; else break; }
      return v ?? scheduledAt(z.schedule, localWeekPosition(new Date(t + HALF / 2), tz))?.temp ?? null;
    });
    // heating: the app's log of heat-ups, while it still has them (Settings → History)
    const calls = engine.callLog ? engine.callLog.intervals(z.id, a, b) : [];
    const known = engine.callLog && engine.callLog.started <= a && (engine.callLog.zones[z.id]?.[0]?.[0] ?? Infinity) <= a + DAY;
    keys.forEach((t, k) => {
      map.get(t).rooms[z.id] = { t: t30[k] ?? null, g: tg[k], h: calls.length || known ? minutesIn(calls, t) : null, rh: rh30[k] ?? null };
    });
  }
  return map;
}

// ---------- the History chart ----------

/** How far apart the points are for a range: about 300 points or fewer. */
export function stepFor(span) {
  if (span <= 26 * H) return 5 * 60000;
  if (span <= 2.2 * DAY) return 10 * 60000;
  if (span <= 3.6 * DAY) return 15 * 60000;
  if (span <= 8 * DAY) return HALF;
  if (span <= 16 * DAY) return H;
  if (span <= 45 * DAY) return 3 * H;
  if (span <= 120 * DAY) return 6 * H;
  return DAY;
}

const offsetMs = (t, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000;
};
/** The start of the step t is in, in local time (a day starts at local midnight). */
export function bucketOf(t, step, tz) {
  const off = offsetMs(t, tz);
  return Math.floor((t + off) / step) * step - off;
}

/** Heating minutes per point, as heat-ups for the chart: from the start of each point, merged where they meet. */
function asIntervals(times, step, minutes) {
  const out = [];
  times.forEach((t, i) => {
    const m = minutes[i];
    if (!m) return;
    const end = t + Math.min(step, m * 60000);
    const last = out[out.length - 1];
    if (last && last[1] >= t - 1000) last[1] = Math.max(last[1], end); else out.push([t, end]);
  });
  return out;
}

/**
 * Each room's temperature, target and heating, outside and the boiler, between from and to.
 * The same shape as /api/today, so the chart draws either.
 */
export async function buildHistory(engine, { from, to = Date.now(), now = Date.now(), precise = null } = {}) {
  const ha = engine.ha;
  const tz = ha.timeZone || 'UTC';
  to = Math.min(to, now);
  if (!(to > from)) throw new Error('Choose a start before the end');
  const span = to - from;
  const asked = from;
  let step = stepFor(span);
  // within Home Assistant's own history (about 10 days), up to 3½ days is drawn straight from it
  if (precise ?? (step < HALF && from >= now - 9.5 * DAY)) return historyPrecise(engine, { from, to, step, tz });

  const log = engine.longLog;
  const zones = engine.zones.filter((z) => z.enabled);
  // Before the half-hourly figures (and heat-ups) start: two weeks or more is drawn in days, from
  // the daily figures; a shorter range starts where they do
  const detailFrom = log?.firstAt() ?? null;
  const firstCall = engine.callLog ? Math.min(...zones.map((z) => engine.callLog.intervals(z.id, from, to)[0]?.[0] ?? Infinity)) : Infinity;
  const dataFrom = Math.min(detailFrom ?? Infinity, firstCall);
  if (step < DAY && dataFrom > from + step) {
    const days = Object.keys(engine.dailyLog?.days || {});
    const earlier = days.some((k) => k >= localDate(from, tz) && k < localDate(Math.min(dataFrom, to), tz)); // (nothing kept yet: Infinity)
    if (earlier && span >= 14 * DAY) step = DAY;
    else if (dataFrom < to) { from = dataFrom; step = Math.max(HALF, stepFor(to - from)); } // (finer, for what's left)
  }
  const first = bucketOf(from, step, tz);
  const times = [];
  for (let t = first; t <= to;) {
    times.push(t);
    const next = bucketOf(t + step + (step >= DAY ? 2 * H : 0), step, tz); // (a day can be 23 or 25 hours)
    t = next > t ? next : t + step;
  }
  const n = times.length;
  const temps = Object.fromEntries(zones.map((z) => [z.id, Array(n).fill(null)]));
  const targets = Object.fromEntries(zones.map((z) => [z.id, Array(n).fill(null)]));
  const humid = Object.fromEntries(zones.map((z) => [z.id, Array(n).fill(null)]));
  const heat = Object.fromEntries(zones.map((z) => [z.id, Array(n).fill(0)]));
  const out = Array(n).fill(null); const boil = Array(n).fill(0);
  // averages of each point's half hours
  const acc = times.map(() => ({ rooms: {}, os: 0, on: 0 }));
  let k = 0;
  for (let t = Math.floor(first / HALF) * HALF; t <= to; t += HALF) {
    while (k + 1 < n && times[k + 1] <= t) k++;
    if (t < times[k]) continue;
    const x = log?.at(t);
    if (!x) continue;
    const a = acc[k];
    if (x.out != null) { a.os += x.out; a.on++; }
    if (x.boil != null) boil[k] += x.boil;
    for (const z of zones) {
      const r = x.rooms[z.id];
      if (!r) continue;
      const q = (a.rooms[z.id] ||= { ts: 0, tn: 0, gs: 0, gn: 0, hs: 0, hn: 0 });
      if (r.t != null) { q.ts += r.t; q.tn++; }
      if (r.rh != null) { q.hs += r.rh; q.hn++; }
      if (r.g != null) { q.gs += r.g; q.gn++; }
      if (r.h != null) heat[z.id][k] += r.h;
    }
  }
  acc.forEach((a, i) => {
    if (a.on) out[i] = r1(a.os / a.on);
    for (const z of zones) {
      const q = a.rooms[z.id];
      if (q?.tn) temps[z.id][i] = r1(q.ts / q.tn);
      if (q?.gn) targets[z.id][i] = r1(q.gs / q.gn);
      if (q?.hn) humid[z.id][i] = Math.round(q.hs / q.hn);
    }
  });
  // before the half-hourly log: the daily figures, for points of 6 hours or more
  let dailyUntil = null;
  if (step >= 6 * H && engine.dailyLog?.days) {
    times.forEach((t, i) => {
      if (detailFrom != null && t >= detailFrom) return;
      if (out[i] != null || zones.some((z) => temps[z.id][i] != null)) return;
      const d = engine.dailyLog.days[localDate(t, tz)];
      if (!d) return;
      const share = Math.min(1, step / DAY);
      if (d.outN) out[i] = r1(d.outSum / d.outN);
      boil[i] = (d.boilerMin || 0) * share;
      for (const z of zones) {
        const r = d.rooms?.[z.id];
        if (!r) continue;
        if (r.tempN) temps[z.id][i] = r1(r.tempSum / r.tempN);
        heat[z.id][i] = (r.callMin || 0) * share;
      }
      dailyUntil = Math.max(dailyUntil ?? 0, t + step);
    });
  }
  const end = to;
  // heat-ups as they happened while the app still has them (Settings → History), and from the
  // minutes heated in each point before that
  // (the app keeps each heat-up for Settings → History's days; before that, minutes per point)
  const exactFrom = engine.callLog ? Math.max(engine.callLog.started ?? 0, now - (engine.callLog.keepDays?.() ?? 7) * DAY) : Infinity;
  const calls = (z) => {
    const exact = engine.callLog ? engine.callLog.intervals(z.id, Math.max(from, exactFrom), end) : [];
    const coarse = asIntervals(times, step, heat[z.id].map((m, i) => (times[i] + step <= exactFrom ? m : 0)));
    return [...coarse, ...exact.map(([a, b, why, tg]) => [a, b, why, tg])];
  };
  const rooms = zones.map((z) => ({
    id: z.id, name: z.name, temps: temps[z.id], targets: targets[z.id], calls: calls(z),
    heatedMinutes: Math.round(heat[z.id].reduce((p, q) => p + q, 0)),
    ...humiditySeries(temps[z.id], humid[z.id], out),
  }));
  const outsideId = engine.s.outsideEntity || detectOutsideEntity(ha);
  return {
    from: times[0], to: times[n - 1], end, step, times, rooms,
    boilerRuns: asIntervals(times, step, boil), boilerMinutes: Math.round(boil.reduce((p, q) => p + q, 0)),
    outside: outsideId && out.some((v) => v != null) ? { entity: outsideId, series: out } : null,
    detailFrom, dailyUntil, asked, source: 'log',
  };
}

/** Up to 3½ days within Home Assistant's history: every 5 to 15 minutes, straight from it. */
async function historyPrecise(engine, { from, to, step, tz }) {
  const ha = engine.ha; const s = engine.s;
  const zones = engine.zones.filter((z) => z.enabled);
  const outsideId = s.outsideEntity || detectOutsideEntity(ha);
  const boilerId = s.boiler?.entity;
  const t0 = Math.floor(from / step) * step;
  const t1 = Math.floor(to / step) * step;
  const ids = new Set();
  const humidSrc = Object.fromEntries(zones.map((z) => [z.id, engine.humiditySources?.(z) || []]));
  for (const z of zones) { if (z.sensor) ids.add(z.sensor); else (z.trvs || []).forEach((e) => ids.add(e)); humidSrc[z.id].forEach((e) => ids.add(e)); }
  if (outsideId) ids.add(outsideId);
  if (boilerId) ids.add(boilerId);
  let res = {};
  try {
    res = await ha.send({
      type: 'history/history_during_period', start_time: new Date(t0).toISOString(), end_time: new Date(t1 + step).toISOString(),
      entity_ids: [...ids], include_start_time_state: true, significant_changes_only: false, minimal_response: false, no_attributes: false,
    }, 60000);
  } catch (e) {
    return { error: `Couldn't read history from Home Assistant: ${e.message}` };
  }
  const times = [];
  for (let t = t0; t <= t1; t += step) times.push(t);
  const at = (rows, pick) => { const out = []; let i = 0; let cur = null; for (const t of times) { while (i < rows.length && rows[i].t <= t) { cur = pick(rows[i]); i++; } out.push(cur); } return out; };
  const runs = [];
  if (boilerId) {
    const firing = (r) => (boilerId.startsWith('climate.') ? r.a?.hvac_action === 'heating' : r.s === 'on');
    let st = null;
    for (const r of rowsFor(res, boilerId)) { const t = Math.max(r.t, t0); if (firing(r) && st == null) st = t; if (!firing(r) && st != null) { runs.push([st, t]); st = null; } }
    if (st != null) runs.push([st, Math.min(Date.now(), t1 + step)]);
  }
  const outside = outsideId ? at(rowsFor(res, outsideId), tempOf(outsideId)) : null;
  const rooms = zones.map((z) => {
    const sources = z.sensor ? [z.sensor] : (z.trvs || []);
    const series = sources.map((id) => at(rowsFor(res, id), tempOf(id)));
    const temps = times.map((_, k) => { const v = series.map((x) => x[k]).filter((x) => x != null); return v.length ? r1(v.reduce((p, q) => p + q, 0) / v.length) : null; });
    const hs = humidSrc[z.id].map((id) => at(rowsFor(res, id), humidOf(id)));
    const humidity = hs.length ? times.map((_, k) => { const v = hs.map((x) => x[k]).filter((x) => x != null); return v.length ? Math.round(v.reduce((p, q) => p + q, 0) / v.length) : null; }) : null;
    const log = engine.targetLog?.data?.[z.id] || [];
    let li = 0; let logged = null;
    const targets = times.map((t) => {
      while (li < log.length && log[li][0] <= t) { logged = log[li][1]; li++; }
      return logged ?? scheduledAt(z.schedule, localWeekPosition(new Date(t), tz))?.temp ?? null;
    });
    const calls = engine.callLog ? engine.callLog.intervals(z.id, t0, Math.min(Date.now(), t1 + step)) : [];
    return { id: z.id, name: z.name, temps, targets, calls, heatedMinutes: Math.round(calls.reduce((m, [a, b]) => m + (b - a), 0) / 60000), ...humiditySeries(temps, humidity, outside) };
  });
  return {
    from: t0, to: t1, end: to, step, times, rooms, boilerRuns: runs,
    boilerMinutes: Math.round(runs.reduce((m, [a, b]) => m + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0) / 60000),
    outside: outsideId && outside.some((v) => v != null) ? { entity: outsideId, series: outside } : null,
    detailFrom: engine.longLog?.firstAt() ?? null, dailyUntil: null, source: 'ha',
  };
}

/** A room's humidity for the chart, and how humid its coldest spots were (none: left out). */
export function humiditySeries(temps, humidity, outside) {
  if (!humidity || !humidity.some((v) => v != null)) return {};
  return { humidity, coldSpot: outside ? coldSeries(temps, humidity, outside) : null };
}

export { BAD };
