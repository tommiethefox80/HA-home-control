import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextHeat, heatingUntil, outsideCurve, toFive } from '../../src/heating/forecast.js';

const now = Date.UTC(2026, 9, 16, 20, 0);
const M = 60000;
const H = 3600000;
// a schedule: `low` until `riseAt`, then `high`
const sched = (low, high, riseAt) => (t) => (t < riseAt
  ? { temp: low, source: 'schedule', sched: { temp: low, next: { temp: high, inMinutes: Math.round((riseAt - t) / M), time: '06:30' } } }
  : { temp: high, source: 'schedule', sched: { temp: high, next: null } });
const flat = (temp) => () => ({ temp, source: 'schedule', sched: { temp, next: null } });

test('a room cooling towards outside calls when it falls past its start point', () => {
  // 20° in a 5° night losing 10% of the gap an hour reaches 19.7° after ln(15/14.7)/0.1 h, about 12 min
  const r = nextHeat({ now, current: 20, k: 0.1, outsideAt: () => 5, targetAt: flat(20), startGapFor: () => 0.3 });
  assert.equal(r.reason, 'cooling');
  assert.equal(r.at, now + 15 * M); // the first five-minute step past it
  assert.equal(r.threshold, 19.7);
  assert.ok(r.temp < 19.7);
});

test('a slower room, and a colder night, call later and sooner', () => {
  const slow = nextHeat({ now, current: 20, k: 0.03, outsideAt: () => 5, targetAt: flat(20), startGapFor: () => 1 });
  const fast = nextHeat({ now, current: 20, k: 0.09, outsideAt: () => 5, targetAt: flat(20), startGapFor: () => 1 });
  const cold = nextHeat({ now, current: 20, k: 0.03, outsideAt: () => -5, targetAt: flat(20), startGapFor: () => 1 });
  // ln(15/14)/k hours
  assert.ok(Math.abs(slow.at - now - (Math.log(15 / 14) / 0.03) * H) <= 5 * M);
  assert.ok(fast.at < slow.at);
  assert.ok(cold.at < slow.at);
});

test('leftover radiator heat holds it up first', () => {
  const r = nextHeat({ now, current: 20, k: 0.1, outsideAt: () => 5, targetAt: flat(20), startGapFor: () => 0.3, settleUntil: now + 45 * M });
  assert.ok(r.at >= now + 50 * M && r.at <= now + 65 * M, new Date(r.at).toISOString());
});

test('a scheduled rise fires it then, or earlier to be warm on time', () => {
  const rise = now + 10 * H;
  // overnight at 15°: a 19° room cools but stays above 14.7°, so nothing until the rise
  const plain = nextHeat({ now, current: 19, k: 0.02, outsideAt: () => 8, targetAt: sched(15, 20, rise), startGapFor: () => 0.3 });
  assert.equal(plain.reason, 'schedule');
  assert.equal(plain.at, rise);
  assert.equal(plain.target, 20);
  // warming early: an hour's lead
  const early = nextHeat({ now, current: 19, k: 0.02, outsideAt: () => 8, targetAt: sched(15, 20, rise), startGapFor: () => 0.3, leadFor: () => 60 });
  assert.equal(early.reason, 'preheat');
  assert.equal(early.at, rise - 60 * M);
  assert.equal(early.readyBy, '06:30');
  assert.ok(early.path.length > 10 && early.path.at(-1)[0] === early.at);
});

test('steps keep to the clock, so a scheduled change is on time', () => {
  const at = now + 7 * M + 13000; // 20:07:13
  const r = nextHeat({ now: at, current: 19, k: 0.02, outsideAt: () => 8, targetAt: sched(15, 20, now + 10 * H), startGapFor: () => 0.3 });
  assert.equal(r.at, now + 10 * H);
});

test('nothing within the day, and nothing known about cooling', () => {
  const none = nextHeat({ now, current: 21, k: 0.01, outsideAt: () => 15, targetAt: flat(18), startGapFor: () => 0.3 });
  assert.equal(none.at, null);
  // k not known: no cooling is assumed, but a schedule rise still counts
  const unknown = nextHeat({ now, current: 18, k: null, outsideAt: () => 5, targetAt: sched(15, 20, now + 3 * H), startGapFor: () => 0.3 });
  assert.equal(unknown.at, now + 3 * H);
});

test('the outside temperature follows the forecast, shifted to agree with now', () => {
  const pts = [{ t: now, temp: 10 }, { t: now + 6 * H, temp: 4 }, { t: now + 12 * H, temp: 4 }];
  const f = outsideCurve(pts, 12, now);
  assert.equal(f(now), 12); // the reading now
  assert.ok(Math.abs(f(now + 3 * H) - (7 + 1)) < 1e-9); // half way down, half the difference left
  assert.equal(f(now + 9 * H), 4); // back on the forecast
  assert.equal(outsideCurve(null, 9, now)(now + 5 * H), 9);
  assert.equal(outsideCurve([], null, now)(now), null);
});

test('a room heating now: about when it gets there', () => {
  const h = heatingUntil({ now, current: 18, stopAt: 19.5, rate: 1.5 });
  assert.equal(h.at, now + 60 * M);
  assert.equal(h.path.at(-1)[1], 19.5);
  assert.equal(heatingUntil({ now, current: 18, stopAt: 19.5, rate: null }), null);
  // the schedule dropping to 16° at 21:30 ends a slow heat-up then
  const drop = heatingUntil({ now, current: 17, stopAt: (t) => (t < now + 90 * M ? 21 : 16), rate: 0.5 });
  assert.equal(drop.at, now + 90 * M);
  assert.equal(toFive(now + 7 * M), now + 5 * M);
});
