// Heating's side of patterns.js: rooms, their schedules and temperatures, and the changes made by
// hand over the last 30 days (read once from Activity, so suggestions can start straight away).
import { DAYS, toMinutes, fmtMinutes, scheduledAt, localWeekPosition } from './schedule.js';
import { hhmm, nextAt } from '../patterns.js';

const deg = (v) => `${Math.round(v * 10) / 10}°`;
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** What the room's schedule wants at an instant (whatever the mode). */
export function scheduledTemp(zone, at, tz) {
  return scheduledAt(zone.schedule, localWeekPosition(new Date(at), tz))?.temp ?? null;
}

export function heatingAdapter(engine, { push = () => {} } = {}) {
  const zone = (id) => engine.zones.find((z) => z.id === id);
  const tz = () => engine.ha.timeZone || 'UTC';
  return {
    items: () => engine.zones.filter((z) => z.enabled).map((z) => ({ id: z.id, name: z.name, mode: z.learn || 'suggest' })),
    dayPoints: (id, dow) => (zone(id)?.schedule?.[DAYS[dow]] || [])
      .map((p) => ({ min: toMinutes(p.time), value: Number(p.temp), raw: p }))
      .sort((a, b) => a.min - b.min),
    cls: (v, base) => (v == null || base == null ? null : v >= base + 0.5 ? 'up' : v <= base - 0.5 ? 'down' : null),
    same: (a, b) => Math.abs(a - b) < 0.25,
    typical: (values) => {
      const s = [...values].sort((x, y) => x - y);
      return Math.round(s[Math.floor((s.length - 1) / 2)] * 2) / 2; // the middle one (the lower of two), to the half degree
    },
    words: ({ item, cls, value, min, days, plan, evidence, when }) => {
      const why = `${item.name} was turned ${cls} to ${deg(value)} at about ${hhmm(min)} ${evidence}.`;
      let change;
      if (plan.how === 'moved') change = `Start ${deg(value)} at ${hhmm(min)} instead of ${hhmm(plan.was)} ${when}`;
      else if (plan.how === 'changed') change = `Make the ${hhmm(plan.at)} change ${deg(value)} instead of ${deg(plan.wasValue)} ${when}`;
      else change = `Make it ${deg(value)} from ${hhmm(min)}${plan.end != null ? ` until ${hhmm(plan.end)}` : ''} ${when}`;
      return { why, change };
    },
    write: (id, days, note) => engine.setScheduleDays(id, Object.fromEntries(Object.entries(days)
      .map(([d, pts]) => [d, pts.map((p) => ({ time: fmtMinutes(p.min), temp: p.value }))])), note),
    read: (id, days) => Object.fromEntries(days.map((d) => [d, JSON.parse(JSON.stringify(zone(id)?.schedule?.[DAYS[d]] || []))])),
    writeRaw: (id, days, note) => engine.setScheduleDays(id, days, note),
    changed: push,
    history: () => readActivity(engine.store.log, engine.zones, tz()),
  };
}

/**
 * Changes made by hand, read back from Activity (newest first): a radiator or the Hive app
 * ("Lounge: Lounge TRV changed to 22° … — holding until Mon 22:30", or before 1.13.1 "changed by
 * hand to"), and holds and boosts set here ("Lounge: set to 21° until Mon 22:30"). "Back to
 * schedule" ends one; a mode change ends them all and nothing's counted outside Schedules.
 */
export function readActivity(log, zones, tz) {
  const byName = new Map(zones.map((z) => [z.name, z]));
  const entries = [...(log || [])].sort((a, b) => a.at - b.at);
  const events = [];
  let mode = 'auto';
  const untilFrom = (at, day, h, m) => nextAt(at, tz, Number(h) * 60 + Number(m), WD[day]);
  for (const { at, msg } of entries) {
    if (typeof msg !== 'string') continue;
    let m;
    if ((m = /^Mode: (\w+)/.exec(msg))) {
      mode = m[1] === 'Schedules' ? 'auto' : 'other';
      events.push({ end: true, at });
      continue;
    }
    const sep = msg.indexOf(': ');
    if (sep < 0) continue;
    const z = byName.get(msg.slice(0, sep));
    if (!z) continue;
    const rest = msg.slice(sep + 2);
    if (/^back to (schedule|Away)/.test(rest)) { events.push({ end: true, item: z.id, at }); continue; }
    if (mode !== 'auto') continue;
    let temp = null; let until = null; let src = null;
    if ((m = /changed (?:by hand )?to (\d+(?:\.\d+)?)°.* — holding until (\w{3}) (\d\d):(\d\d)$/.exec(rest))) {
      temp = Number(m[1]); until = untilFrom(at, m[2], m[3], m[4]); src = 'radiator';
    } else if ((m = /^set to (\d+(?:\.\d+)?)° until (\w{3}) (\d\d):(\d\d)$/.exec(rest))) {
      temp = Number(m[1]); until = untilFrom(at, m[2], m[3], m[4]); src = 'app';
    }
    if (temp == null) continue;
    events.push({ item: z.id, at, value: temp, base: scheduledTemp(z, at, tz), until, src });
  }
  // ends become endedAt on the change they end
  const out = [];
  for (const e of events) {
    if (e.end) {
      for (const o of out) if ((e.item == null || o.item === e.item) && o.endedAt == null && (o.until == null || o.until > e.at)) o.endedAt = e.at;
      continue;
    }
    out.push(e);
  }
  return { since: entries.length ? entries[0].at : null, events: out };
}
