// Heat-loss alerts that the weather can't set off, and dismissing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeatLossWatch, likeForLike, asCold } from '../../src/heating/heatloss.js';
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
  w.update({ rooms: [{ id: 'bed', daily: [...usual({ wind: 10 }), { day: day(1), k: 0.2, kLow: 0.2, n: 3, wind: 65 }, { day: day(0), k: 0.2, kLow: 0.2, n: 1, wind: 62 }] }] }, now);
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
  assert.deepEqual(w.elevated(), [{ id: 'kids', percent: 100, dismissed: true, windMatched: false, coldMatched: false, outside: null }]);
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

test('cold days are compared with the room\'s own days as cold (1.16.2)', () => {
  // mild October days lose 0.04; the room reads 0.06 on its colder days, with nothing wrong
  const days = [
    ...Array.from({ length: 8 }, (_, i) => ({ day: day(i + 2), k: 0.04, kLow: 0.036, n: 3, out: 11 })),
    ...Array.from({ length: 5 }, (_, i) => ({ day: day(i + 10), k: 0.06, kLow: 0.054, n: 3, out: 3 })),
  ];
  const w = new HeatLossWatch(null);
  w.update({ rooms: [{ id: 'back', daily: [...days, { day: day(1), k: 0.065, kLow: 0.06, n: 2, out: 4 }, { day: day(0), k: 0.066, kLow: 0.061, n: 2, out: 3.5 }] }] }, now);
  assert.deepEqual(w.check(['back'], { percent: 40, now, tz: 'UTC' }).alerts, [], 'no worse than its other cold days');
  const v = w.view('back');
  assert.equal(v.coldMatched, true);
  assert.equal(v.usualK, 0.06);
  assert.equal(v.outside, 3.8);
  // the same rate on a mild day is worth a look
  w.update({ rooms: [{ id: 'back', daily: [{ day: day(1), k: 0.065, kLow: 0.06, n: 2, out: 11 }, { day: day(0), k: 0.066, kLow: 0.061, n: 2, out: 10.5 }] }] }, now);
  assert.deepEqual(w.check(['back'], { percent: 40, now, tz: 'UTC' }).alerts.map((a) => a.id), ['back']);
});

test('colder than any day it has: not compared (the first cold spell builds its usual)', () => {
  assert.equal(asCold(Array.from({ length: 10 }, () => ({ k: 0.04, out: 11 })), 3).cold, true);
  assert.equal(asCold(Array.from({ length: 10 }, () => ({ k: 0.04, out: 11 })), 10).cold, false);
  assert.equal(asCold([{ k: 0.04, out: null }], null).matched, false); // no outside figures: as before
  const w = new HeatLossWatch(null);
  const mild = Array.from({ length: 10 }, (_, i) => ({ day: day(i + 2), k: 0.04, kLow: 0.036, n: 3, out: 11 }));
  // flagged on mild days first
  w.update({ rooms: [{ id: 'back', daily: [...mild, { day: day(1), k: 0.1, kLow: 0.09, n: 2, out: 10 }, { day: day(0), k: 0.1, kLow: 0.09, n: 2, out: 10 }] }] }, now);
  assert.equal(w.check(['back'], { now, tz: 'UTC' }).alerts.length, 1);
  // then a cold snap: no longer compared, said as such rather than "back to its usual"
  w.update({ rooms: [{ id: 'back', daily: [{ day: day(1), k: 0.12, kLow: 0.11, n: 2, out: 1 }, { day: day(0), k: 0.12, kLow: 0.11, n: 2, out: 0 }] }] }, now);
  const r = w.check(['back'], { now, tz: 'UTC' });
  assert.deepEqual([r.alerts, r.normal, r.colder], [[], [], ['back']]);
  assert.equal(w.view('back').newCold, true);
});

test('one odd day isn\'t enough: both of the last two days have to be faster', () => {
  const w = new HeatLossWatch(null);
  w.update({ rooms: [{ id: 'kids', daily: [...usual(), { day: day(1), k: 0.05, kLow: 0.045, n: 2 }, { day: day(0), k: 0.2, kLow: 0.19, n: 3 }] }] }, now);
  assert.deepEqual(w.check(['kids'], { now, tz: 'UTC' }).alerts, []);
  // only today so far: nothing to go on yet
  const w2 = new HeatLossWatch(null);
  w2.update({ rooms: [{ id: 'kids', daily: [...usual(), { day: day(0), k: 0.2, kLow: 0.19, n: 3 }] }] }, now);
  assert.deepEqual(w2.check(['kids'], { now, tz: 'UTC' }).alerts, []);
});

// A room as it really is: warm air over walls and furniture that hold most of the heat (two parts,
// not the one Newton's law assumes). Through an autumn that gets colder, with nothing changed,
// the measured k rises; that mustn't be told as a draught. A window left open must still be.
function autumn({ days = 45, windowFrom = null } = {}) {
  const STEP = 5 * 60000; const start = Date.UTC(2026, 9, 1);
  const sched = (h) => (h >= 6.5 && h < 9 ? 18 : h >= 17 && h < 22.5 ? 20 : 15);
  const outAt = (t) => { const d = (t - start) / 86400000; return 13 - d * 0.22 + 2.5 * Math.sin(d * 1.3) + 3 * Math.sin(((t / H) % 24 - 9) / 24 * 2 * Math.PI); };
  const times = []; const temps = []; const outside = []; const heated = [];
  let Ta = 15; let Tf = 14.5; let calling = false;
  for (let i = 0; i < days * 288; i++) {
    const t = start + i * STEP; const target = sched(((t - start) / H) % 24); const To = outAt(t);
    if (Ta < target - 0.3) calling = true; if (Ta > target + 0.2) calling = false;
    const vent = windowFrom != null && t >= start + windowFrom * 86400000 ? 0.18 : 0.12;
    for (let s = 0; s < 5; s++) {
      const dTa = 1.2 * (Tf - Ta) + vent * (To - Ta) + (calling ? 8 : 0);
      const dTf = (1.2 * (Ta - Tf) + 0.1 * (To - Tf)) / 12;
      Ta += dTa / 60; Tf += dTf / 60;
    }
    times.push(t); temps.push(Math.round(Ta * 10) / 10); outside.push(To); heated.push(calling);
  }
  const cools = coolDowns(times, temps, outside, heated);
  const by = {};
  for (const c of cools) if (c.gap >= 5) (by[new Date(c.at).toISOString().slice(0, 10)] ||= []).push(c);
  const med = (a) => { const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const daily = Object.entries(by).map(([d, cs]) => ({ day: d, k: med(cs.map((c) => c.k)), kLow: med(cs.map((c) => c.kLow)), n: cs.length, wind: null, out: med(cs.map((c) => c.outside)) }));
  // checked each evening, as the app does every half hour
  const w = new HeatLossWatch(null); const told = [];
  for (let d = 0; d < days; d++) {
    const at = start + d * 86400000 + 23 * H;
    const key = new Date(at).toISOString().slice(0, 10);
    w.update({ rooms: [{ id: 'back', daily: daily.filter((x) => x.day <= key && x.day > new Date(at - 7 * 86400000).toISOString().slice(0, 10)) }] }, at);
    for (const a of w.check(['back'], { now: at, tz: 'UTC' }).alerts) told.push({ day: d, percent: a.percent });
  }
  return told;
}

test('an unchanged room through a colder and colder autumn: no notices; a window left open: told', () => {
  assert.deepEqual(autumn(), []);
  const open = autumn({ windowFrom: 38 });
  assert.ok(open.length >= 1 && open[0].day >= 38 && open[0].day <= 41, JSON.stringify(open));
});
