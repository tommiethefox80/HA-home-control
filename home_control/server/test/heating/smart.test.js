// Stop early before a drop, fire rooms together, checking the predictions, and heat-loss alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from '../../src/heating/engine.js';
import { Store } from '../../src/heating/store.js';
import { PredictionLog } from '../../src/heating/predictions.js';
import { HeatLossWatch } from '../../src/heating/heatloss.js';

const M = 60000;
const H = 3600000;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

class StubHa extends EventEmitter {
  constructor(states) {
    super();
    this.states = new Map(Object.entries(states).map(([id, s]) => [id, { entity_id: id, ...s }]));
    this.timeZone = 'UTC';
    this.connected = false; // nothing is sent anywhere
  }
  get(id) { return this.states.get(id); }
  set(id, state) { this.states.set(id, { ...this.states.get(id), ...state }); }
  callService() { return Promise.resolve(); }
  childLockFor() { return null; }
  companionFor() { return null; }
}

function house(rooms, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-smart-'));
  const states = { 'weather.home': { state: 'cloudy', attributes: { temperature: 5 } } };
  for (const r of rooms) {
    states[`sensor.${r.id}`] = { state: String(r.temp), attributes: { device_class: 'temperature' } };
    states[`climate.${r.id}`] = { state: 'heat', attributes: { current_temperature: r.temp, temperature: 20 } };
  }
  const ha = new StubHa(states);
  const store = new Store(dir);
  Object.assign(store.data.settings, settings);
  store.data.zones = rooms.map((r) => ({ id: r.id, name: r.name, enabled: true, trvs: [`climate.${r.id}`], sensor: `sensor.${r.id}`, schedule: r.schedule, stopEarlyMode: 'house' }));
  const engine = new Engine(ha, store, () => {});
  engine.predictionLog = new PredictionLog(null);
  engine.model = { at: 1, houseK: 0.1, k: Object.fromEntries(rooms.map((r) => [r.id, r.k ?? 0.1])) };
  return { engine, ha, store };
}
// the same temperature all week
const flat = (temp) => Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp }]]));
// `high` until `dropAt`, then `low` (every day, UTC)
function dropping(high, low, dropAt) {
  const t = hhmm(dropAt);
  return Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp: high }, { time: t, temp: low }]]));
}

test('stop early before a drop: as early as the room can go and lose no more than half a degree', () => {
  const now = Math.floor(Date.now() / (5 * M)) * 5 * M + 7 * H; // a clean time later today
  const day = new Date(now).getUTCDate();
  if (new Date(now + 2 * H).getUTCDate() !== day) return; // too near midnight (UTC) to set this up simply
  const dropAt = now + 30 * M;
  const { engine } = house([{ id: 'lounge', name: 'Lounge', temp: 20, schedule: dropping(20, 16, dropAt) }], { easeOff: { enabled: true, drop: 0.5, maxMinutes: 60 } });
  const zone = engine.zones[0];
  // 20° in a 5° outside, losing 10% of the gap an hour: half a degree takes ln(15/14.5)/0.1 h, 20 min
  assert.equal(engine.easeOffMinutes(zone, 20), 20);
  assert.equal(engine.targetFor(zone, dropAt - 25 * M).source, 'schedule');
  const t = engine.targetFor(zone, dropAt - 20 * M);
  assert.equal(t.source, 'ease-off');
  assert.equal(t.temp, 16);
  // off: no easing
  engine.s.easeOff.enabled = false;
  assert.equal(engine.targetFor(zone, dropAt - 5 * M).source, 'schedule');
  assert.equal(engine.easeOffMinutes(zone, 20, { always: true }), 20);
  // a room losing heat twice as fast eases off for half as long; and never more than the limit
  engine.s.easeOff.enabled = true;
  engine.model.k.lounge = 0.2;
  assert.equal(engine.easeOffMinutes(zone, 20), 10);
  engine.model.k.lounge = 0.01;
  assert.equal(engine.easeOffMinutes(zone, 20), 60);
});

test('fire rooms together: a room nearly due starts while the boiler is on for another', async () => {
  const { engine, ha } = house([
    { id: 'lounge', name: 'Lounge', temp: 17, schedule: flat(20) },      // well below: calling
    { id: 'bedroom', name: 'Bedroom', temp: 19.78, schedule: flat(20) }, // just above its start point (19.7): due in a few minutes
    { id: 'study', name: 'Study', temp: 20.5, schedule: flat(20) },      // above its stop point: nothing to gain
  ], { together: { enabled: false, minutes: 30 } });
  await engine.tick();
  const v = (id) => engine.views.find((x) => x.id === id);
  assert.equal(v('lounge').calling, true);
  assert.equal(v('bedroom').calling, false);
  assert.ok(v('bedroom').next.at - Date.now() < 30 * M, 'the bedroom is due soon');
  // turned on: the bedroom joins in, the study doesn't
  engine.s.together.enabled = true;
  await engine.tick();
  await engine.tick();
  assert.equal(v('bedroom').calling, true);
  assert.deepEqual(v('bedroom').joined.with, ['Lounge']);
  assert.equal(v('study').calling, false);
  // it carries on to its stop point (20°), then it's an ordinary room again
  ha.set('sensor.bedroom', { state: '20' });
  await engine.tick();
  assert.equal(v('bedroom').calling, false);
  assert.equal(v('bedroom').joined, null);
  assert.equal(engine.joined.bedroom, undefined);
});

test('fire rooms together: not when nothing else is heating, and not when it\'s off', async () => {
  const { engine } = house([{ id: 'bedroom', name: 'Bedroom', temp: 19.78, schedule: flat(20) }], { together: { enabled: true, minutes: 30 } });
  await engine.tick();
  await engine.tick();
  assert.equal(engine.views[0].calling, false);
});

test('predictions: scored against when the room really started, and the cooling rate corrected', () => {
  const log = new PredictionLog(null);
  const t0 = Date.UTC(2026, 9, 16, 20, 0);
  // an hour ahead: at 21:00, from 20° with 5° outside, falling to 19.7° (k 0.1 says ~12 min... here 60)
  const k = Math.log(15 / 14.7) / 1; // the rate that gets there in exactly an hour
  log.note('a', t0, { at: t0 + 60 * M, reason: 'cooling', threshold: 19.7, k }, { current: 20, outside: 5 });
  log.note('a', t0 + 45 * M, { at: t0 + 60 * M, reason: 'cooling', threshold: 19.7, k }, { current: 19.8, outside: 5 });
  assert.equal(log.pending.length, 2);
  // it really started at 21:20: 20 minutes later than predicted, so it cools slower than measured
  log.started('a', t0 + 80 * M, { source: 'schedule' });
  const s = log.summary([{ id: 'a', name: 'A' }], { now: t0 + 2 * H });
  assert.equal(s.rooms[0].h60.samples, 1);
  assert.equal(s.rooms[0].h60.typical, 20);
  assert.equal(s.rooms[0].m15.typical, 20);
  assert.equal(log.ratios.a.length, 1);
  assert.ok(Math.abs(log.ratios.a[0] - 60 / 80) < 0.01);
  assert.equal(log.scaleFor('a'), 1, 'not until three');
  for (let i = 1; i <= 3; i++) {
    const t = t0 + i * 24 * H;
    log.note('a', t, { at: t + 60 * M, reason: 'cooling', threshold: 19.7, k }, { current: 20, outside: 5 });
    log.started('a', t + 80 * M, { source: 'schedule' });
  }
  assert.ok(Math.abs(log.scaleFor('a') - 0.75) < 0.01);
});

test('predictions: didn\'t happen, not foreseen, and starts that aren\'t a fair test', () => {
  const log = new PredictionLog(null);
  const t0 = Date.UTC(2026, 9, 16, 20, 0);
  log.note('a', t0, { at: t0 + 60 * M, reason: 'cooling', threshold: 19.7, k: 0.1 }, { current: 20, outside: 5 });
  log.sweep(t0 + 4 * H, [{ id: 'a', enabled: true, source: 'schedule' }]);
  // a boost isn't the prediction's fault
  log.note('b', t0, { at: t0 + 60 * M, reason: 'cooling', threshold: 19.7, k: 0.1 }, { current: 20, outside: 5 });
  log.started('b', t0 + 30 * M, { source: 'boost' });
  // watched for over an hour with nothing due, then it heats: not foreseen
  for (let m = 0; m <= 80; m += 5) log.note('c', t0 + m * M, { at: null }, {});
  log.started('c', t0 + 81 * M, { source: 'schedule' });
  const s = log.summary([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { now: t0 + 5 * H });
  assert.equal(s.rooms[0].h60.didntHappen, 1);
  assert.equal(s.rooms[1].h60.samples + s.rooms[1].h60.didntHappen, 0);
  assert.equal(s.rooms[2].h60.notForeseen, 1);
});

test('heat-loss alerts: two days well above its usual month, told once', () => {
  const w = new HeatLossWatch(null);
  const now = Date.UTC(2026, 9, 16, 12, 0);
  const day = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
  const daily = [];
  for (let n = 2; n <= 12; n++) daily.push({ day: day(n), k: 0.09 + (n % 3) * 0.002, n: 3 });
  w.update({ rooms: [{ id: 'bed', daily }, { id: 'lounge', daily }] }, now);
  w.update({ rooms: [{ id: 'bed', daily: [{ day: day(1), k: 0.14, n: 2 }, { day: day(0), k: 0.13, n: 1 }] }, { id: 'lounge', daily: [{ day: day(1), k: 0.095, n: 3 }] }] }, now);
  const r = w.check(['bed', 'lounge'], { percent: 40, now, tz: 'UTC' });
  assert.deepEqual(r.alerts.map((a) => a.id), ['bed']);
  assert.ok(r.alerts[0].percent >= 40 && r.alerts[0].percent < 60, String(r.alerts[0].percent));
  assert.deepEqual(w.elevated().map((e) => e.id), ['bed']);
  assert.equal(w.view('lounge').elevated, false);
  // not told again the same day; back to normal is noticed
  assert.equal(w.check(['bed'], { percent: 40, now: now + H, tz: 'UTC' }).alerts.length, 0);
  w.update({ rooms: [{ id: 'bed', daily: [{ day: day(1), k: 0.09, n: 2 }, { day: day(0), k: 0.091, n: 2 }] }] }, now);
  assert.deepEqual(w.check(['bed'], { percent: 40, now: now + 2 * H, tz: 'UTC' }).normal, ['bed']);
  // too little to go on: no alert
  const fresh = new HeatLossWatch(null);
  fresh.update({ rooms: [{ id: 'x', daily: [{ day: day(5), k: 0.1, n: 2 }, { day: day(0), k: 0.3, n: 3 }] }] }, now);
  assert.equal(fresh.check(['x'], { now, tz: 'UTC' }).alerts.length, 0);
});
