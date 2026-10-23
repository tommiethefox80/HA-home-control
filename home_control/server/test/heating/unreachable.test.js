// While the boiler can't be reached (Hive down), calling for heat isn't heating: not counted, not
// learned from, the boiler not switched; and the time counted before this was known is taken out.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from '../../src/heating/engine.js';
import { Store } from '../../src/heating/store.js';
import { PredictionLog } from '../../src/heating/predictions.js';
import { DailyLog, localDate } from '../../src/heating/insights.js';
import { CallLog } from '../../src/heating/history.js';
import { clip, overlapByDay, repairUnreachable } from '../../src/heating/repair.js';

const M = 60000; const H = 3600000;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const flat = (temp) => Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp }]]));

class StubHa extends EventEmitter {
  constructor(states) {
    super();
    this.states = new Map(Object.entries(states).map(([id, s]) => [id, { entity_id: id, ...s }]));
    this.timeZone = 'Europe/London';
    this.connected = false;
    this.calls = [];
    this.history = [];
  }
  get(id) { return this.states.get(id); }
  set(id, state) { this.states.set(id, { ...this.states.get(id), ...state }); }
  callService(domain, service, data) { this.calls.push({ domain, service, data }); return Promise.resolve(); }
  send({ type, entity_ids }) { if (type === 'history/history_during_period') return Promise.resolve({ [entity_ids[0]]: this.history }); return Promise.reject(new Error('no')); }
  childLockFor() { return null; }
  companionFor() { return null; }
  entityInfo() { return null; }
}

function house() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-unreach-'));
  const ha = new StubHa({
    'weather.home': { state: 'cloudy', attributes: { temperature: 8 } },
    'sensor.bed': { state: '16', attributes: { device_class: 'temperature' } },
    'climate.bed': { state: 'heat', attributes: { current_temperature: 16, temperature: 20 } },
    'climate.heating': { state: 'heat', attributes: { current_temperature: 19, temperature: 7, hvac_action: 'idle', hvac_modes: ['heat', 'off'] } },
  });
  const store = new Store(dir);
  store.data.settings.boiler = { ...store.data.settings.boiler, entity: 'climate.heating', onTemp: 30, offTemp: 7, minOnMinutes: 0, minOffMinutes: 0 };
  store.data.zones = [{ id: 'bed', name: 'Bedroom', enabled: true, trvs: ['climate.bed'], sensor: 'sensor.bed', schedule: flat(20), stopEarlyMode: 'house' }];
  store.data.runtime.learnRules = 2;
  const engine = new Engine(ha, store, () => {});
  engine.predictionLog = new PredictionLog(null);
  engine.model = { at: 1, houseK: 0.05, k: { bed: 0.05 } };
  engine.dailyLog = new DailyLog(dir);
  engine.callLog = new CallLog(dir);
  engine.calling.set('bed', false);
  made.push({ engine, store });
  return { engine, ha, store };
}

const made = [];
test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23, 17, 0) }));
test.afterEach(() => {
  mock.timers.reset();
  // the logs' and the engine's save and tick timers: so the test can finish straight away
  for (const { engine, store } of made.splice(0)) {
    for (const t of [engine.tickTimer, engine.dailyLog?.timer, engine.callLog?.timer, store.logTimer, store.saveTimer, store.timer]) clearTimeout(t);
  }
});

test('the boiler unreachable: the room wants heat but isn\'t heating; nothing switched, counted or learned', async () => {
  const { engine, ha, store } = house();
  ha.connected = true;
  // heating normally first
  await engine.tick();
  let v = engine.views[0];
  assert.equal(v.calling, true);
  assert.equal(v.heating, true);
  assert.equal(engine.boilerView().on, true);
  ha.set('climate.heating', { attributes: { ...ha.get('climate.heating').attributes, hvac_action: 'heating' } });
  mock.timers.tick(2 * M);
  await engine.tick();
  assert.ok(engine.dailyLog.days[localDate(Date.now(), 'Europe/London')].boilerMin > 1.9, 'the boiler reported firing: counted');
  // Hive goes down
  for (const id of ['climate.heating', 'climate.bed']) ha.set(id, { state: 'unavailable', attributes: {} });
  const notes = store.log.length;
  const day = engine.dailyLog.days[localDate(Date.now(), 'Europe/London')];
  const before = { boiler: day.boilerMin, room: day.rooms.bed.callMin };
  for (let i = 0; i < 30; i++) { mock.timers.tick(2 * M); await engine.tick(); }
  v = engine.views[0];
  assert.equal(v.calling, true, 'it still wants heat');
  assert.equal(v.heating, false);
  assert.equal(v.blocked, true);
  assert.equal(engine.boilerView().on, false, 'not shown as running');
  assert.equal(engine.boilerView().reachable, false);
  assert.ok(day.boilerMin - before.boiler < 0.01, 'boiler time not counted while it can\'t be reached');
  assert.ok(day.rooms.bed.callMin - before.room < 0.01, 'room time not counted either');
  const iv = engine.callLog.zones.bed;
  assert.notEqual(iv[iv.length - 1][1], null, 'its heat-up record closed when it couldn\'t heat');
  assert.equal(engine.heatSess.bed, undefined, 'the cut-short heat-up isn\'t learned from');
  assert.equal(store.log.slice(0, store.log.length - notes).some((l) => /Boiler (ON|OFF)/.test(l.msg)), false, 'no boiler switching while it can\'t be reached');
  // the room's own "stuck" check doesn't fire either (it isn't heating)
  assert.equal(engine.attention.some((a) => a.key.startsWith('stuck-')), false);
  // back: heating again, counted again
  ha.set('climate.heating', { state: 'heat', attributes: { current_temperature: 19, temperature: 30, hvac_action: 'heating', hvac_modes: ['heat', 'off'] } });
  ha.set('climate.bed', { state: 'heat', attributes: { current_temperature: 16, temperature: 20 } });
  mock.timers.tick(2 * M); await engine.tick();
  mock.timers.tick(2 * M); await engine.tick();
  assert.equal(engine.views[0].heating, true);
  assert.ok(day.boilerMin - before.boiler > 1.9);
  assert.equal(engine.callLog.zones.bed.at(-1)[1], null, 'a new heat-up record');
});

test('a blip (Home Assistant restarting) isn\'t an outage: the heat-up carries on', async () => {
  const { engine, ha } = house();
  ha.connected = true;
  await engine.tick();
  assert.equal(engine.views[0].heating, true);
  const iso = () => new Date(Date.now()).toISOString();
  for (const id of ['climate.heating', 'climate.bed']) ha.set(id, { state: 'unavailable', attributes: {}, last_changed: iso() });
  mock.timers.tick(2 * M); await engine.tick();
  assert.equal(engine.views[0].heating, true, 'still heating two minutes in');
  assert.equal(engine.boilerView().reachable, true);
  assert.notEqual(engine.heatSess.bed, undefined, 'still learning from the heat-up');
  assert.equal(engine.callLog.zones.bed.at(-1)[1], null);
  mock.timers.tick(2 * M); await engine.tick();
  assert.equal(engine.views[0].heating, false, 'an outage after three minutes');
  assert.equal(engine.boilerView().reachable, false);
});

test('clipping heat-ups and minutes by day', () => {
  const t0 = Date.UTC(2026, 9, 23, 17, 0);
  assert.deepEqual(clip([[t0, t0 + 3 * H, 'schedule', 20]], [[t0 + H, t0 + 2 * H]]), [[t0, t0 + H, 'schedule', 20], [t0 + 2 * H, t0 + 3 * H, 'schedule', 20]]);
  assert.deepEqual(clip([[t0, t0 + H]], [[t0 - H, t0 + 2 * H]]), []);
  // 22:30 to 01:30 London (BST): 90 min that day and 90 the next
  const a = Date.UTC(2026, 9, 23, 21, 30); const b = Date.UTC(2026, 9, 24, 0, 30);
  assert.deepEqual(overlapByDay(a, b, [[a - H, b + H]], 'Europe/London'), { '2026-10-23': 90, '2026-10-24': 90 });
});

test('the time counted while the boiler couldn\'t be reached is taken back out, once', async () => {
  const { engine, ha, store } = house();
  ha.connected = true;
  const now = Date.now();
  const day = localDate(now, 'Europe/London');
  // the bedroom "heated" 15:00–18:00, but the boiler was unavailable 16:00–17:30
  engine.callLog.zones.bed = [[now - 3 * H, now, 'schedule', 20]];
  engine.dailyLog.days[day] = { boilerMin: 180, outSum: 0, outN: 0, rooms: { bed: { callMin: 180, tempSum: 0, tempN: 0 } } };
  const s = (t) => t / 1000;
  // (and a 2-minute blip at 15:30, Home Assistant restarting, which stays)
  ha.history = [{ s: 'heat', lu: s(now - 10 * 86400000) }, { s: 'unavailable', lu: s(now - 150 * M) }, { s: 'heat', lu: s(now - 148 * M) },
    { s: 'unavailable', lu: s(now - 2 * H - 3 * M) }, { s: 'heat', lu: s(now - 30 * M) }];
  const r = await repairUnreachable(engine, { now });
  assert.deepEqual(r, { minutes: 90, gaps: 1 });
  assert.equal(engine.dailyLog.days[day].rooms.bed.callMin, 90);
  assert.deepEqual(engine.callLog.zones.bed.map(([a, b]) => [(now - a) / M, b == null ? null : (now - b) / M]), [[180, 120], [30, 0]]);
  assert.equal(store.data.runtime.repairs.unreachable, 1);
  assert.equal(await repairUnreachable(engine, { now }), null, 'only once');
});
