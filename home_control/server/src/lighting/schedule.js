// Pure schedule maths. No I/O, no clock: everything takes an instant (ms) and a context.
// Shared by the server and the web app (imported directly by Vite).
//
// A week is { 0: [points], ..., 6: [points] } with 0 = Monday.
// A point is either clock-based or sun-relative:
//   { time: '07:00', on: true, brightness: 40, kelvin: 2700, fade: 2 }
//   { anchor: 'sunset', offset: -30, on: true, brightness: 60, kelvin: null, fade: null }
// A point holds from its time until the next point (wrapping across days and the week).
// ctx = { tz, lat, lon, sun?: { [dateKey]: { sunrise, sunset } } }

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const MAX_POINTS_PER_DAY = 24;

// ---------- time zones ----------

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Local calendar parts of an instant in a time zone. dow: 0 = Monday. */
export function zonedParts(ms, tz) {
  const out = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  const hour = Number(out.hour) % 24;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour, minute: Number(out.minute), second: Number(out.second),
    dow: WD[out.weekday], minutes: hour * 60 + Number(out.minute),
  };
}

function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant for a local wall-clock time. Times skipped by a clock change move forward an hour. */
export function zonedToUtc(year, month, day, minutes, tz) {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  const o1 = offsetMs(guess, tz);
  let t = guess - o1;
  const o2 = offsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  // Non-existent local time (spring forward): t lands earlier than asked; push past the gap.
  const back = zonedParts(t, tz);
  if (back.minutes !== minutes && back.day === day) {
    const alt = guess - Math.min(o1, o2);
    if (zonedParts(alt, tz).minutes >= minutes || zonedParts(alt, tz).day !== day) return alt;
  }
  return t;
}

/** Calendar arithmetic on a local date. */
export function addDays(date, n) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), dow: (d.getUTCDay() + 6) % 7 };
}

export function dateKey(d) {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function localDate(ms, tz) {
  const p = zonedParts(ms, tz);
  return { year: p.year, month: p.month, day: p.day, dow: p.dow };
}

export function startOfWeek(ms, tz) {
  const d = localDate(ms, tz);
  return addDays(d, -d.dow);
}

// ---------- sun ----------

const RAD = Math.PI / 180;
function norm(v, max) { return ((v % max) + max) % max; }

/** UTC instant of sunrise or sunset on a calendar date at lat/lon, or null if it doesn't happen. */
function sunEventUtc(year, month, day, lat, lon, rising) {
  const n = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86400000);
  const lngHour = lon / 15;
  const t = n + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = norm(M + 1.916 * Math.sin(M * RAD) + 0.020 * Math.sin(2 * M * RAD) + 282.634, 360);
  let RA = norm(Math.atan(0.91764 * Math.tan(L * RAD)) / RAD, 360);
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * RAD) - sinDec * Math.sin(lat * RAD)) / (cosDec * Math.cos(lat * RAD));
  if (cosH > 1 || cosH < -1) return null;
  const H = (rising ? 360 - Math.acos(cosH) / RAD : Math.acos(cosH) / RAD) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  const UT = norm(T - lngHour, 24);
  return Date.UTC(year, month - 1, day) + Math.round(UT * 3600000);
}

/** Sunrise and sunset (instants) for a local date. Uses ctx.sun overrides when given (e.g. from sun.sun). */
export function sunTimes(date, ctx) {
  const key = dateKey(date);
  const over = ctx.sun && ctx.sun[key];
  const res = { sunrise: over?.sunrise ?? null, sunset: over?.sunset ?? null };
  if (ctx.lat == null || ctx.lon == null) return res;
  for (const which of ['sunrise', 'sunset']) {
    if (res[which] != null) continue;
    let ms = sunEventUtc(date.year, date.month, date.day, ctx.lat, ctx.lon, which === 'sunrise');
    if (ms == null) continue;
    // The UTC calculation can land on the neighbouring local day; nudge it back.
    for (let i = 0; i < 2; i++) {
      const ld = localDate(ms, ctx.tz);
      const diff = Date.UTC(ld.year, ld.month - 1, ld.day) - Date.UTC(date.year, date.month - 1, date.day);
      if (diff === 0) break;
      ms -= Math.sign(diff) * 86400000;
    }
    res[which] = ms;
  }
  return res;
}

// ---------- validation ----------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

/** Clean one point. Returns null for junk. */
export function normalizePoint(p) {
  if (!p || typeof p !== 'object') return null;
  const out = { on: p.on !== false };
  if (p.anchor === 'sunrise' || p.anchor === 'sunset') {
    out.anchor = p.anchor;
    out.offset = clampInt(p.offset ?? 0, -240, 240) ?? 0;
  } else if (typeof p.time === 'string' && TIME_RE.test(p.time)) {
    out.time = p.time;
  } else {
    return null;
  }
  out.brightness = out.on && p.brightness != null && p.brightness !== '' ? clampInt(p.brightness, 1, 100) : null;
  out.kelvin = out.on && p.kelvin != null && p.kelvin !== '' ? clampInt(p.kelvin, 2000, 6500) : null;
  out.fade = p.fade != null && p.fade !== '' ? clampInt(p.fade, 0, 3600) : null;
  return out;
}

export function timeToMinutes(t) {
  const m = TIME_RE.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function minutesToTime(min) {
  const m = norm(Math.round(min), 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Sort key for a point without a date (sun points use typical times). */
function roughMinutes(p) {
  if (p.time) return timeToMinutes(p.time);
  return (p.anchor === 'sunrise' ? 7 * 60 : 18 * 60) + p.offset;
}

export function normalizeDay(points) {
  if (!Array.isArray(points)) return [];
  const cleaned = points.map(normalizePoint).filter(Boolean);
  cleaned.sort((a, b) => roughMinutes(a) - roughMinutes(b));
  const seen = new Map();
  for (const p of cleaned) seen.set(p.time ?? `${p.anchor}${p.offset}`, p); // later duplicate wins
  return [...seen.values()].sort((a, b) => roughMinutes(a) - roughMinutes(b)).slice(0, MAX_POINTS_PER_DAY);
}

export function normalizeWeek(week) {
  const out = {};
  for (let d = 0; d < 7; d++) out[d] = normalizeDay(week?.[d] ?? week?.[String(d)]);
  return out;
}

export function emptyWeek() {
  const w = {};
  for (let d = 0; d < 7; d++) w[d] = [];
  return w;
}

export function weekIsEmpty(week) {
  if (!week) return true;
  for (let d = 0; d < 7; d++) if (week[d]?.length) return false;
  return true;
}

// ---------- resolution ----------

/** Minute of the local day a point happens on a given date, or null if it can't happen (no sunset). */
export function pointMinute(p, date, ctx) {
  if (p.time) return timeToMinutes(p.time);
  const sun = sunTimes(date, ctx);
  const at = sun[p.anchor];
  if (at == null) return null;
  const base = zonedParts(at, ctx.tz).minutes;
  return Math.min(1439, Math.max(0, base + (p.offset || 0)));
}

/** Points for one local date with their resolved minutes, sorted. */
export function resolveDay(week, date, ctx) {
  const pts = week?.[date.dow] ?? [];
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const min = pointMinute(pts[i], date, ctx);
    if (min == null) continue;
    out.push({ ...pts[i], min, index: i });
  }
  out.sort((a, b) => a.min - b.min);
  // Two points landing on the same minute: the later one in the list wins.
  const res = [];
  for (const p of out) {
    if (res.length && res[res.length - 1].min === p.min) res[res.length - 1] = p;
    else res.push(p);
  }
  return res;
}

/** The point in force at an instant, with when it started. Null if the week is empty. */
export function stateAt(week, ms, ctx) {
  if (weekIsEmpty(week)) return null;
  const now = zonedParts(ms, ctx.tz);
  const today = { year: now.year, month: now.month, day: now.day, dow: now.dow };
  for (let back = 0; back <= 7; back++) {
    const date = addDays(today, -back);
    const pts = resolveDay(week, date, ctx);
    for (let i = pts.length - 1; i >= 0; i--) {
      if (back === 0 && pts[i].min > now.minutes) continue;
      return { point: pts[i], since: zonedToUtc(date.year, date.month, date.day, pts[i].min, ctx.tz) };
    }
  }
  return null;
}

/** The next scheduled change after an instant. Null if the week is empty. */
export function nextChange(week, ms, ctx) {
  if (weekIsEmpty(week)) return null;
  const now = zonedParts(ms, ctx.tz);
  const today = { year: now.year, month: now.month, day: now.day, dow: now.dow };
  for (let fwd = 0; fwd <= 8; fwd++) {
    const date = addDays(today, fwd);
    for (const p of resolveDay(week, date, ctx)) {
      if (fwd === 0 && p.min <= now.minutes) continue;
      const at = zonedToUtc(date.year, date.month, date.day, p.min, ctx.tz);
      if (at > ms) return { point: p, at };
    }
  }
  return null;
}

/**
 * Coloured segments for one local date: [{ from, to, on, brightness, kelvin }], minutes 0..1440.
 * The state before the first point is carried over from earlier days.
 */
export function daySegments(week, date, ctx) {
  if (weekIsEmpty(week)) return [];
  const pts = resolveDay(week, date, ctx);
  let carry = null;
  for (let back = 1; back <= 7 && !carry; back++) {
    const prev = resolveDay(week, addDays(date, -back), ctx);
    if (prev.length) carry = prev[prev.length - 1];
  }
  if (!carry && pts.length) carry = pts[pts.length - 1]; // only one day has points: wrap within the week
  const segs = [];
  let cur = carry;
  let from = 0;
  for (const p of pts) {
    if (p.min > from && cur) segs.push(seg(from, p.min, cur));
    cur = p;
    from = p.min;
  }
  if (cur) segs.push(seg(from, 1440, cur));
  return segs;
}

function seg(from, to, p) {
  return { from, to, on: !!p.on, brightness: p.on ? (p.brightness ?? 100) : 0, kelvin: p.on ? p.kelvin ?? null : null };
}

/** The most recent point at or before an instant that passes a test, looking back up to a week. */
export function previousMatching(week, ms, ctx, test) {
  if (weekIsEmpty(week)) return null;
  const now = zonedParts(ms, ctx.tz);
  const today = { year: now.year, month: now.month, day: now.day, dow: now.dow };
  for (let back = 0; back <= 7; back++) {
    const date = addDays(today, -back);
    const pts = resolveDay(week, date, ctx);
    for (let i = pts.length - 1; i >= 0; i--) {
      if (back === 0 && pts[i].min > now.minutes) continue;
      if (!test(pts[i])) continue;
      return { point: pts[i], at: zonedToUtc(date.year, date.month, date.day, pts[i].min, ctx.tz) };
    }
  }
  return null;
}

/** The next point after an instant that passes a test, looking ahead up to a week. */
export function nextMatching(week, ms, ctx, test) {
  if (weekIsEmpty(week)) return null;
  const now = zonedParts(ms, ctx.tz);
  const today = { year: now.year, month: now.month, day: now.day, dow: now.dow };
  for (let fwd = 0; fwd <= 8; fwd++) {
    const date = addDays(today, fwd);
    for (const p of resolveDay(week, date, ctx)) {
      if (fwd === 0 && p.min <= now.minutes) continue;
      if (!test(p)) continue;
      const at = zonedToUtc(date.year, date.month, date.day, p.min, ctx.tz);
      if (at > ms) return { point: p, at };
    }
  }
  return null;
}

/**
 * The level to use when someone turns a group on by hand: the most recent scheduled "on" change,
 * or the next one if it's due within the hour. Null when the schedule never turns it on.
 */
export function turnOnPoint(week, ms, ctx, soonMs = 3600000) {
  const isOn = (p) => p.on;
  const next = nextMatching(week, ms, ctx, isOn);
  if (next && next.at - ms <= soonMs) return next;
  return previousMatching(week, ms, ctx, isOn) || next;
}

// ---------- descriptions (plain English for the UI and activity log) ----------

export function describeLevel(p, { dimmable = true } = {}) {
  if (!p || !p.on) return 'off';
  if (!dimmable || p.brightness == null) return 'on';
  return `${p.brightness}%`;
}

export function describeWhen(p) {
  if (p.time) return p.time;
  const name = p.anchor === 'sunset' ? 'sunset' : 'sunrise';
  if (!p.offset) return name;
  const abs = Math.abs(p.offset);
  const span = abs >= 60 && abs % 60 === 0 ? `${abs / 60} h` : abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return `${span} ${p.offset < 0 ? 'before' : 'after'} ${name}`;
}

/** Where to put a new point: 2 h after the last one, or in the middle of the biggest gap. */
export function suggestNewTime(points) {
  const mins = points.map(roughMinutes).sort((a, b) => a - b);
  if (!mins.length) return '18:00';
  const last = mins[mins.length - 1];
  if (last + 120 <= 1439) return minutesToTime(last + 120);
  let best = { gap: mins[0], at: Math.floor(mins[0] / 2) };
  for (let i = 1; i < mins.length; i++) {
    const gap = mins[i] - mins[i - 1];
    if (gap > best.gap) best = { gap, at: mins[i - 1] + Math.floor(gap / 2) };
  }
  return minutesToTime(Math.round(best.at / 5) * 5);
}

// ---------- away "lived-in" pattern ----------

/** Deterministic 0..1 random from a string, so a day's pattern stays stable across restarts. */
export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** A lived-in day for one group: on a little after sunset, off around the chosen time. */
export function livedInWeek(groupId, weekStart, ctx, { offTime = '23:00', brightness = 70 } = {}) {
  const week = emptyWeek();
  const off = timeToMinutes(offTime) ?? 23 * 60;
  for (let d = 0; d < 7; d++) {
    const date = addDays(weekStart, d);
    const key = `${groupId}:${dateKey(date)}`;
    const onOffset = Math.round(seeded(key + ':on') * 40) - 10; // 10 min before to 30 min after sunset
    const offShift = Math.round(seeded(key + ':off') * 40) - 20; // ±20 min
    const sun = sunTimes(date, ctx);
    const sunsetMin = sun.sunset != null ? zonedParts(sun.sunset, ctx.tz).minutes : 19 * 60;
    const onMin = Math.max(0, Math.min(1430, sunsetMin + onOffset));
    const offMin = Math.max(0, Math.min(1439, off + offShift));
    week[d] = offMin > onMin
      ? [{ time: '00:00', on: false, brightness: null, kelvin: null, fade: null },
         { time: minutesToTime(onMin), on: true, brightness, kelvin: null, fade: null },
         { time: minutesToTime(offMin), on: false, brightness: null, kelvin: null, fade: null }]
      : [{ time: '00:00', on: false, brightness: null, kelvin: null, fade: null }];
  }
  return week;
}

// ---------- seasons, night windows, mornings ----------

const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Clean a season { from: 'MM-DD', to: 'MM-DD' }. Null if junk. */
export function normalizeSeason(season) {
  if (!season || !MD_RE.test(season.from) || !MD_RE.test(season.to)) return null;
  return { from: season.from, to: season.to };
}

/** Is a local date inside a season? Seasons can wrap the year end (1 Dec to 6 Jan). No season means always. */
export function inSeason(date, season) {
  if (!season) return true;
  const md = `${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  return season.from <= season.to ? md >= season.from && md <= season.to : md >= season.from || md <= season.to;
}

export function describeMonthDay(md) {
  const [m, d] = md.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Is a minute of the day inside a window that may cross midnight (23:00 to 06:00)? */
export function inTimeWindow(minutes, from, to) {
  const a = timeToMinutes(from); const b = timeToMinutes(to);
  if (a == null || b == null || a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** The next instant the local clock shows a given time (today if still ahead, otherwise tomorrow). */
export function nextLocalTime(ms, time, tz) {
  const min = timeToMinutes(time) ?? 0;
  const today = localDate(ms, tz);
  const t = zonedToUtc(today.year, today.month, today.day, min, tz);
  if (t > ms) return t;
  const tm = addDays(today, 1);
  return zonedToUtc(tm.year, tm.month, tm.day, min, tz);
}

/** The first scheduled change at or after the next morning (default 05:00), for holds that should last the night. */
export function morningChange(week, ms, ctx, morning = '05:00') {
  const from = nextLocalTime(ms, morning, ctx.tz);
  return { morning: from, change: nextChange(week, from - 60000, ctx) };
}
