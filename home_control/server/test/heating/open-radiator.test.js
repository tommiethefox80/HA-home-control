// A radiator that's always open (no TRV of its own) gets heat whenever the boiler runs for other rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heatedWithOthers } from '../../src/heating/history.js';

const M = 60000;
const day = Date.UTC(2026, 9, 16);
const at = (h, m = 0) => day + (h * 60 + m) * M;

test('runs it didn\'t call in count as times; the minutes are every part it didn\'t call in', () => {
  const runs = [[at(6), at(6, 30)], [at(9), at(9, 20)], [at(17), at(17, 40)]];
  const calls = [[at(17, 10), at(17, 30)]]; // it called for heat itself during the last run
  assert.deepEqual(heatedWithOthers(runs, calls, day, at(20)), { times: 2, minutes: 30 + 20 + 20 });
});

test('a run before midnight, or still going, only counts its part of today', () => {
  const runs = [[day - 30 * M, at(0, 15)], [at(19, 50), at(23)]];
  assert.deepEqual(heatedWithOthers(runs, [], day, at(20)), { times: 2, minutes: 15 + 10 });
});

test('runs it called in all the way through, or blips under a minute, don\'t count', () => {
  const runs = [[at(7), at(7, 30)], [at(8), at(8, 0) + 30000]];
  assert.deepEqual(heatedWithOthers(runs, [[at(6, 50), at(7, 40)]], day, at(20)), { times: 0, minutes: 0 });
});
