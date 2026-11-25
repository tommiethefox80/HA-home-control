// The History chart: half-hourly figures kept by the app, and any range drawn from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LongLog, HALF, stepFor, bucketOf, buildHistory } from '../../src/heating/longlog.js';

const H = 3600000; const D = 24 * H;
const view = (id, current, target, heating) => ({ id, enabled: true, current, target, heating, calling: heating });

function engineWith(log, { zones = [{ id: 'bed', name: 'Bedroom', enabled: true, trvs: ['climate.bed'] }], daily = {}, calls = null } = {}) {
  return {
    ha: { timeZone: 'Europe/London', states: new Map(), get: () => null, send: async () => ({}) },
    s: { boiler: { entity: 'climate.boiler' }, outsideEntity: 'weather.home' },
    zones, longLog: log, dailyLog: { days: daily },
    callLog: calls,
    outsideNow: () => 8,
    boilerFiring: () => false,
  };
}

test('every half hour: the average temperature and target, and minutes heated', () => {
  const log = new LongLog(null);
  const t0 = Date.UTC(2026, 10, 10, 18, 0);
  const eng = { ...engineWith(log), boilerFiring: () => true };
  // 18:00–18:30, a look each minute: heating at 19° until 18:20, then not, at 20° (the first look
  // starts the count: 19 minutes heating, 29 counted)
  for (let m = 0; m <= 30; m++) {
    const heating = m < 20;
    log.sample(t0 + m * 60000, eng, [view('bed', heating ? 19 : 20, 20, heating)]);
  }
  log.sample(t0 + 31 * 60000, eng, [view('bed', 20, 18, false)]); // into the next half hour: the first is kept
  const x = log.at(t0);
  assert.equal(x.rooms.bed.t, 19.3);
  assert.equal(x.rooms.bed.g, 20);
  assert.equal(x.rooms.bed.h, 19);
  assert.equal(x.out, 8);
  assert.equal(x.boil, 29);
  assert.equal(log.lastAt(), t0);
  assert.equal(log.firstAt(), t0);
  // the half hour being gathered shows too
  assert.equal(log.at(t0 + HALF).rooms.bed.g, 19, '20° then 18° so far');
});

test('kept to a file, gaps left empty, filled in only where nothing was kept, and old ones dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-long-'));
  const log = new LongLog(dir);
  const t0 = Date.UTC(2026, 10, 10, 18, 0);
  log.put(t0, { rooms: { bed: { t: 19, g: 20, h: 10 } }, out: 7, boil: 12 });
  log.put(t0 + 4 * HALF, { rooms: { bed: { t: 20, g: 20, h: 0 } }, out: 6, boil: 0 });
  // filled in from Home Assistant: earlier than anything, and a gap; what's kept stays
  log.put(t0 - 2 * HALF, { rooms: { bed: { t: 18, g: 18, h: null } }, out: 9, boil: 5 }, { onlyGaps: true });
  log.put(t0, { rooms: { bed: { t: 99, g: 99, h: 99 } }, out: 99, boil: 99 }, { onlyGaps: true });
  log.flush();
  const again = new LongLog(dir);
  assert.equal(again.at(t0 - 2 * HALF).rooms.bed.t, 18);
  assert.equal(again.at(t0 - HALF), null);
  assert.equal(again.at(t0).rooms.bed.t, 19, 'not overwritten');
  assert.equal(again.at(t0 + 2 * HALF), null, 'the app was stopped');
  assert.equal(again.at(t0 + 4 * HALF).out, 6);
  again.keepDays = () => 1;
  again.prune(t0 + D + HALF);
  assert.equal(again.at(t0), null, 'older than kept');
  assert.equal(again.at(t0 + 4 * HALF).out, 6);
});

test('how far apart the points are: every 5 minutes for a day, up to a day for a year', () => {
  assert.equal(stepFor(6 * H), 5 * 60000);
  assert.equal(stepFor(24 * H), 5 * 60000);
  assert.equal(stepFor(3 * D), 15 * 60000);
  assert.equal(stepFor(7 * D), HALF);
  assert.equal(stepFor(14 * D), H);
  assert.equal(stepFor(30 * D), 3 * H);
  assert.equal(stepFor(90 * D), 6 * H);
  assert.equal(stepFor(365 * D), D);
  // a day starts at local midnight, in summer time too
  assert.equal(new Date(bucketOf(Date.UTC(2026, 6, 1, 12), D, 'Europe/London')).toISOString(), '2026-06-30T23:00:00.000Z');
  assert.equal(new Date(bucketOf(Date.UTC(2026, 10, 1, 12), D, 'Europe/London')).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(new Date(bucketOf(Date.UTC(2026, 6, 1, 14, 20), 3 * H, 'Europe/London')).toISOString(), '2026-07-01T14:00:00.000Z', '15:00 local');
});

test('a week from the half-hourly figures: averaged into points, heat-ups from the minutes heated', async () => {
  const log = new LongLog(null);
  const now = Date.UTC(2026, 10, 15, 8, 0);
  // each evening 17:00–19:00 heated, at 20°; the rest of the day 16°
  for (let t = now - 8 * D; t < now; t += HALF) {
    const h = new Date(t).getUTCHours();
    const on = h >= 17 && h < 19;
    log.put(t, { rooms: { bed: { t: on ? 20 : 16, g: on ? 20 : 16, h: on ? 30 : 0 } }, out: 6, boil: on ? 30 : 0 });
  }
  const eng = engineWith(log);
  const d = await buildHistory(eng, { from: now - 7 * D, to: now, now });
  assert.equal(d.source, 'log');
  assert.equal(d.step, HALF);
  assert.equal(d.times.length, 7 * 48 + 1);
  const bed = d.rooms[0];
  assert.equal(bed.calls.length, 7, 'one heat-up each evening');
  assert.deepEqual(bed.calls.map(([a, b]) => [new Date(a).getUTCHours(), (b - a) / H]), Array(7).fill([17, 2]));
  assert.equal(bed.heatedMinutes, 7 * 120);
  assert.equal(d.boilerMinutes, 7 * 120);
  assert.ok(bed.temps.filter((v) => v === 20).length >= 7 * 4);
  // a month: every 3 hours, averaged (17:00–19:00 is two thirds of the 3-hour point from 15:00 GMT)
  // 9 days asked for, 8 kept: from where they start, every half hour again
  const m = await buildHistory(eng, { from: now - 9 * D, to: now, now: now + 1 });
  assert.equal(m.step, HALF);
  assert.equal(m.from, now - 8 * D);
  // a month, with only 8 days kept and no daily figures before: those 8 days
  const month = await buildHistory(eng, { from: now - 30 * D, to: now, now });
  assert.equal(month.from, now - 8 * D);
  assert.equal(month.asked, now - 30 * D);
  assert.equal(month.rooms[0].heatedMinutes, 8 * 120, 'only what was kept');
  assert.equal(month.detailFrom, now - 8 * D);
  // two weeks of them: every hour, each point the average of its half hours
  for (let t = now - 20 * D; t < now - 8 * D; t += HALF) log.put(t, { rooms: { bed: { t: new Date(t).getUTCMinutes() ? 20 : 16, g: 18, h: 0 } }, out: 6, boil: 0 });
  const fortnight = await buildHistory(eng, { from: now - 20 * D, to: now - 8 * D, now });
  assert.equal(fortnight.step, H);
  assert.ok(fortnight.rooms[0].temps.slice(0, -1).every((v) => v === 18), 'averaged'); // (the last: its first half hour)
});

test('before the half-hourly figures: the daily ones, for 90 days or more', async () => {
  const log = new LongLog(null);
  const now = Date.UTC(2026, 10, 15, 8, 0);
  log.put(now - 2 * D, { rooms: { bed: { t: 19, g: 19, h: 0 } }, out: 5, boil: 0 });
  const daily = {};
  for (let k = 3; k < 60; k++) {
    const day = new Date(now - k * D).toISOString().slice(0, 10);
    daily[day] = { boilerMin: 120, outSum: 7 * 1440, outN: 1440, rooms: { bed: { callMin: 90, tempSum: 18.5 * 1440, tempN: 1440 } } };
  }
  const d = await buildHistory(engineWith(log, { daily }), { from: now - 365 * D, to: now, now });
  assert.equal(d.step, D);
  const known = d.rooms[0].temps.filter((v) => v != null);
  assert.ok(known.length >= 55, String(known.length));
  assert.ok(known.slice(0, -1).every((v) => v === 18.5));
  assert.ok(d.dailyUntil > now - 4 * D && d.dailyUntil <= now - 2 * D);
  assert.equal(d.rooms[0].calls.length, 57, 'a day\'s heating each day');
  assert.ok(Math.abs(d.rooms[0].heatedMinutes - 57 * 90) < 1);
  // a week isn't drawn from daily figures
  const w = await buildHistory(engineWith(log, { daily }), { from: now - 7 * D, to: now, now });
  assert.equal(w.rooms[0].temps.filter((v) => v != null).length, 1);
});

test('heat-ups as they happened, while the app still has them', async () => {
  const log = new LongLog(null);
  const now = Date.UTC(2026, 10, 15, 8, 0);
  for (let t = now - 8 * D; t < now; t += HALF) log.put(t, { rooms: { bed: { t: 18, g: 18, h: 30 } }, out: 6, boil: 30 });
  const exact = [[now - 2 * D, now - 2 * D + 40 * 60000, 'schedule', 20]];
  const callLog = { started: now - 30 * D, keepDays: () => 3, intervals: (id, a, b) => exact.filter(([x, y]) => y > a && x < b) };
  const d = await buildHistory(engineWith(log, { calls: callLog }), { from: now - 7 * D, to: now, now });
  const calls = d.rooms[0].calls;
  // from the minutes heated before 3 days ago (all of it here), as they happened since
  assert.ok(calls.some(([a, b, why]) => why === 'schedule' && b - a === 40 * 60000));
  assert.ok(calls.filter(([, , why]) => !why).every(([, b]) => b <= now - 3 * D + HALF));
});

test('before the half-hourly figures start: two weeks or more in days, a shorter range starts where they do', async () => {
  const log = new LongLog(null);
  const now = Date.UTC(2026, 10, 15, 8, 0);
  for (let t = now - 3 * D; t < now; t += HALF) log.put(t, { rooms: { bed: { t: 19, g: 19, h: 5 } }, out: 6, boil: 5 });
  const daily = {};
  for (let k = 3; k < 40; k++) daily[new Date(now - k * D).toISOString().slice(0, 10)] = { boilerMin: 60, outSum: 0, outN: 0, rooms: { bed: { callMin: 60, tempSum: 18 * 1440, tempN: 1440 } } };
  const month = await buildHistory(engineWith(log, { daily }), { from: now - 30 * D, to: now, now });
  assert.equal(month.step, D, 'a month in days');
  assert.equal(month.rooms[0].temps.filter((v) => v != null).length, 31);
  const week = await buildHistory(engineWith(log, { daily }), { from: now - 7 * D, to: now, now });
  assert.equal(week.step, HALF);
  assert.ok(week.from >= now - 3 * D - HALF && week.asked === now - 7 * D, 'starts where the half hours do');
});

test('nothing kept yet (the first minute after installing), only daily figures: no error', async () => {
  const log = new LongLog(null);
  const now = Date.UTC(2026, 10, 15, 8, 0);
  const daily = { '2026-11-14': { boilerMin: 60, outSum: 0, outN: 0, rooms: { bed: { callMin: 60, tempSum: 18 * 1440, tempN: 1440 } } } };
  const week = await buildHistory(engineWith(log, { daily }), { from: now - 7 * D, to: now, now });
  assert.equal(week.step, HALF);
  assert.ok(week.rooms[0].temps.every((v) => v == null));
  const month = await buildHistory(engineWith(log, { daily }), { from: now - 30 * D, to: now, now });
  assert.equal(month.step, D);
  assert.ok(month.rooms[0].temps.some((v) => v === 18));
});
