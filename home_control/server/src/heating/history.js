// "Today" data for the GUI: room temperatures, targets, boiler runs, outside
// temperature and gas cost, mostly pulled from Home Assistant's own history so
// it works from the moment the add-on is installed.
import fs from 'node:fs';
import path from 'node:path';
import { scheduledAt, localWeekPosition } from './schedule.js';

const STEP = 5 * 60 * 1000; // 5-minute buckets
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const BAD = new Set(['unavailable', 'unknown']);

// ---- our own log of room targets (HA doesn't know them) ----
export class TargetLog {
  constructor(dir) {
    this.file = path.join(dir, 'targets.json');
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* new */ }
    this.timer = null;
    this.keepDays = () => 7; // set from Settings → History
  }
  #trim(arr, at) {
    const cutoff = at - this.keepDays() * 86400000;
    while (arr.length > 1 && arr[1][0] < cutoff) arr.shift(); // keep the one in force at the cutoff
  }
  prune(at = Date.now()) {
    for (const arr of Object.values(this.data)) this.#trim(arr, at);
    this.flush();
  }
  record(zoneId, temp, at = Date.now()) {
    const arr = (this.data[zoneId] ||= []);
    const last = arr[arr.length - 1];
    if (last && last[1] === temp) return;
    arr.push([at, temp]);
    this.#trim(arr, at);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 5000);
  }
  flush() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* ignore */ }
  }
}

// ---- our own log of when each room called for heat (for the room cards' "today" graph) ----
// { zones: { zoneId: [[start, end|null], ...] }, seen: epochMs }. An interval still open when
// the add-on stopped is closed at the last time we were running, so downtime never counts.
export class CallLog {
  constructor(dir) {
    this.file = path.join(dir, 'calls.json');
    this.zones = {};
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.zones = d.zones || {};
      // when this log began (older files: the earliest interval), so "fired today" can say if it's partial
      const firsts = Object.values(this.zones).map((a) => a[0]?.[0]).filter(Boolean);
      this.started = d.started || (firsts.length ? Math.min(...firsts) : Date.now());
      for (const arr of Object.values(this.zones)) {
        const last = arr[arr.length - 1];
        if (last && last[1] == null) last[1] = Math.max(last[0], d.seen || last[0]);
      }
    } catch { /* new */ }
    this.started ||= Date.now();
    this.seenFlush = 0;
    this.timer = null;
    this.keepDays = () => 7; // set from Settings → History
  }
  prune(at = Date.now()) {
    const cutoff = at - this.keepDays() * 86400000;
    for (const arr of Object.values(this.zones)) while (arr.length && arr[0][1] != null && arr[0][1] < cutoff) arr.shift();
    this.flush();
  }
  update(views, at = Date.now()) {
    this.lastAt = at;
    let dirty = false;
    for (const v of views) {
      if (!v.enabled) continue;
      const arr = (this.zones[v.id] ||= []);
      const last = arr[arr.length - 1];
      const open = last && last[1] == null;
      // [start, end, what the room was following when it started (schedule, boost, hold…), its target]
      if (v.calling && !open) { arr.push([at, null, v.source, v.target]); dirty = true; }
      else if (!v.calling && open) { last[1] = at; dirty = true; }
      const cutoff = at - this.keepDays() * 86400000;
      while (arr.length && arr[0][1] != null && arr[0][1] < cutoff) { arr.shift(); dirty = true; }
    }
    // keep "seen" fresh while a room is heating, so a crash can't stretch an interval
    if (dirty || (at - this.seenFlush > 60000 && Object.values(this.zones).some((a) => a.length && a[a.length - 1][1] == null))) {
      this.seenFlush = at;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), dirty ? 5000 : 0);
    }
  }
  intervals(zoneId, from, to) {
    return (this.zones[zoneId] || [])
      .map(([a, b, why, target]) => [Math.max(a, from), Math.min(b ?? to, to), why ?? null, target ?? null])
      .filter(([a, b]) => b > a);
  }
  flush() {
    // "seen" is the last time the engine actually checked the rooms, not when the file was written
    try { fs.writeFileSync(this.file, JSON.stringify({ zones: this.zones, seen: this.lastAt || Date.now(), started: this.started })); } catch { /* ignore */ }
  }
}

// ---- entity auto-detection for things the user hasn't picked ----
export function detectCostEntity(ha) {
  let best = null;
  for (const s of ha.states.values()) {
    const id = s.entity_id;
    if (!id.startsWith('sensor.')) continue;
    const a = s.attributes || {};
    const money = a.device_class === 'monetary' || /^(GBP|£)$/.test(a.unit_of_measurement || '');
    if (!money || !/gas/i.test(id + (a.friendly_name || ''))) continue;
    const score = (/accumulative_cost|cost_today|daily_cost/i.test(id) ? 2 : 0) + (/current/i.test(id) ? 1 : 0);
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id || null;
}

export function detectOutsideEntity(ha) {
  let weather = null;
  for (const s of ha.states.values()) {
    if (s.entity_id.startsWith('sensor.') && s.attributes?.device_class === 'temperature' && /outside|outdoor|external/i.test(s.entity_id + (s.attributes.friendly_name || ''))) return s.entity_id;
    if (!weather && s.entity_id.startsWith('weather.') && num(s.attributes?.temperature) != null) weather = s.entity_id;
  }
  return weather;
}

export function readOutside(ha, id) {
  const s = id && ha.get(id);
  if (!s || BAD.has(s.state)) return null;
  return id.startsWith('weather.') ? num(s.attributes?.temperature) : num(s.state);
}

// ---- helpers over HA's compressed history rows ----
function rowsFor(result, id) {
  const rows = result?.[id] || [];
  let attrs = {};
  return rows.map((r) => {
    if (r.a) attrs = r.a;
    const t = (r.lu ?? r.lc ?? (r.last_updated ? Date.parse(r.last_updated) / 1000 : 0)) * 1000;
    return { t, s: r.s ?? r.state, a: r.a || r.attributes || attrs };
  });
}

// Step-function sample of a value every STEP ms between from..to.
function sample(rows, from, to, pick) {
  const out = [];
  let i = 0;
  let cur = null;
  for (let t = from; t <= to; t += STEP) {
    while (i < rows.length && rows[i].t <= t) { cur = pick(rows[i]); i++; }
    out.push(cur);
  }
  return out;
}

const tempOf = (id) => (r) => {
  if (BAD.has(r.s)) return null;
  if (id.startsWith('climate.')) return num(r.a?.current_temperature);
  if (id.startsWith('weather.')) return num(r.a?.temperature);
  return num(r.s);
};

/** Boiler runs today that heated an always-open radiator for other rooms: the parts of each run
 *  this room wasn't calling in. A run it didn't call in at all counts as a time; the minutes add up
 *  every part it didn't call in. */
export function heatedWithOthers(runs, calls, dayStart, now = Date.now()) {
  let times = 0; let ms = 0;
  for (const [a0, b0] of runs) {
    const a = Math.max(a0, dayStart); const b = Math.min(b0, now);
    if (b - a < 60000) continue;
    let left = b - a;
    let own = false;
    for (const [x, y] of calls) {
      const overlap = Math.max(0, Math.min(b, y) - Math.max(a, x));
      if (overlap > 0) own = true;
      left -= overlap;
    }
    if (left < 60000) continue;
    ms += left;
    if (!own) times++;
  }
  return { times, minutes: Math.round(ms / 60000) };
}

export async function buildToday(engine, { hours = 24 } = {}) {
  const ha = engine.ha;
  const s = engine.s;
  const to = Math.floor(Date.now() / STEP) * STEP;
  const from = to - hours * 3600000;
  const zones = engine.zones.filter((z) => z.enabled);
  const outsideId = s.outsideEntity || detectOutsideEntity(ha);
  const costId = s.costEntity || detectCostEntity(ha);
  const boilerId = s.boiler.entity;

  const ids = new Set();
  for (const z of zones) { if (z.sensor) ids.add(z.sensor); else (z.trvs || []).forEach((e) => ids.add(e)); }
  if (outsideId) ids.add(outsideId);
  if (boilerId) ids.add(boilerId);

  let result = {};
  try {
    result = await ha.send({
      type: 'history/history_during_period',
      start_time: new Date(from).toISOString(),
      end_time: new Date(to + STEP).toISOString(),
      entity_ids: [...ids],
      include_start_time_state: true,
      significant_changes_only: false,
      minimal_response: false,
      no_attributes: false,
    });
  } catch (e) {
    return { error: `Couldn't read history from Home Assistant: ${e.message}` };
  }

  const times = [];
  for (let t = from; t <= to; t += STEP) times.push(t);

  // room temperatures (sensor, or average of the room's valves) and targets
  const tz = ha.timeZone;
  const dayStart = localMidnight(tz);
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const nowMs = Date.now();
  // boiler runs from the device's own history (Hive's hvac_action, or switch state)
  const runs = [];
  let onMs = 0;
  if (boilerId) {
    const rows = rowsFor(result, boilerId);
    const firing = (r) => (boilerId.startsWith('climate.') ? r.a?.hvac_action === 'heating' : r.s === 'on');
    let start = null;
    for (const r of rows) {
      const t = Math.max(r.t, from);
      if (firing(r) && start == null) start = t;
      if (!firing(r) && start != null) { runs.push([start, t]); start = null; }
    }
    if (start != null) runs.push([start, Date.now()]);
    const midnight = dayStart;
    for (const [a, b] of runs) onMs += Math.max(0, b - Math.max(a, midnight));
  }

  const rooms = zones.map((z) => {
    const sources = z.sensor ? [z.sensor] : (z.trvs || []);
    const series = sources.map((id) => sample(rowsFor(result, id), from, to, tempOf(id)));
    const temps = times.map((_, k) => {
      const v = series.map((ser) => ser[k]).filter((x) => x != null);
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
    });
    // targets: our log where we have it, the schedule before that
    const log = engine.targetLog.data[z.id] || [];
    let li = 0;
    let logged = null;
    const targets = times.map((t) => {
      while (li < log.length && log[li][0] <= t) { logged = log[li][1]; li++; }
      if (logged != null) return logged;
      return scheduledAt(z.schedule, localWeekPosition(new Date(t), tz))?.temp ?? null;
    });
    // when this room called for heat (our own log), and today's total. The daily log has the
    // total from earlier versions too, so prefer it; fall back to adding up the intervals.
    const calls = engine.callLog ? engine.callLog.intervals(z.id, from, nowMs) : [];
    const dailyMin = engine.dailyLog?.days?.[dayKey]?.rooms?.[z.id]?.callMin;
    const fromCalls = calls.reduce((a, [x, y]) => a + Math.max(0, y - Math.max(x, dayStart)), 0) / 60000;
    const heatedToday = Math.round(dailyMin != null ? Math.max(dailyMin, fromCalls) : fromCalls);
    // times it started heating today (a heat-up still going from before midnight counts for yesterday)
    const firedToday = calls.filter(([x, y]) => x >= dayStart && y - x >= 60000).length;
    // an always-open radiator (no TRV of its own) also gets heat when the boiler runs for other rooms
    const open = engine.openRadiator(z);
    const withOthers = open ? heatedWithOthers(runs, calls, dayStart, nowMs) : null;
    return { id: z.id, name: z.name, temps, targets, calls, heatedToday, firedToday, open, withOthers };
  });

  const outside = outsideId ? sample(rowsFor(result, outsideId), from, to, tempOf(outsideId)) : null;
  const cost = costId ? await costSummary(ha, costId, !s.costEntity) : null;

  return {
    from, to, step: STEP, times, rooms, boilerRuns: runs, dayStart,
    boilerFiresToday: runs.filter(([a, b]) => a >= dayStart && b - a >= 60000).length,
    // the room log only knows about heat-ups since it was installed; if that was today, counts are partial
    firesSince: engine.callLog && engine.callLog.started > dayStart ? engine.callLog.started : null,
    boilerTodayMinutes: Math.round(onMs / 60000),
    outside: outsideId ? { entity: outsideId, auto: !s.outsideEntity, now: readOutside(ha, outsideId), series: outside } : null,
    cost,
  };
}

// Start of today in HA's time zone, as epoch ms.
function localMidnight(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (k) => Number(parts.find((p) => p.type === k)?.value || 0);
  return now.getTime() - ((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000 - now.getMilliseconds();
}

// Today's cost (current value) and yesterday's (the last value before it reset).
async function costSummary(ha, id, auto) {
  const st = ha.get(id);
  const unit = st?.attributes?.unit_of_measurement || 'GBP';
  const today = st && !BAD.has(st.state) ? num(st.state) : null;
  let yesterday = null;
  try {
    const res = await ha.send({
      type: 'history/history_during_period',
      start_time: new Date(Date.now() - 48 * 3600000).toISOString(),
      entity_ids: [id], minimal_response: true, no_attributes: true, significant_changes_only: false,
    });
    const vals = rowsFor(res, id).map((r) => ({ t: r.t, v: num(r.s) })).filter((r) => r.v != null);
    // find the most recent reset (a big drop) and take the value just before it
    for (let i = vals.length - 1; i > 0; i--) {
      if (vals[i].v < vals[i - 1].v - 0.05) { yesterday = vals[i - 1].v; break; }
    }
  } catch { /* history unavailable */ }
  return { entity: id, auto, name: st?.attributes?.friendly_name || id, unit, today, yesterday };
}
