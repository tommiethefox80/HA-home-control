// The room status shown on the dashboard card, including when a room below its target heats again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomStatus, nextText, nextWhy, boilerNextState } from '../../src/publish.js';

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

// when a room next needs heat (the app's prediction), for the dashboard card and sensor.home_boiler_next
const soon = () => { const d = new Date(); d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 5), 0, 0); return d.getTime(); };
const hhmm = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

test('next heat: when, and why, for each kind of prediction', () => {
  const at = soon();
  const cooling = room({ next: { at, reason: 'cooling', threshold: 18.7 } });
  assert.equal(nextText(cooling, tz), `Next heat about ${hhmm(at)}`);
  assert.equal(nextWhy(cooling), 'as it cools to 18.7°');
  const pre = room({ next: { at, reason: 'preheat', target: 20, readyBy: '06:30' } });
  assert.equal(nextWhy(pre), 'to be 20° by 06:30');
  assert.equal(nextText(room({ next: { at, reason: 'schedule', target: 20 } }), tz), `Next heat ${hhmm(at)}`);
  const heating = room({ calling: true, stopAt: 18.7, next: { heating: true, until: at, warm: true } });
  assert.equal(nextText(heating, tz), `Heating until about ${hhmm(at)}`);
  assert.equal(nextWhy(heating), 'when it reaches 18.7°');
  assert.equal(nextWhy({ ...heating, next: { ...heating.next, warm: false } }), 'when its target drops');
  assert.equal(nextText(room({ next: { withOthers: true } }), tz), 'Warming with the other rooms');
  assert.equal(nextText(room({ next: { at: null } }), tz), null);
  assert.equal(nextText(room({ enabled: false, next: { at, reason: 'cooling' } }), tz), null);
});

test('sensor.home_boiler_next: a timestamp while the boiler rests, unknown while it runs', () => {
  const at = soon();
  const zones = [{ ...room({ next: { at, reason: 'cooling', threshold: 18.7 } }), name: 'Bathroom' }];
  const off = boilerNextState({ boiler: { on: false, next: { at, rooms: ['Bathroom'] } }, zones });
  assert.equal(off.state, new Date(at).toISOString());
  assert.equal(off.attributes.device_class, 'timestamp');
  assert.deepEqual(off.attributes.rooms, ['Bathroom']);
  assert.equal(off.attributes.reason, 'as it cools to 18.7°');
  const on = boilerNextState({ boiler: { on: true, until: at, next: null }, zones });
  assert.equal(on.state, 'unknown');
  assert.equal(on.attributes.on_until, new Date(at).toISOString());
});
