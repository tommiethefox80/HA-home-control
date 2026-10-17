// Heat-loss alerts that the weather can't set off, and dismissing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeatLossWatch, likeForLike } from '../../src/heating/heatloss.js';
import { coolDowns, windKmh } from '../../src/heating/roomstats.js';

const H = 3600000;
const now = Date.UTC(2026, 9, 16, 12, 0);
const day = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
const usual = (extra = {}) => Array.from({ length: 10 }, (_, i) => ({ day: day(i + 2), k: 0.05, kLow: 0.045, n: 3, ...extra }));

// a cool-down sampled every 5 minutes: from t0 towards outside at rate k for `hours`
function cooling(t0, out, k, hours, wind = null) {
  const step = 5 * 60000;
  const times = []; const temps = [];
  for (let t = 0; t <= hours * H; t += step) { times.push(t); temps.push(Math.round((out + (t0 - out) * Math.exp(-k * t / H)) * 100) / 100); }
  const outside = times.map(() => out);
  return coolDowns(times, temps, outside, times.map(() => false), { settleMinutes: 0, wind: wind == null ? null : times.map(() => wind) });
}

test('each cool-down keeps its gap to outside, the lowest it could be if outside were 2° out, and the wind', () => {
  const [c] = cooling(20, 8, 0.05, 4, 15);
  assert.ok(Math.abs(c.k - 0.05) < 0.005, String(c.k));
  assert.ok(c.kLow < c.k && c.kLow > 0.035, String(c.kLow)); // 12° gap: a 2° error is small
  assert.ok(c.gap > 9 && c.gap < 12, String(c.gap));
  assert.equal(c.wind, 15);
  // a mild day, only 4° above outside: the same 2° error makes k far less certain
  const [m] = cooling(20, 16, 0.05, 4);
  assert.ok(m.kLow < m.k * 0.75, `${m.kLow} vs ${m.k}`);
  assert.ok(m.gap < 5);
});

test('wind in km/h from any unit', () => {
  assert.equal(windKmh(10, 'km/h'), 10);
  assert.ok(Math.abs(windKmh(10, 'mph') - 16.09) < 0.01);
  assert.equal(windKmh(10, 'm/s'), 36);
  assert.equal(windKmh(null, 'mph'), null);
});

test('a mild spell that only looks leakier (the outside reading could be out) is no alert', () => {
  const w = new HeatLossWatch(null);
  // the measured rate tripled, but the lowest it could be is only 20% up
  w.update({ rooms: [{ id: 'kids', daily: [...usual(), { day: day(1), k: 0.15, kLow: 0.06, n: 2 }, { day: day(0), k: 0.14, kLow: 0.06, n: 1 }] }] }, now);
  const r = w.check(['kids'], { percent: 40, now, tz: 'UTC' });
  assert.deepEqual(r.alerts, []);
  assert.equal(w.view('kids').elevated, false);
  assert.equal(w.view('kids').percent, 20);
  // a real draught: faster even at its lowest
  w.update({ rooms: [{ id: 'kids', daily: [{ day: day(1), k: 0.11, kLow: 0.1, n: 2 }, { day: day(0), k: 0.1, kLow: 0.095, n: 2 }] }] }, now);
  const r2 = w.check(['kids'], { percent: 40, now, tz: 'UTC' });
  assert.deepEqual(r2.alerts.map((a) => a.id), ['kids']);
  assert.ok(r2.alerts[0].percent >= 90 && r2.alerts[0].percent < 100, String(r2.alerts[0].percent));
});

test('windy days are compared with the room\'s own windy days', () => {
  // calm days lose 0.05, windy days 0.08
  const days = [
    ...Array.from({ length: 6 }, (_, i) => ({ day: day(i + 2), k: 0.05, kLow: 0.05, n: 3, wind: 8 })),
    ...Array.from({ length: 5 }, (_, i) => ({ day: day(i + 8), k: 0.08, kLow: 0.08, n: 3, wind: 40 })),
  ];
  const w = new HeatLossWatch(null);
  w.update({ rooms: [{ id: 'bed', daily: [...days, { day: day(1), k: 0.085, kLow: 0.085, n: 2, wind: 42 }, { day: day(0), k: 0.085, kLow: 0.085, n: 2, wind: 38 }] }] }, now);
  assert.deepEqual(w.check(['bed'], { percent: 40, now, tz: 'UTC' }).alerts, [], 'windy, but no worse than its usual windy days');
  const v = w.view('bed');
  assert.equal(v.windMatched, true);
  assert.equal(v.usualK, 0.08);
  // the same rate on calm days is worth a look
  w.update({ rooms: [{ id: 'bed', daily: [{ day: day(1), k: 0.085, kLow: 0.085, n: 2, wind: 6 }, { day: day(0), k: 0.085, kLow: 0.085, n: 2, wind: 9 }] }] }, now);
  assert.deepEqual(w.check(['bed'], { percent: 40, now, tz: 'UTC' }).alerts.map((a) => a.id), ['bed']);
});

test('windier than any day it can compare with: not compared at all', () => {
  const r = likeForLike(Array.from({ length: 8 }, () => ({ k: 0.05, wind: 10 })), 60);
  assert.equal(r.windy, true);
  const w = new HeatLossWatch(null);
  w.update({ rooms: [{ id: 'bed', daily: [...usual({ wind: 10 }), { day: day(1), k: 0.2, kLow: 0.2, n: 3, wind: 65 }] }] }, now);
  assert.deepEqual(w.check(['bed'], { percent: 40, now, tz: 'UTC' }).alerts, []);
  assert.equal(w.view('bed').tooWindy, true);
  // calmer than usual: compared with the calmest days it has (as windy or windier), so it's a fair test
  const calm = likeForLike(Array.from({ length: 8 }, (_, i) => ({ k: 0.05, wind: 20 + i })), 5);
  assert.equal(calm.windy, false);
  assert.equal(calm.pool.length, 4);
});

test('no wind history yet: compared as before', () => {
  const r = likeForLike([{ k: 0.05, wind: null }, { k: 0.05, wind: null }, { k: 0.05, wind: 10 }, { k: 0.05, wind: null }], 30);
  assert.equal(r.matched, false);
  assert.equal(r.pool.length, 4);
});

test('a dismissed notice stays hidden until the room is back to normal, then can come back', () => {
  const w = new HeatLossWatch(null);
  const at = (t, n) => new Date(t - n * 86400000).toISOString().slice(0, 10);
  const leaky = (t) => [{ day: at(t, 1), k: 0.1, kLow: 0.1, n: 2 }, { day: at(t, 0), k: 0.1, kLow: 0.1, n: 2 }];
  w.update({ rooms: [{ id: 'kids', daily: [...usual(), ...leaky(now)] }] }, now);
  assert.equal(w.check(['kids'], { now, tz: 'UTC' }).alerts.length, 1);
  assert.equal(w.dismiss('kids', now), true);
  assert.deepEqual(w.elevated(), [{ id: 'kids', percent: 100, dismissed: true, windMatched: false }]);
  // a morning with too little to go on doesn't undo it
  const t1 = now + 2 * 86400000;
  w.check(['kids'], { now: t1, tz: 'UTC' });
  // still faster four days on: no phone alert while dismissed
  const t2 = now + 4 * 86400000;
  w.update({ rooms: [{ id: 'kids', daily: leaky(t2) }] }, t2);
  assert.equal(w.check(['kids'], { now: t2, tz: 'UTC' }).alerts.length, 0);
  assert.equal(w.elevated()[0].dismissed, true);
  // back to normal: the dismissal is done with
  const t3 = t2 + 86400000;
  w.update({ rooms: [{ id: 'kids', daily: [{ day: at(t3, 0), k: 0.05, kLow: 0.05, n: 4 }] }] }, t3);
  w.days.kids[at(t3, 1)] = { k: 0.05, kLow: 0.05, n: 2, wind: null };
  assert.deepEqual(w.check(['kids'], { now: t3, tz: 'UTC' }).normal, ['kids']);
  assert.equal(w.view('kids').dismissed, false);
  // faster again later: shown (and told) again
  const t4 = t3 + 4 * 86400000;
  w.update({ rooms: [{ id: 'kids', daily: leaky(t4) }] }, t4);
  assert.equal(w.check(['kids'], { now: t4, tz: 'UTC' }).alerts.length, 1);
  assert.equal(w.elevated()[0].dismissed, false);
  // nothing to dismiss when it isn't faster
  assert.equal(new HeatLossWatch(null).dismiss('kids'), false);
});
