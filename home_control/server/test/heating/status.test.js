// The room status shown on the dashboard card, including when a room below its target heats again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomStatus } from '../../src/publish.js';

const tz = 'Europe/London';
const today = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date()).toLowerCase().slice(0, 3);
const room = (extra = {}) => ({ enabled: true, source: 'schedule', target: 19, current: 18.1, scheduled: { next: { temp: 15, time: '22:00', day: today } }, ...extra });

test('a room on schedule says what comes next', () => {
  assert.match(roomStatus(room(), tz), /^On schedule, 15° from 22:00$/);
});

test('below its target but not heating: says when it heats again, first', () => {
  const s = roomStatus(room({ waiting: true, startAt: 17.9 }), tz);
  assert.match(s, /^Heats again below 17\.9° · 15° from 22:00$/);
});

test('held or boosted rooms keep their own words, with the same note after', () => {
  const s = roomStatus(room({ source: 'hold', until: Date.now() + 3600000, waiting: true, startAt: 18.7 }), tz);
  assert.match(s, /^Held at 19° until .+ · heats again below 18\.7°$/);
});

test('not said for a room that is off, or not looked after here', () => {
  assert.doesNotMatch(roomStatus(room({ source: 'off', target: 7, waiting: false }), tz), /heats again/);
  assert.equal(roomStatus(room({ enabled: false, waiting: true, startAt: 17.9 }), tz), 'Not managed by this app');
});
