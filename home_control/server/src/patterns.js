// Patterns: what people keep changing by hand, turned into schedule changes.
//
// Each part (heating, lighting) reports every change a person makes to a room or group (a radiator
// knob, the Hive app, a hold or boost in the app, a light switched at the wall, Home Assistant,
// Alexa) along with what the schedule wanted then. Once a night (and a few minutes after a change)
// this looks for repeats: the same kind of change, in the same room or group, at about the same
// time, on most of the same weekday (3 of the last 4 Fridays) or most days (6 of the last 7, 4 of
// the last 5 weekdays, 3 of the last 4 weekend days). Each repeat becomes a concrete schedule change,
// suggested on the part's page, or made straight away if that room or group is set to change its
// schedule automatically (with an Undo).
//
// A part registers an adapter (see heating/learn.js and lighting/learn.js) that knows its schedules
// and values; this file knows nothing about temperatures or brightness.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zonedParts, localDate, dateKey, addDays, zonedToUtc } from './lighting/schedule.js';

export const LEARN_MODES = ['off', 'suggest', 'auto'];
const DAY = 86400000;
const WINDOW_DAYS = 28;        // look back this far
const KEEP_DAYS = 35;          // keep changes this long
const MERGE_MS = 2 * 60000;    // changes this close together are one change (three presses of +)
const MIN_MINUTES = 10;        // a change undone sooner than this doesn't count
const NEAR = 30;               // minutes: changes this close are "about the same time"
const SPAN = 60;               // and a cluster of them spans no more than this
const PREV_NEAR = 30;          // a scheduled change this soon before is changed rather than added to
const LATER_DAYS = 7;          // "Not now"
const UNDONE_DAYS = 30;        // not suggested again for this long after an Undo
const APPLIED_KEEP_DAYS = 7;   // Undo is offered this long
const RUN_AT = 3 * 60 + 30;    // 03:30 local, every night

export const DAY_PLURAL = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const WEEKDAYS = [0, 1, 2, 3, 4];
const WEEKEND = [5, 6];

const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
export const hhmm = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const round5 = (min) => Math.min(1435, Math.round(min / 5) * 5);
const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/** "every day", "on weekdays", "at weekends", "on Fridays", "on Fridays and Saturdays" */
export function daysText(days) {
  const d = [...days].sort((a, b) => a - b);
  if (d.length === 7) return 'every day';
  if (d.join() === WEEKDAYS.join()) return 'on weekdays';
  if (d.join() === WEEKEND.join()) return 'at weekends';
  return `on ${list(d.map((x) => DAY_PLURAL[x]))}`;
}

/**
 * Group one room's or group's changes into clusters: the same kind of change (cls) at about the
 * same time of day. events: [{ at, min, cls, ... }]
 */
export function clusters(events) {
  const out = [];
  const byCls = new Map();
  for (const e of events) { if (!byCls.has(e.cls)) byCls.set(e.cls, []); byCls.get(e.cls).push(e); }
  for (const [cls, evs] of byCls) {
    const sorted = [...evs].sort((a, b) => a.min - b.min);
    let cur = null;
    for (const e of sorted) {
      if (cur && e.min - cur.last <= NEAR && e.min - cur.first <= SPAN) { cur.events.push(e); cur.last = e.min; continue; }
      cur = { cls, first: e.min, last: e.min, events: [e] };
      out.push(cur);
    }
  }
  return out;
}

/**
 * Which days of the week a cluster happens on, and how sure: each weekday on 3 of its last 4 (or
 * 3 of 3), or most days, weekdays or weekend days lately. Days before `since` (when watching
 * started) don't count either way. Returns { days: [dow], hits, of, unit } or null.
 */
export function daysFor(cluster, { now, tz, since }) {
  const today = localDate(now, tz);
  const sinceKey = dateKey(localDate(since, tz));
  const hitDays = new Set(cluster.events.map((e) => e.day));
  // the observed days before today, newest first (today counts only if it's already happened)
  const dates = [];
  for (let i = 1; i <= WINDOW_DAYS; i++) {
    const d = addDays(today, -i);
    if (dateKey(d) < sinceKey) break;
    dates.push(d);
  }
  if (hitDays.has(dateKey(today))) dates.unshift(today);
  const hit = (d) => hitDays.has(dateKey(d));
  const recent = (test, n) => dates.filter((d) => test(d.dow)).slice(0, n);
  const days = new Set();
  for (let dow = 0; dow < 7; dow++) {
    const occ = recent((x) => x === dow, 4);
    const h = occ.filter(hit).length;
    if (occ.length >= 3 && h >= 3 && h >= occ.length - 1) days.add(dow);
  }
  const last7 = recent(() => true, 7);
  if (last7.length === 7 && last7.filter(hit).length >= 6) for (let d = 0; d < 7; d++) days.add(d);
  const wk = recent((x) => x < 5, 5);
  if (wk.length === 5 && wk.filter(hit).length >= 4) WEEKDAYS.forEach((d) => days.add(d));
  const we = recent((x) => x >= 5, 4);
  if (we.length === 4 && we.filter(hit).length >= 3) WEEKEND.forEach((d) => days.add(d));
  if (!days.size) return null;
  return { days: [...days].sort((a, b) => a - b), ...evidence([...days], dates, hit) };
}

/** "on 4 of the last 4 Fridays", over the days a pattern covers. */
function evidence(days, dates, hit) {
  const set = new Set(days);
  const all = days.length === 7; const wk = days.join() === WEEKDAYS.join(); const we = days.join() === WEEKEND.join();
  const n = all ? 7 : wk ? 5 : we ? 4 : 4 * days.length; // the same spans the rules above look at
  const occ = dates.filter((d) => set.has(d.dow)).slice(0, n);
  const unit = all ? 'days' : wk ? 'weekdays' : we ? 'weekend days' : list(days.map((x) => DAY_PLURAL[x]));
  return { hits: occ.filter(hit).length, of: occ.length, unit, dates: occ.filter(hit).map(dateKey) };
}

export function evidenceText({ hits, of, unit }) {
  if (hits === of) return of === 1 ? `on the last ${unit.replace(/s$/, '')}` : `on each of the last ${of} ${unit}`;
  return `on ${hits} of the last ${of} ${unit}`;
}

/**
 * What one day's schedule becomes. points: [{ min, value, raw }] sorted; before: the value in force
 * as the day starts. Change { min, value, endMin }: from `min` it's `value`, until `endMin` (back to
 * what the schedule had then) or the next scheduled change. A scheduled change up to 30 minutes
 * before is changed instead (people undoing it, so it's its value that's wrong, not its time); a
 * scheduled change after it to the same value is dropped (the same change, just earlier).
 * Returns { points, how: 'added' | 'changed' | 'moved', at, was, wasValue } or null if nothing changes.
 */
export function planDay(points, before, change, same) {
  const pts = points.map((p) => ({ ...p }));
  const valueAt = (m) => { let v = before; for (const p of points) if (p.min <= m) v = p.value; return v; };
  const { min: T, value: V } = change;
  if (valueAt(T) != null && same(valueAt(T), V)) return null;
  const endValue = change.endMin != null ? valueAt(change.endMin) : null;
  const nextAfter = points.find((p) => p.min > T) || null;
  let prev = null;
  for (const p of pts) if (p.min <= T) prev = p;
  let how = 'added'; let at = T; let was = null; let wasValue = null;
  if (prev && change.endMin == null && T - prev.min <= PREV_NEAR && !same(prev.value, V)) {
    wasValue = prev.value; prev.value = V; prev.changed = true; how = 'changed'; at = prev.min;
  } else {
    pts.push({ min: T, value: V, added: true });
  }
  if (change.endMin != null && change.endMin > T && (!nextAfter || change.endMin < nextAfter.min) && endValue != null && !same(endValue, V)) {
    pts.push({ min: change.endMin, value: endValue, added: true });
  } else if (nextAfter && same(nextAfter.value, V) && how === 'added') {
    // the same change, just earlier: "instead of 23:00"
    const i = pts.findIndex((p) => p.min === nextAfter.min && !p.added);
    if (i >= 0) { pts.splice(i, 1); how = 'moved'; was = nextAfter.min; }
  }
  pts.sort((a, b) => a.min - b.min);
  return { points: pts, how, at, was, wasValue, end: change.endMin ?? null };
}

/** Find the patterns in one room's or group's changes. */
export function findPatterns(events, { now, tz, since }) {
  const recent = events.filter((e) => e.at >= now - WINDOW_DAYS * DAY && e.cls);
  const out = [];
  for (const c of clusters(recent)) {
    const d = daysFor(c, { now, tz, since });
    if (!d) continue;
    // the first change of each day it happened, on the days the pattern covers
    const firsts = new Map();
    for (const e of [...c.events].sort((a, b) => a.at - b.at)) if (d.days.includes(e.dow) && !firsts.has(e.day)) firsts.set(e.day, e);
    const evs = [...firsts.values()];
    if (evs.length < 3) continue;
    const ends = evs.map((e) => e.endMin).filter((m) => m != null);
    out.push({
      cls: c.cls, days: d.days, min: round5(median(evs.map((e) => e.min))),
      values: evs.map((e) => e.value),
      endMin: ends.length * 2 > evs.length ? round5(median(ends)) : null,
      hits: d.hits, of: d.of, unit: d.unit, dates: d.dates, events: evs.map((e) => ({ at: e.at, value: e.value })),
    });
  }
  return out;
}

/** The local weekday, date and minute of an instant. */
export function whenParts(at, tz) {
  const p = zonedParts(at, tz);
  return { dow: p.dow, min: p.minutes, day: dateKey(localDate(at, tz)) };
}

/** The first instant after `after` at a local weekday (null: any day) and minute. */
export function nextAt(after, tz, minutes, dow = null) {
  const start = localDate(after, tz);
  for (let i = 0; i <= 8; i++) {
    const d = addDays(start, i);
    if (dow != null && d.dow !== dow) continue;
    const t = zonedToUtc(d.year, d.month, d.day, minutes, tz);
    if (t > after) return t;
  }
  return null;
}

/** The value in force as a day starts: the last change on the days before it. */
function valueBefore(a, item, dow) {
  for (let k = 1; k <= 7; k++) {
    const pts = a.dayPoints(item, (dow - k + 7) % 7);
    if (pts.length) return pts[pts.length - 1].value;
  }
  return null;
}

// ---------- the watcher ----------

export class Patterns {
  constructor({ dataDir, tz = () => 'UTC', log = console, now = () => Date.now() }) {
    this.file = dataDir ? path.join(dataDir, 'patterns.json') : null;
    this.tz = tz;
    this.log = log;
    this.now = now;
    this.adapters = new Map();
    this.data = { parts: {} };
    try { if (this.file) this.data = { parts: {}, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* first start */ }
    this.timer = null;
    this.soonTimer = null;
  }

  part(name) {
    return (this.data.parts[name] ||= { since: null, events: [], suggestions: [], ignore: [], applied: [], backfilled: false });
  }

  save() {
    if (!this.file) return;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) { this.log.warn?.(`Couldn't save patterns: ${err.message}`); }
  }

  /**
   * A part's adapter:
   *   items() [{ id, name, mode }]          dayPoints(id, dow) [{ min, value, raw }] (sorted)
   *   cls(value, base) kind of change|null  same(a, b)   typical(values, cls)   words({...}) { why, change }
   *   write(id, { dow: points }, note)      read(id, days) { dow: raw }   writeRaw(id, { dow: raw }, note)
   *   history() { since, events } (once)    changed() (suggestions changed: refresh the page)
   */
  register(name, adapter) {
    this.adapters.set(name, adapter);
    const P = this.part(name);
    if (!P.since) P.since = this.now();
    if (!P.backfilled && adapter.history) {
      try {
        const h = adapter.history() || { events: [] };
        for (const e of h.events) this.#add(name, e, { quiet: true });
        if (h.since && h.since < P.since) P.since = h.since;
        if (h.events.length) this.log.info?.(`Patterns: ${h.events.length} earlier ${name} change(s) read from Activity`);
      } catch (err) { this.log.warn?.(`Patterns: couldn't read earlier ${name} changes: ${err.message}`); }
      P.backfilled = true;
    }
    this.save();
  }

  /**
   * A person changed a room or group. e: { item, at, value, base, until, src }. The adapter says
   * what kind of change it is (cls: up/down, off/on/dim/bright, or null if it matches the schedule).
   */
  record(name, e) {
    if (!this.adapters.has(name)) return;
    this.#add(name, e);
    this.save();
    this.runSoon();
  }

  #add(name, e, { quiet = false } = {}) {
    const a = this.adapters.get(name);
    const P = this.part(name);
    const cls = e.base == null ? null : a.cls(e.value, e.base);
    const open = [...P.events].reverse().find((x) => x.item === e.item);
    if (open && e.at >= open.at && open.endedAt == null && (open.until == null || open.until > e.at)) {
      if (e.at - open.at < MERGE_MS) {
        // the same change still being made (three presses of +): keep where it started
        if (!cls) { P.events.splice(P.events.indexOf(open), 1); return; }
        Object.assign(open, { value: e.value, cls, until: e.until ?? null, src: e.src || open.src });
        return;
      }
      open.endedAt = e.at;
    }
    if (!cls) return;
    const w = whenParts(e.at, this.tz());
    P.events.push({ item: e.item, at: e.at, ...w, value: e.value, base: e.base, cls, until: e.until ?? null, endedAt: e.endedAt ?? null, src: e.src || null });
    const cutoff = this.now() - KEEP_DAYS * DAY;
    if (!quiet) P.events = P.events.filter((x) => x.at >= cutoff).slice(-3000);
  }

  /** Back to the schedule (or the mode changed): the change in force ended now. item null: every one. */
  ended(name, item, at = this.now()) {
    const P = this.data.parts[name];
    if (!P) return;
    let changed = false;
    for (const e of P.events) {
      if ((item == null || e.item === item) && e.endedAt == null && (e.until == null || e.until > at)) { e.endedAt = at; changed = true; }
    }
    if (changed) this.save();
  }

  runSoon(ms = 5 * 60000) {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.run(), ms);
    this.soonTimer.unref?.();
  }

  start() {
    this.runSoon(60000);
    this.timer = setInterval(() => {
      const p = zonedParts(this.now(), this.tz());
      const key = dateKey(localDate(this.now(), this.tz()));
      if (p.minutes >= RUN_AT && this.data.lastRun !== key) { this.data.lastRun = key; this.run(); }
    }, 10 * 60000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); clearTimeout(this.soonTimer); }

  /** Each change's minute it ended (if it ended well before the next scheduled change), and whether it lasted. */
  #effective(e, a, tz) {
    const end = Math.min(e.until ?? Infinity, e.endedAt ?? Infinity);
    if (end !== Infinity && end - e.at < MIN_MINUTES * 60000) return null;
    let endMin = null;
    if (end !== Infinity && end - e.at <= 6 * 3600000) {
      const w = whenParts(end, tz);
      const next = a.dayPoints(e.item, e.dow).find((p) => p.min > e.min)?.min ?? null;
      if (w.day === e.day && w.min > e.min && (next == null || w.min < next - 10)) endMin = w.min;
    }
    return { ...e, endMin };
  }

  /** Look for patterns now: suggest them, or make them where a room or group changes itself. */
  run() {
    const now = this.now();
    const tz = this.tz();
    let changed = false;
    for (const [name, a] of this.adapters) {
      const P = this.part(name);
      P.ignore = P.ignore.filter((x) => x.until == null || x.until > now);
      P.applied = P.applied.filter((x) => now - x.at < APPLIED_KEEP_DAYS * DAY);
      const fresh = [];
      for (const item of a.items()) {
        if (item.mode === 'off') continue;
        const evs = P.events.filter((e) => e.item === item.id).map((e) => this.#effective(e, a, tz)).filter(Boolean);
        for (const f of findPatterns(evs, { now, tz, since: P.since })) {
          const s = this.#suggestion(name, a, item, f);
          if (!s) continue;
          if (item.mode === 'auto') {
            try { this.#apply(name, a, s, { auto: true }); changed = true; } catch (err) { this.log.warn?.(`Patterns: ${err.message}`); }
          } else fresh.push(s);
        }
      }
      const before = JSON.stringify(P.suggestions.map((s) => s.id));
      P.suggestions = fresh;
      if (before !== JSON.stringify(fresh.map((s) => s.id))) changed = true;
    }
    if (changed) this.save();
    for (const a of this.adapters.values()) a.changed?.();
  }

  #suggestion(name, a, item, f) {
    const P = this.part(name);
    const value = a.typical(f.values, f.cls);
    // only the days where the schedule doesn't already do it
    const plans = {};
    for (const dow of f.days) {
      const plan = planDay(a.dayPoints(item.id, dow), valueBefore(a, item.id, dow), { min: f.min, value, endMin: f.endMin }, a.same);
      if (plan) plans[dow] = plan;
    }
    const days = Object.keys(plans).map(Number);
    if (!days.length) return null;
    const ignored = P.ignore.some((x) => x.item === item.id && x.cls === f.cls && Math.abs(x.min - f.min) <= 45 && x.days.some((d) => days.includes(d)));
    if (ignored) return null;
    const key = `${name}|${item.id}|${f.cls}|${f.min}|${days.join('')}|${JSON.stringify(value)}`;
    const id = createHash('sha1').update(key).digest('hex').slice(0, 10);
    const words = a.words({ item, cls: f.cls, value, min: f.min, endMin: f.endMin, days, plan: plans[days[0]], evidence: evidenceText(f), when: daysText(days) });
    return {
      id, part: name, item: item.id, name: item.name, cls: f.cls, min: f.min, endMin: f.endMin, days, value,
      hits: f.hits, of: f.of, unit: f.unit, dates: f.dates, why: words.why, change: words.change, plans,
    };
  }

  #apply(name, a, s, { auto = false } = {}) {
    const P = this.part(name);
    const before = a.read(s.item, s.days);
    const after = {};
    for (const dow of s.days) after[dow] = s.plans[dow].points;
    const text = `${s.name}: schedule changed ${auto ? 'automatically' : 'from a suggestion'}: ${s.change.charAt(0).toLowerCase()}${s.change.slice(1)}, as ${s.why.replace(/\.$/, '')}.`;
    a.write(s.item, after, text);
    const written = a.read(s.item, s.days);
    P.applied.unshift({ id: s.id, item: s.item, name: s.name, at: this.now(), auto, change: s.change, why: s.why, before, after: written, cls: s.cls, min: s.min, days: s.days });
    P.applied = P.applied.slice(0, 20);
    P.suggestions = P.suggestions.filter((x) => x.id !== s.id);
  }

  // ---------- for the pages ----------

  view(name) {
    const P = this.data.parts[name];
    if (!P) return { suggestions: [], applied: [] };
    const strip = ({ plans, ...s }) => s;
    return {
      suggestions: P.suggestions.map(strip),
      applied: P.applied.filter((x) => !x.undone).map(({ before, after, ...x }) => x),
      since: P.since,
    };
  }

  act(name, id, action) {
    const a = this.adapters.get(name);
    const P = this.data.parts[name];
    const s = P?.suggestions.find((x) => x.id === id);
    if (!a || !s) throw new Error('That suggestion has gone: the schedule may have changed already');
    if (action === 'apply') this.#apply(name, a, s);
    else if (action === 'later' || action === 'never') {
      P.ignore.push({ item: s.item, cls: s.cls, min: s.min, days: s.days, until: action === 'later' ? this.now() + LATER_DAYS * DAY : null });
      P.suggestions = P.suggestions.filter((x) => x.id !== id);
    } else throw new Error('Unknown action');
    this.save();
    a.changed?.();
    return this.view(name);
  }

  undo(name, id) {
    const a = this.adapters.get(name);
    const P = this.data.parts[name];
    const x = P?.applied.find((y) => y.id === id && !y.undone);
    if (!a || !x) throw new Error('That change can no longer be undone here');
    const now = JSON.stringify(a.read(x.item, x.days));
    if (now !== JSON.stringify(x.after)) throw new Error('The schedule has been changed since, so this can\'t be undone here. Change it in Schedules instead.');
    a.writeRaw(x.item, x.before, `${x.name}: schedule change undone (${x.change.charAt(0).toLowerCase()}${x.change.slice(1)}).`);
    x.undone = true;
    P.ignore.push({ item: x.item, cls: x.cls, min: x.min, days: x.days, until: this.now() + UNDONE_DAYS * DAY });
    this.save();
    a.changed?.();
    return this.view(name);
  }

  /** GET /api/patterns?part=heating, POST /api/patterns/<part>/<id>/(apply|later|never|undo), POST /api/patterns/run (look now) */
  async handle(req, res, url) {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const p = url.pathname.replace(/\/+$/, '');
      if (p === '/api/patterns' && req.method === 'GET') {
        const name = url.searchParams.get('part');
        return send(200, name ? this.view(name) : Object.fromEntries([...this.adapters.keys()].map((n) => [n, this.view(n)])));
      }
      if (p === '/api/patterns/run' && req.method === 'POST') { this.run(); return send(200, Object.fromEntries([...this.adapters.keys()].map((n) => [n, this.view(n)]))); }
      const m = p.match(/^\/api\/patterns\/(heating|lighting)\/([0-9a-f]{10})\/(apply|later|never|undo)$/);
      if (m && req.method === 'POST') return send(200, m[3] === 'undo' ? this.undo(m[1], m[2]) : this.act(m[1], m[2], m[3]));
      return send(404, { error: 'Not found' });
    } catch (err) { return send(400, { error: err.message }); }
  }
}
