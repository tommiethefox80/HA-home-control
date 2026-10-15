// Pure schedule maths. No I/O here so it can be unit-tested.
//
// A zone schedule is { mon: [{time:"06:30", temp:20}, ...], tue: [...], ... }.
// Each point sets the target from that time until the next point. Before the
// first point of a day, the last point of the previous day still applies.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEK = 7 * 24 * 60;

export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function fmtMinutes(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Local wall-clock position in the week for a given IANA time zone.
// Returns { dayIndex: 0=Mon..6=Sun, minutes: minutes since local midnight }.
export function localWeekPosition(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { dayIndex: wd, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

// Flatten a schedule into sorted week-minute points.
export function weekPoints(schedule) {
  const pts = [];
  DAYS.forEach((d, i) => {
    for (const p of schedule?.[d] || []) {
      const t = Number(p.temp);
      if (!Number.isFinite(t)) continue;
      pts.push({ at: i * 1440 + toMinutes(p.time), temp: t, day: d, time: p.time });
    }
  });
  pts.sort((a, b) => a.at - b.at);
  return pts;
}

// Scheduled target at a week position, plus the next change.
// Returns { temp, since, next: { temp, inMinutes, time, day } | null } or null if no points.
export function scheduledAt(schedule, pos) {
  const pts = weekPoints(schedule);
  if (!pts.length) return null;
  const now = pos.dayIndex * 1440 + pos.minutes;
  let cur = null;
  for (const p of pts) if (p.at <= now) cur = p;
  if (!cur) cur = pts[pts.length - 1]; // wrap from previous week
  // next point with a different temperature
  let next = null;
  for (let k = 1; k <= pts.length; k++) {
    const idx = (pts.indexOf(cur) + k) % pts.length;
    const p = pts[idx];
    if (p.temp !== cur.temp) { next = p; break; }
  }
  let nextOut = null;
  if (next) {
    let delta = next.at - now;
    if (delta <= 0) delta += WEEK;
    nextOut = { temp: next.temp, inMinutes: delta, time: next.time, day: next.day };
  }
  return { temp: cur.temp, next: nextOut };
}

// Validate & normalise a schedule submitted by the GUI.
export function normaliseSchedule(input) {
  const out = {};
  for (const d of DAYS) {
    const pts = Array.isArray(input?.[d]) ? input[d] : [];
    const seen = new Map();
    for (const p of pts) {
      if (!/^\d{1,2}:\d{2}$/.test(String(p.time))) continue;
      const min = toMinutes(p.time);
      if (min < 0 || min >= 1440) continue;
      const temp = Math.round(Number(p.temp) * 2) / 2;
      if (!Number.isFinite(temp) || temp < 5 || temp > 30) continue;
      seen.set(min, { time: fmtMinutes(min), temp });
    }
    out[d] = [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  }
  return out;
}

export function defaultSchedule() {
  const weekday = [
    { time: '06:30', temp: 20 }, { time: '08:30', temp: 16 },
    { time: '16:30', temp: 20.5 }, { time: '22:30', temp: 15 },
  ];
  const weekend = [
    { time: '07:30', temp: 20 }, { time: '23:00', temp: 15 },
  ];
  return {
    mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday,
    sat: weekend, sun: weekend,
  };
}
