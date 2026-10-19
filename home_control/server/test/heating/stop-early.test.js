// Stopping early, and when a room heats again: it only waits while it's still warming from its own
// leftover heat; a room that's cooling (or hasn't heated) starts at the usual gap below its target.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from '../../src/heating/engine.js';
import { Store } from '../../src/heating/store.js';
import { PredictionLog } from '../../src/heating/predictions.js';

const M = 60000;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const flat = (temp) => Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp }]]));

class StubHa extends EventEmitter {
  constructor(states) {
    super();
    this.states = new Map(Object.entries(states).map(([id, s]) => [id, { entity_id: id, ...s }]));
    this.timeZone = 'UTC';
    this.connected = false;
  }
  get(id) { return this.states.get(id); }
  set(id, state) { this.states.set(id, { ...this.states.get(id), ...state }); }
  callService() { return Promise.resolve(); }
  childLockFor() { return null; }
  companionFor() { return null; }
}

/** One room ("Heidi & Annie Room") at `temp`, 19° all day, with a learned stop-early margin. */
function room(temp, margin, { target = 19 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-stop-'));
  const ha = new StubHa({
    'weather.home': { state: 'cloudy', attributes: { temperature: 8 } },
    'sensor.ha': { state: String(temp), attributes: { device_class: 'temperature' } },
    'climate.ha': { state: 'heat', attributes: { current_temperature: temp, temperature: target } },
  });
  const store = new Store(dir);
  store.data.zones = [{ id: 'ha', name: 'Heidi & Annie Room', enabled: true, trvs: ['climate.ha'], sensor: 'sensor.ha', schedule: flat(target), stopEarlyMode: 'auto' }];
  store.data.runtime.learnRules = 2;
  if (margin != null) store.data.runtime.learn = { ha: { margin, cycles: 5, history: [] } };
  const engine = new Engine(ha, store, () => {});
  engine.predictionLog = new PredictionLog(null);
  engine.model = { at: 1, houseK: 0.05, k: { ha: 0.05 } };
  engine.calling.set('ha', false); // seen before, not heating
  const at = async (temp, minutes = 0) => {
    if (minutes) mock.timers.tick(minutes * M);
    if (temp != null) ha.set('sensor.ha', { state: String(temp) });
    await engine.tick();
    return engine.views[0];
  };
  const notes = () => store.log.map((l) => l.msg);
  return { engine, store, at, notes };
}

test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 7, 9, 0) }));
test.afterEach(() => mock.timers.reset());

test('18.6° for 19°, learned to stop 1.5° early, not heated today: it heats now, and stops at 18.8°', async () => {
  const { at, notes } = room(18.6, 1.5);
  const v = await at();
  assert.equal(v.calling, true, 'below the usual start point (18.7°), so it heats');
  assert.equal(v.startAt, 18.7);
  assert.equal(v.coasting, false);
  assert.equal(v.stopMargin, 0.2, 'a top-up: stops 0.2° early, not 1.5°');
  assert.equal(v.stopAt, 18.8);
  assert.equal((await at(18.7, 10)).calling, true);
  const s = await at(18.8, 10);
  assert.equal(s.calling, false);
  assert.ok(notes().some((m) => /^Heidi & Annie Room: warm enough at 18\.8°, stopping 0\.2° early/.test(m)), notes().slice(0, 3).join('\n'));
});

test('above the usual start point, not heating: it heats again below 18.7°, not 17.3°', async () => {
  const { at } = room(18.8, 1.5);
  const v = await at();
  assert.equal(v.calling, false);
  assert.equal(v.waiting, true);
  assert.equal(v.coasting, false);
  assert.equal(v.startAt, 18.7);
  assert.equal((await at(18.6, 30)).calling, true);
});

test('a heat-up from cold stops the full 1.5° early, waits while leftover heat lifts it, and heats again as soon as it falls', async () => {
  const { at, engine, notes } = room(15, 1.5);
  let v = await at();
  assert.equal(v.calling, true);
  assert.equal(v.stopMargin, 1.5);
  assert.equal(v.stopAt, 17.5);
  v = await at(17.5, 90);
  assert.equal(v.calling, false, 'stopped 1.5° early');
  // rising on leftover heat: not heating, though well under 18.7°
  v = await at(17.6, 5);
  assert.equal(v.calling, false);
  assert.equal(v.coasting, true);
  assert.equal(v.stopAt, 17.5, 'where it stopped');
  v = await at(17.8, 5);
  assert.equal(v.coasting, true);
  // it's turned: no more leftover heat, so it heats again straight away
  v = await at(17.7, 5);
  assert.equal(v.coasting, false);
  assert.equal(v.calling, true);
  assert.equal(v.stopMargin, 0.65, 'a smaller heat-up from 17.7°: half the way to 19°');
  // and it learned it fell short: stops less early next time
  assert.equal(engine.rt.learn.ha.margin, 1.2);
  assert.ok(notes().some((m) => /stopped 1\.2° short, now stops 1\.2° early/.test(m)));
});

test('stopped early and not rising at all: it heats again after 20 minutes', async () => {
  const { at, engine } = room(15, 1.5);
  await at();
  await at(17.5, 90);
  assert.equal((await at(17.5, 10)).coasting, true);
  assert.equal((await at(17.5, 9)).calling, false);
  const v = await at(17.5, 2);
  assert.equal(v.coasting, false);
  assert.equal(v.calling, true);
  assert.equal(engine.rt.coast.ha.discard, undefined, 'a fair test: learned from');
  assert.equal(engine.rt.learn.ha.margin, 1.2);
});

test('a shower after the heat went off isn\'t leftover heat: not learned from', async () => {
  const { at, engine } = room(17, 0.5);
  await at();
  let v = await at(18.5, 60);
  assert.equal(v.calling, false, 'stopped 0.5° early');
  await at(19.5, 10);
  await at(21, 10); // a shower
  await at(20.7, 15);
  assert.match(engine.rt.coast.ha.discard, /rose more after the heat went off than while heating/);
  assert.equal(engine.rt.learn.ha.margin, 0.5, 'unchanged');
});

test('warming faster after the heat went off than while heating isn\'t leftover heat either', async () => {
  const { at, engine } = room(18, 0.5);
  await at();
  assert.equal((await at(18.5, 60)).calling, false); // 0.5° in an hour
  await at(18.9, 10); // then 0.4° in 10 minutes
  await at(18.6, 15);
  assert.match(engine.rt.coast.ha.discard, /warmed faster after the heat went off/);
  assert.equal(engine.rt.learn.ha.margin, 0.5);
});

test('a genuine overshoot after a long heat-up teaches it to stop earlier', async () => {
  const { at, engine } = room(15, 0);
  await at();
  assert.equal((await at(19, 120)).calling, false);
  await at(19.3, 10);
  await at(19.6, 15);
  await at(19.3, 15);
  assert.equal(engine.rt.coast.ha.discard, undefined);
  assert.equal(engine.rt.learn.ha.margin, 0.3);
});

test('a short top-up\'s overshoot doesn\'t make it stop earlier', async () => {
  const { at, engine } = room(18.6, 0.3);
  await at();
  assert.equal((await at(18.8, 15)).calling, false);
  await at(19.1, 30);
  await at(18.8, 15);
  assert.equal(engine.rt.coast.ha.discard, undefined);
  assert.equal(engine.rt.learn.ha.margin, 0.3, 'unchanged');
  assert.equal(engine.rt.learn.ha.history.at(-1).peak, 19.1);
});

test('margins learned under the old rules are forgotten once, with a note', () => {
  const { engine, store, notes } = room(18, 1.5);
  store.data.runtime.learnRules = undefined;
  store.data.runtime.learn = { ha: { margin: 1.5, cycles: 9, history: [] }, gone: { margin: 1 } };
  engine.forgetOldLearning();
  assert.deepEqual(store.data.runtime.learn, {});
  assert.equal(store.data.runtime.learnRules, 2);
  assert.match(notes()[0], /^Stop early: forgot what was learned \(Heidi & Annie Room \(1\.5°\)\)/);
  store.data.runtime.learn = { ha: { margin: 0.4 } };
  engine.forgetOldLearning();
  assert.equal(store.data.runtime.learn.ha.margin, 0.4, 'only once');
});
