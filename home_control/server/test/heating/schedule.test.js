import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledAt, localWeekPosition, normaliseSchedule, defaultSchedule } from '../../src/heating/schedule.js';

const sched = defaultSchedule(); // weekdays 06:30 20, 08:30 16, 16:30 20.5, 22:30 15; weekends 07:30 20, 23:00 15

test('mid-morning weekday is setback', () => {
  const r = scheduledAt(sched, { dayIndex: 1, minutes: 10 * 60 });
  assert.equal(r.temp, 16);
  assert.equal(r.next.temp, 20.5);
  assert.equal(r.next.inMinutes, 6.5 * 60);
});

test('before first point uses previous day last point', () => {
  const r = scheduledAt(sched, { dayIndex: 2, minutes: 3 * 60 });
  assert.equal(r.temp, 15);
  assert.equal(r.next.time, '06:30');
});

test('monday early morning wraps from sunday', () => {
  const r = scheduledAt(sched, { dayIndex: 0, minutes: 60 });
  assert.equal(r.temp, 15);
});

test('saturday afternoon', () => {
  const r = scheduledAt(sched, { dayIndex: 5, minutes: 15 * 60 });
  assert.equal(r.temp, 20);
  assert.equal(r.next.time, '23:00');
});

test('empty schedule returns null', () => {
  assert.equal(scheduledAt({}, { dayIndex: 0, minutes: 0 }), null);
});

test('next skips points with the same temperature', () => {
  const s = { mon: [{ time: '06:00', temp: 20 }, { time: '09:00', temp: 20 }, { time: '12:00', temp: 16 }] };
  const r = scheduledAt(s, { dayIndex: 0, minutes: 7 * 60 });
  assert.equal(r.next.time, '12:00');
});

test('normalise drops junk, rounds, sorts, dedupes', () => {
  const n = normaliseSchedule({ mon: [
    { time: '22:00', temp: 15.2 }, { time: '6:05', temp: 20 }, { time: '25:00', temp: 20 },
    { time: '07:00', temp: 99 }, { time: '22:00', temp: 16 }, { time: 'x', temp: 1 },
  ] });
  assert.deepEqual(n.mon, [{ time: '06:05', temp: 20 }, { time: '22:00', temp: 16 }]);
  assert.deepEqual(n.sun, []);
});

test('local week position respects time zone (BST)', () => {
  // 2026-10-09 is a Friday; 09:26 UTC = 10:26 BST
  const p = localWeekPosition(new Date('2026-10-09T09:26:00Z'), 'Europe/London');
  assert.deepEqual(p, { dayIndex: 4, minutes: 10 * 60 + 26 });
});

test('local week position after clocks go back (GMT)', () => {
  const p = localWeekPosition(new Date('2026-11-02T09:00:00Z'), 'Europe/London');
  assert.deepEqual(p, { dayIndex: 0, minutes: 9 * 60 });
});
