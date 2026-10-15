import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedParts, zonedToUtc, normalizeWeek, stateAt, nextChange, daySegments, sunTimes,
  suggestNewTime, describeWhen, emptyWeek, livedInWeek, startOfWeek, addDays, normalizePoint, turnOnPoint,
  inSeason, normalizeSeason, inTimeWindow, nextLocalTime, morningChange,
} from '../../src/lighting/schedule.js';

const ctx = { tz: 'Europe/London', lat: 53.26, lon: -2.52 }; // Northwich-ish

const at = (s) => Date.parse(s);
const hhmm = (ms) => { const p = zonedParts(ms, ctx.tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

function weekOf(points) {
  const w = emptyWeek();
  for (let d = 0; d < 7; d++) w[d] = points;
  return normalizeWeek(w);
}

test('zonedParts gives Monday = 0 and BST hours', () => {
  const p = zonedParts(at('2026-10-12T09:30:00Z'), ctx.tz); // Monday, BST
  assert.equal(p.dow, 0);
  assert.equal(p.hour, 10);
});

test('zonedToUtc round-trips in summer and winter', () => {
  assert.equal(zonedToUtc(2026, 7, 1, 7 * 60, ctx.tz), at('2026-07-01T06:00:00Z'));
  assert.equal(zonedToUtc(2026, 12, 1, 7 * 60, ctx.tz), at('2026-12-01T07:00:00Z'));
});

test('zonedToUtc handles the clock change days', () => {
  // 29 March 2026: 01:00 GMT jumps to 02:00 BST. 01:30 doesn't exist; it should land at or after the gap.
  const t = zonedToUtc(2026, 3, 29, 90, ctx.tz);
  assert.ok(t >= at('2026-03-29T01:00:00Z') && t <= at('2026-03-29T01:30:00Z'));
  // 07:00 on both change days is unambiguous.
  assert.equal(zonedToUtc(2026, 3, 29, 420, ctx.tz), at('2026-03-29T06:00:00Z'));
  assert.equal(zonedToUtc(2026, 10, 25, 420, ctx.tz), at('2026-10-25T07:00:00Z'));
});

test('validation drops junk, clamps, sorts and dedupes', () => {
  const w = normalizeWeek({ 0: [
    { time: '22:30', on: true, brightness: 400 },
    { time: '25:00', on: true },
    { nonsense: true },
    { time: '07:00', on: false, brightness: 50 },
    { time: '07:00', on: true, brightness: 10 },
    { anchor: 'sunset', offset: -999, on: true, kelvin: 99999 },
  ] });
  assert.deepEqual(w[0].map((p) => p.time ?? p.anchor), ['07:00', 'sunset', '22:30']);
  assert.equal(w[0][0].on, true); // later duplicate wins
  assert.equal(w[0][2].brightness, 100);
  assert.equal(w[0][1].offset, -240);
  assert.equal(w[0][1].kelvin, 6500);
  assert.equal(normalizePoint({ time: '07:00', on: false, brightness: 50 }).brightness, null);
  assert.equal(w[1].length, 0);
});

test('empty schedule means not managed', () => {
  assert.equal(stateAt(emptyWeek(), Date.now(), ctx), null);
  assert.equal(nextChange(emptyWeek(), Date.now(), ctx), null);
  assert.deepEqual(daySegments(emptyWeek(), { year: 2026, month: 10, day: 12, dow: 0 }, ctx), []);
});

test('state carries over midnight and wraps across the week', () => {
  const w = emptyWeek();
  w[6] = [{ time: '20:00', on: true, brightness: 30 }]; // only Sunday
  const week = normalizeWeek(w);
  // Wednesday morning: still Sunday's 20:00 point.
  const s = stateAt(week, at('2026-10-14T08:00:00Z'), ctx);
  assert.equal(s.point.brightness, 30);
  const n = nextChange(week, at('2026-10-14T08:00:00Z'), ctx);
  assert.equal(n.at, at('2026-10-18T19:00:00Z')); // Sunday 20:00 BST
});

test('next change and state within a day', () => {
  const week = weekOf([
    { time: '07:00', on: true, brightness: 80 },
    { time: '09:00', on: false },
    { time: '22:30', on: true, brightness: 20, kelvin: 2200 },
    { time: '23:30', on: false },
  ]);
  const t = at('2026-10-12T21:40:00Z'); // 22:40 BST
  assert.equal(stateAt(week, t, ctx).point.brightness, 20);
  assert.equal(hhmm(nextChange(week, t, ctx).at), '23:30');
  const segs = daySegments(week, { year: 2026, month: 10, day: 12, dow: 0 }, ctx);
  assert.equal(segs[0].from, 0);
  assert.equal(segs[0].on, false); // carried from the previous night's 23:30
  assert.equal(segs.at(-1).to, 1440);
});

test('sun times are sensible for the UK and differ across the year', () => {
  const june = sunTimes({ year: 2026, month: 6, day: 21, dow: 6 }, ctx);
  const dec = sunTimes({ year: 2026, month: 12, day: 21, dow: 0 }, ctx);
  const jSet = zonedParts(june.sunset, ctx.tz);
  const dSet = zonedParts(dec.sunset, ctx.tz);
  assert.ok(jSet.hour === 21, `june sunset ${jSet.hour}`);
  assert.ok(dSet.hour === 15 || dSet.hour === 16, `dec sunset ${dSet.hour}`);
  assert.ok(zonedParts(june.sunrise, ctx.tz).hour === 4);
});

test('no sunset in the polar summer means the sun point is skipped', () => {
  const polar = { tz: 'Europe/Oslo', lat: 78.2, lon: 15.6 };
  const s = sunTimes({ year: 2026, month: 6, day: 21, dow: 6 }, polar);
  assert.equal(s.sunset, null);
});

test('sun-relative points resolve per day with offset', () => {
  const week = weekOf([{ anchor: 'sunset', offset: -30, on: true, brightness: 60 }, { time: '23:00', on: false }]);
  const oct = nextChange(week, at('2026-10-12T08:00:00Z'), ctx);
  const sun = sunTimes({ year: 2026, month: 10, day: 12, dow: 0 }, ctx);
  assert.equal(Math.abs(oct.at - (sun.sunset - 30 * 60000)) < 60000, true);
  // ctx.sun overrides take priority (from sun.sun).
  const fixed = { ...ctx, sun: { '2026-10-12': { sunset: at('2026-10-12T17:00:00Z') } } };
  assert.equal(hhmm(nextChange(week, at('2026-10-12T08:00:00Z'), fixed).at), '17:30');
});

test('sunset schedule across the October clock change keeps local times', () => {
  const week = weekOf([{ time: '07:00', on: true }, { time: '08:00', on: false }]);
  const before = nextChange(week, at('2026-10-23T12:00:00Z'), ctx);
  const after = nextChange(week, at('2026-10-24T12:00:00Z'), ctx);
  assert.equal(hhmm(before.at), '07:00');
  assert.equal(hhmm(after.at), '07:00');
  assert.equal(after.at - before.at, 25 * 3600000); // the day is 25 hours long
});

test('suggestNewTime goes 2 h after the last or into the biggest gap', () => {
  assert.equal(suggestNewTime([]), '18:00');
  assert.equal(suggestNewTime([{ time: '07:00' }]), '09:00');
  assert.equal(suggestNewTime([{ time: '06:00' }, { time: '08:00' }, { time: '23:00' }]), '15:30');
});

test('describeWhen reads naturally', () => {
  assert.equal(describeWhen({ time: '07:15' }), '07:15');
  assert.equal(describeWhen({ anchor: 'sunset', offset: -30 }), '30 min before sunset');
  assert.equal(describeWhen({ anchor: 'sunrise', offset: 90 }), '1 h 30 min after sunrise');
  assert.equal(describeWhen({ anchor: 'sunset', offset: 0 }), 'sunset');
});

test('lived-in pattern is stable for a day and varies between groups', () => {
  const ws = startOfWeek(at('2026-10-14T12:00:00Z'), ctx.tz);
  const a1 = livedInWeek('lounge', ws, ctx);
  const a2 = livedInWeek('lounge', ws, ctx);
  const b = livedInWeek('kitchen', ws, ctx);
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  assert.equal(a1[0][1].on, true);
  assert.equal(addDays(ws, 0).dow, 0);
});

test('turning on by hand follows the time of day', () => {
  const week = weekOf([
    { time: '07:00', on: true, brightness: 60, kelvin: 3500 },
    { time: '09:00', on: false },
    { time: '19:00', on: true, brightness: 70 },
    { time: '21:30', on: true, brightness: 35, kelvin: 2200 },
    { time: '23:30', on: false },
  ]);
  const at = (hhmm) => Date.parse(`2026-10-14T${hhmm}:00+01:00`);
  assert.equal(turnOnPoint(week, at('23:45'), ctx).point.brightness, 35); // late evening: last night's level
  assert.equal(turnOnPoint(week, at('03:00'), ctx).point.brightness, 35); // small hours: still the evening level
  assert.equal(turnOnPoint(week, at('06:15'), ctx).point.brightness, 60); // morning level due within the hour
  assert.equal(turnOnPoint(week, at('12:00'), ctx).point.brightness, 60); // daytime: the morning level
  assert.equal(turnOnPoint(week, at('18:30'), ctx).point.brightness, 70); // evening level due in 30 min
  assert.equal(turnOnPoint(emptyWeek(), at('12:00'), ctx), null);
  const offOnly = weekOf([{ time: '23:00', on: false }]);
  assert.equal(turnOnPoint(offOnly, at('12:00'), ctx), null);
});

test('seasons, including ones that wrap the year end', () => {
  const xmas = normalizeSeason({ from: '12-01', to: '01-06' });
  assert.equal(inSeason({ month: 12, day: 25 }, xmas), true);
  assert.equal(inSeason({ month: 1, day: 6 }, xmas), true);
  assert.equal(inSeason({ month: 1, day: 7 }, xmas), false);
  assert.equal(inSeason({ month: 10, day: 9 }, xmas), false);
  const summer = normalizeSeason({ from: '06-01', to: '08-31' });
  assert.equal(inSeason({ month: 7, day: 1 }, summer), true);
  assert.equal(inSeason({ month: 9, day: 1 }, summer), false);
  assert.equal(inSeason({ month: 3, day: 3 }, null), true);
  assert.equal(normalizeSeason({ from: '13-01', to: '01-01' }), null);
});

test('night windows cross midnight', () => {
  assert.equal(inTimeWindow(23 * 60 + 30, '23:00', '06:00'), true);
  assert.equal(inTimeWindow(3 * 60, '23:00', '06:00'), true);
  assert.equal(inTimeWindow(6 * 60, '23:00', '06:00'), false);
  assert.equal(inTimeWindow(12 * 60, '23:00', '06:00'), false);
  assert.equal(inTimeWindow(13 * 60, '12:00', '14:00'), true);
});

test('holding until the morning skips changes in the night', () => {
  const week = weekOf([
    { time: '06:30', on: true, brightness: 70 }, { time: '07:30', on: false },
    { time: '23:00', on: true, brightness: 10 }, { time: '00:30', on: false },
  ]);
  const at = Date.parse('2026-10-14T22:45:00+01:00');
  const { morning, change } = morningChange(week, at, ctx);
  assert.equal(hhmm(morning), '05:00');
  assert.equal(hhmm(change.at), '06:30');
  assert.equal(nextLocalTime(Date.parse('2026-10-14T04:00:00+01:00'), '05:00', ctx.tz), Date.parse('2026-10-14T05:00:00+01:00'));
});
