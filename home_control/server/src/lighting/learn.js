// Lighting's side of patterns.js: groups, their schedules and levels, and the changes made by hand
// in the recent Activity (read once at the start).
import { resolveDay, startOfWeek, addDays, stateAt, nextChange, DAY_NAMES } from './schedule.js';
import { hhmm, nextAt, whenParts } from '../patterns.js';

/** A schedule point (or a level) as the value patterns compare: { on, brightness, kelvin }. */
export function levelOf(p) {
  if (!p) return null;
  return p.on ? { on: true, brightness: p.brightness ?? 100, kelvin: p.kelvin ?? null } : { on: false, brightness: null, kelvin: null };
}

const pct = (v) => `${v.brightness}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

export function lightingAdapter(engine) {
  const group = (id) => engine.data.groups.find((g) => g.id === id);
  const ctx = () => engine.ctx();
  return {
    // groups with a schedule (in season): there's nothing to change in one without
    items: () => engine.data.groups.filter((g) => engine.activeSchedule(g)).map((g) => ({ id: g.id, name: g.name, mode: g.learn || 'suggest' })),
    dayPoints: (id, dow) => {
      const week = engine.data.schedules[id];
      if (!week) return [];
      const date = addDays(startOfWeek(engine.now(), ctx().tz), dow);
      return resolveDay(week, date, ctx()).map((p) => ({ min: p.min, value: levelOf(p), raw: week[dow][p.index] }));
    },
    cls: (v, base) => {
      if (!v || !base) return null;
      if (!v.on && base.on) return 'off';
      if (v.on && !base.on) return 'on';
      if (!v.on) return null;
      const d = (v.brightness ?? 100) - (base.brightness ?? 100);
      return d >= 15 ? 'bright' : d <= -15 ? 'dim' : null;
    },
    same: (a, b) => !!a && !!b && a.on === b.on && (!a.on || Math.abs((a.brightness ?? 100) - (b.brightness ?? 100)) <= 5),
    typical: (values, cls) => {
      if (cls === 'off') return { on: false, brightness: null, kelvin: null };
      const b = median(values.map((v) => v.brightness ?? 100));
      const ks = values.map((v) => v.kelvin).filter((k) => k != null);
      return { on: true, brightness: Math.max(1, Math.min(100, Math.round(b / 5) * 5)), kelvin: ks.length ? Math.round(median(ks) / 50) * 50 : null };
    },
    words: ({ item, cls, value, min, plan, evidence, when }) => {
      const did = { off: 'turned off', on: `turned on (${pct(value)})`, dim: `dimmed to ${pct(value)}`, bright: `turned up to ${pct(value)}` }[cls];
      const why = `${item.name} was ${did} at about ${hhmm(min)} ${evidence}.`;
      const level = (v) => (v.on ? `on at ${pct(v)}` : 'off');
      const until = plan.end != null ? ` until ${hhmm(plan.end)}` : '';
      let change;
      if (plan.how === 'moved') change = cls === 'off' ? `Turn off at ${hhmm(min)} instead of ${hhmm(plan.was)} ${when}` : `Turn on at ${hhmm(min)} (${pct(value)}) instead of ${hhmm(plan.was)} ${when}`;
      else if (plan.how === 'changed') change = `At ${hhmm(plan.at)}, ${level(value)} instead of ${level(plan.wasValue)} ${when}`;
      else change = cls === 'off' ? `Turn off at ${hhmm(min)}${until} ${when}` : cls === 'on' ? `Turn on at ${hhmm(min)} at ${pct(value)}${until} ${when}` : `Set to ${pct(value)} at ${hhmm(min)}${until} ${when}`;
      return { why, change };
    },
    write: (id, days, note) => engine.setScheduleDays(id, Object.fromEntries(Object.entries(days).map(([d, pts]) => [d, pts.map((p) => {
      const v = p.value;
      const lv = { on: v.on, brightness: v.on ? v.brightness : null, kelvin: v.on ? v.kelvin ?? p.raw?.kelvin ?? null : null };
      if (p.raw && !p.changed) return p.raw;
      if (p.raw) return { ...p.raw, ...lv };
      return { time: hhmm(p.min), ...lv, fade: null };
    })])), note),
    read: (id, days) => Object.fromEntries(days.map((d) => [d, JSON.parse(JSON.stringify(engine.data.schedules[id]?.[d] || []))])),
    writeRaw: (id, days, note) => engine.setScheduleDays(id, days, note),
    changed: () => engine.changed(),
    history: () => readActivity(engine),
  };
}

const LEVEL = /^(turned off|turned on|set to (\d+)%)$/;
const toLevel = (what, n) => (what === 'turned off' ? { on: false, brightness: null, kelvin: null } : { on: true, brightness: n != null ? Number(n) : 100, kelvin: null });

/**
 * Changes made by hand, read back from lighting's Activity: a whole group changed here or from
 * Home Assistant, or the one light in a group of one changed at the switch, by voice or in Home
 * Assistant. "back to schedule" ends one; a mode change ends them all.
 */
export function readActivity(engine) {
  const tz = engine.ctx().tz;
  const entries = [...(engine.data.activity || [])].sort((a, b) => a.at - b.at);
  const out = [];
  let mode = 'schedule';
  const endAll = (at, item = null) => { for (const o of out) if ((item == null || o.item === item) && o.endedAt == null && (o.until == null || o.until > at)) o.endedAt = at; };
  const untilFrom = (at, text, g) => {
    let m;
    if ((m = /^until (\d\d):(\d\d)$/.exec(text))) return nextAt(at, tz, Number(m[1]) * 60 + Number(m[2]));
    if ((m = /^until (\d\d):(\d\d) tomorrow$/.exec(text))) return nextAt(at, tz, Number(m[1]) * 60 + Number(m[2]), (whenParts(at, tz).dow + 1) % 7);
    if ((m = /^until (\w+day) (\d\d):(\d\d)$/.exec(text))) return nextAt(at, tz, Number(m[2]) * 60 + Number(m[3]), DAY_NAMES.indexOf(m[1]));
    if (text === 'until its next change') { const w = engine.activeSchedule(g, at); return w ? nextChange(w, at, engine.ctx())?.at ?? null : null; }
    return null;
  };
  for (const { at, text, group } of entries) {
    if (typeof text !== 'string') continue;
    if (!group) {
      if (/^Back on schedules\./.test(text) || / Back on schedules\.$/.test(text)) { mode = 'schedule'; endAll(at); }
      else if (/Away mode on\.$/.test(text)) { mode = 'away'; endAll(at); }
      continue;
    }
    const g = engine.data.groups.find((x) => x.id === group);
    if (!g || !text.startsWith(`${g.name}: `)) continue;
    const rest = text.slice(g.name.length + 2);
    if (/^back to /.test(rest)) { endAll(at, g.id); continue; }
    if (mode !== 'schedule') continue;
    let value = null; let until = null; let m;
    if ((m = /^(.+?) here, (until .+?)\.$/.exec(rest)) && LEVEL.test(m[1])) {
      const l = LEVEL.exec(m[1]); value = toLevel(l[1], l[2]); until = untilFrom(at, m[2], g);
    } else if ((m = /^(turned off|turned on|set to (\d+)%) from Home Assistant, (until .+?)\.$/.exec(rest))) {
      value = toLevel(m[1], m[2]); until = untilFrom(at, m[3], g);
    } else if (g.devices.length === 1 && (m = / (turned off|turned on|set to (\d+)%) (?:at the switch|by .+|in Home Assistant)\. Leaving it (until .+?)\.$/.exec(rest))) {
      value = toLevel(m[1], m[2]); until = untilFrom(at, m[3], g);
    }
    if (!value) continue;
    const week = engine.activeSchedule(g, at);
    const st = week ? stateAt(week, at, engine.ctx()) : null;
    endAll(at, g.id);
    out.push({ item: g.id, at, value, base: st ? levelOf(st.point) : null, until, src: 'activity' });
  }
  return { since: entries.length ? entries[0].at : null, events: out };
}
