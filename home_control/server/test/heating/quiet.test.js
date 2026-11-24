// A room thermometer that's stopped reporting (a Zigbee sensor dropped off its network keeps its
// last reading in Home Assistant for hours): noticed, the room goes by its radiators (or off), and
// back to the thermometer as soon as it reports again.
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
const iso = (ms = Date.now()) => new Date(ms).toISOString();
// service calls go out one at a time, 400 ms apart (real time)
async function eventually(fn, ms = 8000) {
  const end = performance.now() + ms;
  while (!fn()) { if (performance.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); }
  return true;
}

class StubHa extends EventEmitter {
  constructor(states) {
    super();
    this.states = new Map(Object.entries(states).map(([id, s]) => [id, { entity_id: id, ...s }]));
    this.timeZone = 'UTC';
    this.connected = true;
    this.calls = [];
    this.rest = new Map(); // what the REST API says (last_reported)
  }
  get(id) { return this.states.get(id); }
  set(id, state) { this.states.set(id, { ...this.states.get(id), ...state }); }
  callService(domain, service, data) { this.calls.push({ domain, service, data }); return Promise.resolve(); }
  send() { return Promise.resolve({}); }
  childLockFor() { return null; }
  companionFor() { return null; }
  async fetchState(id) { return this.rest.get(id) || this.states.get(id) || null; }
}

/** Heidi & Annie Room, 19° all day, a thermometer and a TRV of its own. */
function room({ temp = 18.4, trv = 18.5, action, trvs = ['climate.ha'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-quiet-'));
  const ha = new StubHa({
    'weather.home': { state: 'cloudy', attributes: { temperature: 6 } },
    'sensor.ha': { state: String(temp), attributes: { device_class: 'temperature', friendly_name: 'Heidi And Annie\'s Temp Monitor' }, last_changed: iso(), last_updated: iso(), last_reported: iso() },
    'climate.ha': { state: 'heat', attributes: { current_temperature: trv, temperature: 19, friendly_name: 'H&A radiator' } },
  });
  const store = new Store(dir);
  store.data.zones = [{ id: 'ha', name: 'Heidi & Annie Room', enabled: true, trvs, sensor: 'sensor.ha', schedule: flat(19), stopEarlyMode: 'fixed', stopEarlyPct: 0 }];
  store.data.runtime.learnRules = 2;
  if (action) store.data.settings.quietSensor = { action, minutes: 90 };
  const engine = new Engine(ha, store, () => {});
  engine.predictionLog = new PredictionLog(null);
  engine.calling.set('ha', false);
  const at = async (minutes = 0, { trv: t, report } = {}) => {
    if (minutes) mock.timers.tick(minutes * M);
    if (t != null) ha.set('climate.ha', { attributes: { ...ha.get('climate.ha').attributes, current_temperature: t } });
    if (report != null) ha.set('sensor.ha', { state: String(report), last_changed: iso(), last_updated: iso(), last_reported: iso() });
    await engine.tick();
    await new Promise((r) => setImmediate(r)); // (a REST answer)
    return engine.views[0];
  };
  const notes = () => store.log.map((l) => l.msg);
  return { engine, store, ha, at, notes };
}

test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 7, 18, 53) }));
test.afterEach(() => mock.timers.reset());

test('heating, the radiator warming, and nothing from the thermometer for half an hour: the room goes by its radiator', async () => {
  const { at, notes, engine, ha } = room();
  let v = await at();
  assert.equal(v.calling, true, '18.4° for 19°');
  assert.equal(v.current, 18.4);
  // the radiator warms; the thermometer says nothing (stuck at 18.4°)
  v = await at(10, { trv: 19.5 });
  v = await at(10, { trv: 20.5 });
  assert.equal(v.thermometer.quiet, null, 'only 20 minutes');
  v = await at(11, { trv: 21.2 });
  assert.equal(v.thermometer.quiet?.reason, 'heating');
  assert.equal(v.thermometer.quiet.action, 'trvs');
  assert.equal(v.current, 21.2, 'the radiator\'s own reading');
  assert.equal(v.calling, false, 'warm enough by the radiator');
  assert.ok(notes().some((m) => /^Heidi & Annie Room: Heidi And Annie's Temp Monitor hasn't reported since 18:53, though the room's been heating for 31 min and its radiators have warmed, so it's going by its radiators' own readings until it does/.test(m)), notes().join('\n'));
  assert.ok(engine.attention.some((a) => a.key === 'quiet-ha' && /hasn't reported since/.test(a.text)));
  assert.ok(v.warnings.some((w) => /hasn't reported/.test(w)));
  assert.ok(await eventually(() => ha.calls.some((c) => c.domain === 'persistent_notification' && c.service === 'create' && c.data.notification_id === 'home_control_thermometer_ha')));
  // it reports again: back to it
  v = await at(5, { report: 19.6 });
  assert.equal(v.thermometer.quiet, null);
  assert.equal(v.current, 19.6);
  assert.ok(notes().some((m) => /reporting again \(19\.6°\), so the room goes by it again/.test(m)));
  assert.ok(!engine.attention.some((a) => a.key === 'quiet-ha'));
  assert.ok(await eventually(() => ha.calls.some((c) => c.service === 'dismiss' && c.data.notification_id === 'home_control_thermometer_ha')));
});

test('not heating: nothing heard for an hour and a half counts; a report of the same value (REST last_reported) is enough', async () => {
  const { at, ha } = room({ temp: 19.4, trv: 19.6 });
  let v = await at();
  assert.equal(v.calling, false);
  v = await at(60);
  assert.equal(v.thermometer.quiet, null);
  // the same 19.4° reported again: no state change on the websocket, only last_reported
  ha.rest.set('sensor.ha', { ...ha.get('sensor.ha'), last_reported: iso() });
  v = await at(1);
  v = await at(1);
  v = await at(80);
  assert.equal(v.thermometer.quiet, null, 'heard from 80 minutes ago (by REST), not 141');
  v = await at(15);
  assert.equal(v.thermometer.quiet?.reason, 'long');
  ha.rest.set('sensor.ha', { ...ha.get('sensor.ha'), last_reported: iso() });
  v = await at(1);
  v = await at(1);
  assert.equal(v.thermometer.quiet, null, 'heard again');
});

test('set to turn the heating off: frost protection until it reports; no radiator readings: off too', async () => {
  const { at, engine } = room({ action: 'off' });
  await at();
  let v = await at(100);
  assert.equal(v.thermometer.quiet?.action, 'off');
  assert.equal(v.source, 'quiet');
  assert.equal(v.target, engine.s.frostTemp);
  assert.equal(v.calling, false);
  v = await at(1, { report: 18.2 });
  assert.equal(v.source, 'schedule');
  assert.equal(v.calling, true);

  // its only radiator is the boiler's thermostat... with no reading either
  const two = room({ trvs: [] });
  await two.at();
  v = await two.at(100);
  assert.equal(v.thermometer.quiet?.action, 'off', 'nothing else to go by');
  assert.equal(v.source, 'quiet');
});

test('offline in Home Assistant for three minutes counts at once; a blip (Home Assistant restarting) doesn\'t', async () => {
  const { at, ha } = room();
  await at();
  ha.set('sensor.ha', { state: 'unavailable', last_changed: iso(), last_updated: iso(), last_reported: iso() });
  let v = await at(1);
  assert.equal(v.thermometer.quiet, null, 'a blip');
  v = await at(3);
  assert.equal(v.thermometer.quiet?.reason, 'offline');
  v = await at(1, { report: 18.9 });
  assert.equal(v.thermometer.quiet, null);
});
