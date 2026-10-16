// Room stats: heat loss from cool-downs (Newton's law), warm-up against outside temperature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warmUps, coolDowns, summarise, rate } from '../../src/heating/roomstats.js';

const STEP = 5 * 60000; const H = 3600000;
const start = Date.UTC(2026, 9, 10);

/** A day of a room losing k of its gap to outside each hour, heated (at `heat` °/h) in the given hours. */
function day({ k, out, heatHours = [], heat = 2, T0 = 19, hours = 24 }) {
  const times = []; const temps = []; const outside = []; const heated = []; const calls = [];
  let T = T0; let open = null;
  for (let t = start; t <= start + hours * H; t += STEP) {
    const h = (t - start) / H;
    const o = typeof out === 'function' ? out(h) : out;
    const on = heatHours.some(([a, b]) => h >= a && h < b);
    if (on && open == null) open = t;
    if (!on && open != null) { calls.push([open, t]); open = null; }
    times.push(t); temps.push(Math.round(T * 100) / 100); outside.push(o); heated.push(on);
    T += (-k * (T - o) + (on ? heat : 0)) * (STEP / H);
  }
  return { times, temps, outside, heated, calls };
}

test('heat loss: k comes back out of a cooling room, whatever the outside temperature', () => {
  for (const [k, out] of [[0.05, 5], [0.1, 0], [0.03, 10]]) {
    const d = day({ k, out, heatHours: [[0, 2], [12, 14]] });
    const cools = coolDowns(d.times, d.temps, d.outside, d.heated);
    assert.ok(cools.length >= 2, `cool-downs found for k ${k}`);
    for (const c of cools) assert.ok(Math.abs(c.k - k) / k < 0.08, `k ${c.k} vs ${k}`);
  }
});

test('the first 45 minutes after heating are left out (the radiators are still warm), and so is a stretch something else warmed', () => {
  const d = day({ k: 0.05, out: 5, heatHours: [[0, 2]], hours: 6 });
  const cools = coolDowns(d.times, d.temps, d.outside, d.heated);
  assert.ok(cools.every((c) => c.at >= start + 2.75 * H));
  // the sun comes out at hour 4 and warms it by a degree
  const sunny = { ...d, temps: d.temps.map((t, i) => (d.times[i] >= start + 4 * H ? t + 1 : t)) };
  const across = coolDowns(sunny.times, sunny.temps, sunny.outside, sunny.heated).filter((c) => c.at < start + 4 * H && c.at + c.hours * H > start + 4 * H);
  assert.deepEqual(across, [], 'no cool-down runs across the sunny spell');
});

test('warm-ups: slower on colder days, summed up at a mild and a cold temperature', () => {
  const warms = [];
  for (const [out, r] of [[12, 1.8], [10, 1.7], [6, 1.45], [4, 1.35], [2, 1.2], [8, 1.6]]) {
    warms.push({ at: 0, minutes: 60, rise: r, rate: r, outside: out });
  }
  const s = summarise(warms, []);
  assert.equal(s.warm.samples, 6);
  assert.ok(s.warm.mild.rate > s.warm.cold.rate);
  assert.equal(s.warm.mild.outside, 12);
  assert.equal(s.warm.cold.outside, 2);
  assert.ok(Math.abs(s.warm.perDegree - 0.06) < 0.01);
});

test('warmUps measures each heat-up of 20 minutes or more', () => {
  const d = day({ k: 0.05, out: 5, heatHours: [[1, 2], [5, 5.2]], heat: 2 });
  const w = warmUps(d.times, d.temps, d.outside, d.calls);
  assert.equal(w.length, 1, 'the 12-minute one is too short');
  assert.ok(w[0].rate > 1.2 && w[0].rate < 2, `rate ${w[0].rate}`);
});

test('heat loss summed up: per hour at a given outside temperature, and hours from 20° to 17° on a 5° night', () => {
  const s = summarise([], [{ k: 0.05 }, { k: 0.05 }, { k: 0.06 }]);
  assert.equal(s.loss.k, 0.05);
  assert.equal(s.loss.at10, 0.5);
  assert.deepEqual(s.loss.cold, { outside: 0, rate: 1 });
  assert.equal(s.loss.holdHours, 4.5); // ln(15/12) / 0.05
  assert.equal(rate(0.03, 0.05), 'good');
  assert.equal(rate(0.08, 0.05), 'poor');
  assert.equal(rate(0.05, 0.05), 'average');
  assert.equal(rate(1 / 30, null), 'good');
});
