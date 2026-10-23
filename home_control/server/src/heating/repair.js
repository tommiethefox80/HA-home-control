// Once (1.14.2): before then, a room calling for heat while the boiler couldn't be reached (Hive
// down) was counted as heating, though nothing could fire. This takes that time back out of the
// rooms' heating records (Today, the room cards, Insights), for as far back as Home Assistant has
// the boiler's history (about 10 days). Boiler time itself is taken from that history anyway.
import { localDate } from './insights.js';

const UNAVAILABLE = new Set(['unavailable', 'unknown']);

/** Remove [g0, g1] gaps from [a, b] intervals: what's left of each. */
export function clip(intervals, gaps) {
  let parts = intervals;
  for (const [g0, g1] of gaps) {
    parts = parts.flatMap(([a, b, ...rest]) => (b <= g0 || a >= g1 ? [[a, b, ...rest]] : [[a, Math.min(b, g0), ...rest], [Math.max(a, g1), b, ...rest]].filter(([x, y]) => y > x)));
  }
  return parts;
}

/** Minutes of [a, b] inside the gaps, by local day. */
export function overlapByDay(a, b, gaps, tz) {
  const out = {};
  for (const [g0, g1] of gaps) {
    const x = Math.max(a, g0); const y = Math.min(b, g1);
    for (let t = x; t < y; t += 60000) {
      const k = localDate(t, tz);
      out[k] = (out[k] || 0) + Math.min(1, (y - t) / 60000);
    }
  }
  return out;
}

export async function repairUnreachable(engine, { now = Date.now() } = {}) {
  const rt = engine.rt;
  if ((rt.repairs?.unreachable || 0) >= 1) return null;
  const done = () => { (rt.repairs ||= {}).unreachable = 1; engine.store.save(); };
  const b = engine.s.boiler?.entity;
  if (!b || !engine.callLog) { done(); return null; }
  const from = now - 10 * 86400000;
  let rows;
  try {
    const res = await engine.ha.send({
      type: 'history/history_during_period', start_time: new Date(from).toISOString(), entity_ids: [b],
      minimal_response: true, no_attributes: true, significant_changes_only: false,
    });
    rows = res?.[b] || [];
  } catch { return null; } // try again at the next start
  // when the boiler couldn't be reached
  const gaps = [];
  for (let i = 0; i < rows.length; i++) {
    if (!UNAVAILABLE.has(rows[i].s)) continue;
    const t = Math.max(from, (rows[i].lu ?? rows[i].lc) * 1000);
    const next = i + 1 < rows.length ? (rows[i + 1].lu ?? rows[i + 1].lc) * 1000 : now;
    const last = gaps[gaps.length - 1];
    if (last && t <= last[1]) last[1] = Math.max(last[1], next); else if (next > t) gaps.push([t, next]);
  }
  // as the engine now: the first few minutes are a blip (Home Assistant restarting), not an outage
  const BLIP = 3 * 60000;
  for (let i = gaps.length - 1; i >= 0; i--) { gaps[i][0] += BLIP; if (gaps[i][1] <= gaps[i][0]) gaps.splice(i, 1); }
  if (!gaps.length) { done(); return { minutes: 0, gaps: 0 }; }
  const tz = engine.ha.timeZone;
  const days = engine.dailyLog?.days || {};
  let removed = 0;
  for (const [zid, arr] of Object.entries(engine.callLog.zones)) {
    const out = [];
    for (const iv of arr) {
      const open = iv[1] == null;
      const [a, z] = [iv[0], open ? now : iv[1]];
      for (const [k, m] of Object.entries(overlapByDay(a, z, gaps, tz))) {
        removed += m;
        const r = days[k]?.rooms?.[zid];
        if (r) r.callMin = Math.max(0, (r.callMin || 0) - m);
      }
      const parts = clip([[a, z, iv[2], iv[3]]], gaps);
      // a heat-up still going stays open (if its last part runs to now)
      if (open && parts.length && parts[parts.length - 1][1] === now) parts[parts.length - 1][1] = null;
      out.push(...parts);
    }
    engine.callLog.zones[zid] = out;
  }
  engine.callLog.flush();
  engine.dailyLog?.flush();
  done();
  return { minutes: Math.round(removed), gaps: gaps.length };
}
