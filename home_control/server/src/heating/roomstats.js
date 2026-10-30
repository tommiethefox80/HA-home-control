// How each room behaves: how quickly it warms (and how much slower on cold days), how quickly it
// loses heat once the heating's off, how long it holds its heat, and how much heating it needs
// for the weather. Worked out from Home Assistant's own history (room and outside temperatures,
// the boiler) and the app's log of when each room called for heat, so there are figures from the
// first day rather than after weeks of learning.
//
// Heat loss follows Newton's law of cooling: each hour a room loses a fixed share (k) of the gap
// between it and outside. k is measured from stretches where the room had no heat at all (not
// calling, the boiler off, and at least 45 minutes after its last heat, so the radiators had cooled),
// as k = ln((start - outside) / (end - outside)) / hours. From k: how fast it cools at a given
// outside temperature (k x the gap), how long it takes to fall from 20° to 17° on a 5° night, and
// how it compares with the house's other rooms.
//
// The outside temperature is usually a weather service's, which can be a degree or two out at your
// walls; on a mild day, with the room only a few degrees above outside, that's a big share of the gap
// and k can look far higher or lower than it is (k is out by about the error over the gap). So each
// stretch also keeps its gap to outside, the lowest k it could be if outside were 2° colder than the
// reading (kLow), and how windy it was (wind makes a room lose heat faster, for real). Heat-loss
// alerts use those to be sure (heatloss.js).
import { STEP, rowsFor, sample, tempOf, detectOutsideEntity } from './history.js';

const H = 3600000;
const BASE = 15.5; // heating degree-day base, as Insights
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
export const OUTSIDE_SLACK = 2; // how far out the outside reading may be, in degrees
export const MIN_GAP = 5;       // stretches nearer to outside than this are too sensitive to it for alerts

/** A wind speed in km/h, from a weather entity's wind_speed in its own unit. */
export function windKmh(speed, unit) {
  const v = Number(speed);
  if (speed == null || speed === '' || !Number.isFinite(v)) return null;
  const f = { 'km/h': 1, 'mph': 1.609344, 'm/s': 3.6, 'kn': 1.852, 'ft/s': 1.09728 }[unit] ?? 1;
  return v * f;
}

/** Each heat-up of 20 minutes or more: how fast it warmed, and how cold it was outside. */
export function warmUps(times, temps, outside, calls, { minMinutes = 20 } = {}) {
  const from = times[0]; const step = times[1] - times[0];
  const at = (t) => Math.min(times.length - 1, Math.max(0, Math.round((t - from) / step)));
  const out = [];
  for (const [a, b] of calls) {
    if (b - a < minMinutes * 60000) continue;
    const i0 = at(a); const i1 = at(b);
    const t0 = temps[i0]; const t1 = temps[i1];
    if (t0 == null || t1 == null || i1 <= i0) continue;
    const rise = t1 - t0;
    if (rise < 0.2) continue;
    out.push({ at: a, minutes: Math.round((b - a) / 60000), rise: r1(rise), rate: r2(rise / ((b - a) / H)), outside: r1(mean(outside.slice(i0, i1 + 1))) });
  }
  return out;
}

/** Stretches with no heat at all, each turned into a heat-loss rate k (share of the gap to outside lost per hour). */
export function coolDowns(times, temps, outside, heated, { settleMinutes = 45, minMinutes = 90, maxMinutes = 360, wind = null } = {}) {
  const step = times[1] - times[0];
  const settle = Math.ceil((settleMinutes * 60000) / step);
  // usable: no heat now, none in the last `settle` steps (radiators cooled), readings present
  const ok = times.map((_, i) => {
    if (i < settle || heated[i] || temps[i] == null || outside[i] == null) return false;
    for (let j = i - settle; j < i; j++) if (heated[j]) return false;
    return true;
  });
  const out = [];
  // TRVs that report in half degrees flick up and down by 0.5: allow for that before calling it a warming
  const seen = temps.filter((x) => x != null);
  const coarse = seen.length > 10 && seen.every((x) => Math.abs(x * 2 - Math.round(x * 2)) < 0.02);
  const riseLimit = coarse ? 0.55 : 0.25;
  const minLen = Math.ceil((minMinutes * 60000) / step);
  const maxLen = Math.floor((maxMinutes * 60000) / step);
  let i = 0;
  while (i < ok.length) {
    if (!ok[i]) { i++; continue; }
    // a stretch ends where something else warms the room (sun, cooking, people): a rise of more
    // than a quarter of a degree (or a reading's step, for half-degree TRVs) over its lowest point so far
    let e = i; let low = temps[i];
    while (e + 1 < ok.length && ok[e + 1] && e + 1 - i < maxLen && temps[e + 1] <= low + riseLimit) { e++; low = Math.min(low, temps[e]); }
    if (e - i >= minLen) {
      const t0 = temps[i]; const t1 = temps[e];
      const o = mean(outside.slice(i, e + 1));
      const hours = ((e - i) * step) / H;
      if (o != null && t0 - o >= 3 && t1 - o >= 1 && t0 - t1 >= (hours >= 3 ? 0.05 : 0.15)) {
        const k = Math.log((t0 - o) / (t1 - o)) / hours;
        const lo = o - OUTSIDE_SLACK;
        const kLow = Math.log((t0 - lo) / (t1 - lo)) / hours;
        const w = wind ? mean(wind.slice(i, e + 1)) : null;
        if (k > 0 && k < 1) out.push({ at: times[i], hours: r1(hours), from: r1(t0), to: r1(t1), outside: r1(o), k: r4(k), kLow: r4(kLow), gap: r1(t1 - o), wind: r1(w) });
      }
    }
    i = e + 1;
  }
  return out;
}

/** Least-squares line through (outside, rate): the warm-up rate at a given outside temperature. */
function fit(points) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.outside, 0) / n;
  const my = points.reduce((a, p) => a + p.rate, 0) / n;
  let sxx = 0; let sxy = 0;
  for (const p of points) { sxx += (p.outside - mx) ** 2; sxy += (p.outside - mx) * (p.rate - my); }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** One room's figures from its warm-ups and cool-downs. */
export function summarise(warms, cools) {
  const warm = { samples: warms.length, rate: r2(median(warms.map((w) => w.rate))) };
  const pts = warms.filter((w) => w.outside != null);
  if (pts.length >= 4) {
    const outs = pts.map((p) => p.outside).sort((x, y) => x - y);
    const lo = outs[Math.floor(outs.length * 0.1)]; const hi = outs[Math.ceil(outs.length * 0.9) - 1];
    if (hi - lo >= 3) {
      const { a, b } = fit(pts);
      const at = (o) => Math.max(0.05, a + b * o);
      // slower on colder days is the usual way round; a fit the other way is noise from too few heat-ups
      if (b >= 0) {
        warm.mild = { outside: Math.round(hi), rate: r2(at(hi)) };
        warm.cold = { outside: Math.round(lo), rate: r2(at(lo)) };
        warm.perDegree = r2(b);
      }
    }
  }
  const ks = cools.map((c) => c.k);
  const k = median(ks);
  const loss = { samples: cools.length };
  if (k != null && cools.length >= 2) {
    loss.k = Math.round(k * 10000) / 10000;
    loss.at10 = r2(k * 10);                                 // °/h when it's 10° colder outside than the room
    loss.mild = { outside: 10, rate: r2(k * (20 - 10)) };   // a 20° room on a 10° day
    loss.cold = { outside: 0, rate: r2(k * (20 - 0)) };     // and on a 0° day
    loss.holdHours = r1(Math.log((20 - 5) / (17 - 5)) / k); // 20° down to 17° on a 5° night
    loss.halfHours = r1(Math.log(2) / k);                   // to lose half its warmth over outside
  }
  return { warm, loss };
}

/** good / average / poor at holding heat, against the house's other rooms (or, alone, in hours). */
export function rate(k, houseK) {
  if (k == null) return null;
  if (houseK != null) {
    const r = k / houseK;
    return r <= 0.8 ? 'good' : r >= 1.25 ? 'poor' : 'average';
  }
  const tau = 1 / k;
  return tau >= 20 ? 'good' : tau <= 8 ? 'poor' : 'average';
}

export async function buildRoomStats(engine, { days = 7, windEntity = null } = {}) {
  const ha = engine.ha;
  const s = engine.s;
  // the whole week from Home Assistant's history, even before Home Control kept its own log of
  // when each room called for heat: with the boiler off no radiator has heat, so heat loss can be
  // measured from the first day; warm-ups need the app's log, so they fill in as it records them
  const keep = Math.max(1, days);
  const to = Math.floor(Date.now() / STEP) * STEP;
  const from = to - keep * 86400000;
  const logKeep = engine.callLog?.keepDays?.() || keep;
  const callsFrom = Math.max(from, engine.callLog?.started || to, to - logKeep * 86400000);
  const zones = engine.zones.filter((z) => z.enabled);
  const outsideId = s.outsideEntity || detectOutsideEntity(ha);
  const boilerId = s.boiler.entity;
  const ids = new Set();
  for (const z of zones) { if (z.sensor) ids.add(z.sensor); else (z.trvs || []).forEach((e) => ids.add(e)); }
  if (outsideId) ids.add(outsideId);
  if (boilerId) ids.add(boilerId);
  // how windy it was, from a weather entity (the outside one if it's a weather entity)
  const windId = outsideId?.startsWith('weather.') ? outsideId : windEntity?.startsWith('weather.') ? windEntity : null;
  if (windId) ids.add(windId);

  let result = {};
  try {
    result = await ha.send({
      type: 'history/history_during_period',
      start_time: new Date(from).toISOString(), end_time: new Date(to + STEP).toISOString(),
      entity_ids: [...ids], include_start_time_state: true, significant_changes_only: false, minimal_response: false, no_attributes: false,
    }, 60000);
  } catch (e) {
    return { error: `Couldn't read history from Home Assistant: ${e.message}` };
  }
  const times = [];
  for (let t = from; t <= to; t += STEP) times.push(t);
  if (times.length < 3) return { from, to, days: 0, rooms: [], outsideEntity: outsideId || null };
  const outside = outsideId ? sample(rowsFor(result, outsideId), from, to, tempOf(outsideId)) : times.map(() => null);
  const wind = windId ? sample(rowsFor(result, windId), from, to, (r) => windKmh(r.a?.wind_speed, r.a?.wind_speed_unit)) : null;
  const windy = wind && wind.some((x) => x != null) ? wind : null;
  // the boiler firing (Hive's hvac_action, or a switch on)
  const boiler = boilerId
    ? sample(rowsFor(result, boilerId), from, to, (r) => (boilerId.startsWith('climate.') ? r.a?.hvac_action === 'heating' : r.s === 'on'))
    : times.map(() => false);

  // the house on Away or with the heating off, and the two days after: not its usual (modelog.js)
  const unusual = engine.unusualSpans ? engine.unusualSpans(from, to + STEP) : [];
  const away = (t) => unusual.some(([a, b]) => t >= a && t < b);
  const raw = zones.map((z) => {
    const sources = z.sensor ? [z.sensor] : (z.trvs || []).filter((e) => e !== boilerId || (z.trvs || []).length === 1);
    const series = sources.map((id) => sample(rowsFor(result, id), from, to, tempOf(id)));
    const temps = times.map((_, k) => mean(series.map((ser) => ser[k])));
    const calls = (engine.callLog ? engine.callLog.intervals(z.id, from, to) : []).map(([a, b]) => [a, b]);
    const inCall = (t) => calls.some(([a, b]) => t >= a && t < b);
    // no heat at all: not calling, and the boiler off (a room's valve can open on its own reading
    // while the boiler runs for another room, and an always-open radiator always does)
    // (before the app's log, without a boiler to go by, there's no knowing: leave it out)
    // (and the house's unusual times are left out like heated ones)
    const heated = times.map((t, i) => (t < callsFrom && !boilerId) || inCall(t) || !!boiler[i] || away(t));
    const warms = warmUps(times, temps, outside, calls.filter(([a]) => !away(a)));
    const cools = coolDowns(times, temps, outside, heated, { wind: windy });
    return { z, warms, cools, ...summarise(warms, cools) };
  });

  const houseK = median(raw.map((r) => r.loss.k).filter((k) => k != null));
  const multi = raw.filter((r) => r.loss.k != null).length >= 2;
  // heating needed for the weather: minutes of heating per cold degree-day, over the same days
  const log = engine.dailyLog?.days || {};
  const dayKeys = Object.keys(log).sort().slice(-keep - 1, -1); // whole days only
  const dd = dayKeys.reduce((a, k) => { const d = log[k]; const o = d?.outN ? d.outSum / d.outN : null; return a + (o != null ? Math.max(0, BASE - o) : 0); }, 0);

  // each day's heat-loss rate (for heat-loss alerts: is a room losing heat faster than usual?)
  const tz = engine.ha.timeZone || 'UTC';
  const dayOf = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
  // (only stretches far enough above outside to be sure of: see OUTSIDE_SLACK)
  const daily = (cools) => {
    const by = {};
    for (const c of cools) if (c.gap >= MIN_GAP) (by[dayOf(c.at)] ||= []).push(c);
    return Object.entries(by).sort().map(([day, cs]) => {
      const winds = cs.map((c) => c.wind).filter((x) => x != null);
      return { day, k: r4(median(cs.map((c) => c.k))), kLow: r4(median(cs.map((c) => c.kLow ?? c.k))), n: cs.length, wind: winds.length ? r1(median(winds)) : null };
    });
  };

  const rooms = raw.map(({ z, warms, cools, warm, loss }) => {
    const open = engine.openRadiator(z);
    const mins = dayKeys.reduce((a, k) => {
      const d = log[k]; const own = d?.rooms?.[z.id]?.callMin || 0;
      return a + own + (open ? Math.max(0, (d?.boilerMin || 0) - own) : 0);
    }, 0);
    return {
      id: z.id, name: z.name, open,
      warm, loss,
      rating: rate(loss.k ?? null, multi ? houseK : null),
      perColdDegree: dd >= 5 && dayKeys.length >= 3 ? Math.round(mins / dd) : null,
      recent: { warms: warms.slice(-12), cools: cools.slice(-12) },
      daily: daily(cools),
    };
  });
  const outs = outside.filter((x) => x != null);
  return {
    from, to, days: Math.round(((to - from) / 86400000) * 10) / 10, callsFrom,
    outsideEntity: outsideId || null,
    windEntity: windId,
    unusual,
    outside: outs.length ? { min: r1(Math.min(...outs)), max: r1(Math.max(...outs)) } : null,
    houseK: houseK != null ? Math.round(houseK * 10000) / 10000 : null,
    degreeDays: r1(dd), weatherDays: dayKeys.length,
    rooms,
  };
}
