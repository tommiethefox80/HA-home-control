// When will each room next need heat, and so when will the boiler next fire?
//
// A room that isn't heating cools towards the outside temperature, losing a fixed share (k) of
// the gap each hour (Newton's law, k measured for each room from its history: roomstats.js). Step
// through the next day five minutes at a time, with the outside temperature from the weather
// forecast, the room's targets as they'll be (its schedule, holds and boosts running out, Away
// ending), and the same rules the engine uses: it calls for heat once it's below its target by the
// start gap, or earlier to be warm by a scheduled rise ("warm by the scheduled time"). The first
// step where it would call is when it fires. No I/O here, so it can be unit-tested.

const H = 3600000;
const r1 = (x) => Math.round(x * 10) / 10;

/**
 * The outside temperature at any time from now: the weather forecast (hourly points), shifted to
 * agree with the reading now and easing back to the forecast over six hours. With no forecast,
 * the reading now all day. Returns t => °C (or null with neither).
 */
export function outsideCurve(points, nowValue, now) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.temp) && Number.isFinite(p?.t)).sort((a, b) => a.t - b.t);
  if (!pts.length) return () => nowValue ?? null;
  const raw = (t) => {
    if (t <= pts[0].t) return pts[0].temp;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const a = pts[i - 1]; const b = pts[i];
        return a.temp + ((b.temp - a.temp) * (t - a.t)) / (b.t - a.t);
      }
    }
    return pts[pts.length - 1].temp;
  };
  const bias = nowValue != null ? nowValue - raw(now) : 0;
  return (t) => raw(t) + bias * Math.max(0, 1 - (t - now) / (6 * H));
}

/**
 * The next time a room will call for heat.
 *   current      its temperature now
 *   k            share of the gap to outside lost per hour (null: not known, so no cooling is assumed)
 *   outsideAt    t => outside °C
 *   targetAt     t => { temp, source, sched } as the room's target will be then (without warming early)
 *   startGapFor  target => how far below it the room starts calling
 *   leadFor      (nextTemp, roomTemp, outside) => minutes it needs to warm to nextTemp, or null
 *   settleUntil  until then the room holds its temperature (leftover radiator heat after a heat-up)
 * Returns { at, reason: 'cooling' | 'preheat' | 'schedule' | 'change', target, threshold, readyBy,
 * temp, path } (at null if not within the horizon). path: [time, °] every 15 minutes up to `at`.
 */
export function nextHeat({ now, current, k, outsideAt, targetAt, startGapFor, leadFor = null, settleUntil = 0, stepMinutes = 5, horizonHours = 24 }) {
  const step = stepMinutes * 60000;
  const every = Math.max(1, Math.round(15 / stepMinutes));
  let T = current;
  const path = [[now, r1(T)]];
  let prev = targetAt(now);
  // steps on the clock's five minutes, so a change scheduled for 06:30 lands on 06:30
  let last = now;
  for (let i = 1, t = Math.floor(now / step) * step + step; t <= now + horizonHours * H; i++, t += step) {
    const out = outsideAt((t + last) / 2);
    if (k && out != null && t > settleUntil) T = out + (T - out) * Math.exp((-k * (t - last)) / H);
    last = t;
    const tg = targetAt(t);
    const fire = (reason, target, threshold, readyBy = null) => {
      path.push([t, r1(T)]);
      return { at: t, reason, target, threshold: threshold != null ? r1(threshold) : null, readyBy, temp: r1(T), path };
    };
    // warming early so it's at the next scheduled temperature on time, as the engine does
    const nx = tg.sched?.next;
    if (leadFor && tg.source === 'schedule' && nx && nx.temp > tg.temp && nx.temp - T > 0.1) {
      const lead = leadFor(nx.temp, T, out);
      if (lead != null && nx.inMinutes <= lead) return fire('preheat', nx.temp, null, nx.time);
    }
    const start = tg.temp - startGapFor(tg.temp);
    if (T < start) {
      const rose = tg.temp > prev.temp + 0.05;
      return fire(rose ? (tg.source === 'schedule' ? 'schedule' : 'change') : 'cooling', tg.temp, start);
    }
    prev = tg;
    if (i % every === 0) path.push([t, r1(T)]);
  }
  return { at: null, reason: null, path };
}

/**
 * A room heating now: about when it stops, warming at the speed it's learned. `stopAt` is its stop
 * point, or t => its stop point then (a schedule dropping the target ends a heat-up early).
 */
export function heatingUntil({ now, current, stopAt, rate, stepMinutes = 5, maxHours = 12 }) {
  if (current == null || stopAt == null || !rate || rate <= 0) return null;
  const stopFor = typeof stopAt === 'function' ? stopAt : () => stopAt;
  const step = stepMinutes * 60000;
  const path = [[now, r1(current)]];
  let T = current;
  let last = now;
  for (let i = 1, t = Math.floor(now / step) * step + step; t <= now + maxHours * H; i++, t += step) {
    const before = T;
    T += (rate * (t - last)) / H;
    last = t;
    const stop = stopFor(t);
    if (stop == null) return null;
    if (T >= stop) {
      // warm: it got to its stop point; otherwise the stop point dropped below it (temp: where it got to)
      const warm = stop >= before;
      path.push([t, r1(warm ? stop : before)]);
      return { at: t, path, warm, temp: r1(warm ? stop : before) };
    }
    if (i % 3 === 0) path.push([t, r1(T)]);
  }
  return null; // that slow, it's not a prediction worth showing
}

/** Round a time to the nearest five minutes, for "about 23:40". */
export const toFive = (t) => Math.round(t / 300000) * 300000;
