// Away: each room drops to its own Away temperature or the house's, and each lived-in lighting group
// has its own Away evening (off time and brightness) or the house's.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from '../src/heating/engine.js';
import { Store } from '../src/heating/store.js';
import { Engine as LightingEngine } from '../src/lighting/engine.js';
import { Store as LightStore } from '../src/lighting/store.js';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const flat = (temp) => Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp }]]));
const timers = [];
test.after(() => { for (const t of timers.splice(0)) clearTimeout(t); });

class StubHa extends EventEmitter {
  constructor() { super(); this.states = new Map(); this.timeZone = 'Europe/London'; this.connected = false; }
  get(id) { return this.states.get(id); }
  callService() { return Promise.resolve(); }
  send() { return Promise.reject(new Error('no')); }
  childLockFor() { return null; }
  companionFor() { return null; }
  entityInfo() { return null; }
}

function heatingHouse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-away-'));
  const store = new Store(dir);
  store.data.settings.awayTemp = 12;
  const engine = new Engine(new StubHa(), store, () => {});
  return { engine, store };
}

test('Away: a room uses its own temperature, or the house\'s', () => {
  const { engine, store } = heatingHouse();
  const lounge = engine.upsertZone({ name: 'Lounge', trvs: ['climate.lounge'], schedule: flat(20) });
  const bed = engine.upsertZone({ name: 'Bedroom', trvs: ['climate.bed'], schedule: flat(18), awayTemp: 15 });
  store.data.runtime.mode = 'away';
  assert.deepEqual([engine.targetFor(lounge).temp, engine.targetFor(lounge).source], [12, 'away']);
  assert.equal(engine.targetFor(bed).temp, 15);
  // the house's changes: only rooms without their own follow
  engine.updateSettings({ awayTemp: 10 });
  assert.equal(engine.targetFor(lounge).temp, 10);
  assert.equal(engine.targetFor(bed).temp, 15);
  // saved without sending it: kept; '' or null: back to the house's; rounded to 0.5 and kept within 5–21
  engine.upsertZone({ id: bed.id, name: 'Bedroom', trvs: ['climate.bed'] });
  assert.equal(bed.awayTemp, 15);
  engine.upsertZone({ id: bed.id, name: 'Bedroom', trvs: ['climate.bed'], awayTemp: '' });
  assert.equal(bed.awayTemp, null);
  assert.equal(engine.targetFor(bed).temp, 10);
  engine.upsertZone({ id: bed.id, name: 'Bedroom', trvs: ['climate.bed'], awayTemp: 30 });
  assert.equal(bed.awayTemp, 21);
  engine.upsertZone({ id: bed.id, name: 'Bedroom', trvs: ['climate.bed'], awayTemp: '13.3' });
  assert.equal(bed.awayTemp, 13.5);
  engine.updateSettings({ awayTemp: 2 });
  assert.equal(store.data.settings.awayTemp, 5);
  // Away with an end time: its own temperature until then, then its schedule
  store.data.runtime.awayUntil = Date.now() + 3600000;
  assert.equal(engine.targetFor(bed).temp, 13.5);
  assert.equal(engine.targetFor(bed, Date.now() + 2 * 3600000).temp, 18);
  for (const t of [engine.tickTimer, store.saveTimer, store.timer, store.logTimer]) timers.push(t);
});

test('Away: a lived-in group uses its own evening, or the house\'s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-away-l-'));
  const store = new LightStore(dir, { info() {}, warn() {} });
  const engine = new LightingEngine({ ha: new StubHa(), store, log: { info() {}, warn() {} }, now: () => Date.UTC(2026, 9, 26, 12) });
  const { group: lounge } = engine.saveGroup({ name: 'Lounge', devices: ['light.lounge_lamp'], livedIn: true });
  const { group: hall } = engine.saveGroup({ name: 'Hall', devices: ['light.hall'], livedIn: true, away: { offTime: '22:00', brightness: 40 } });
  const { group: shed } = engine.saveGroup({ name: 'Shed', devices: ['light.shed'] });
  engine.data.mode = 'away';
  const evening = (g) => {
    const day = engine.weekFor(g)[0];
    return { on: day[1]?.brightness, off: day[2]?.time };
  };
  const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  // the house's: 70% and off around 23:00 (±20 min)
  assert.equal(evening(lounge).on, 70);
  assert.ok(Math.abs(minutes(evening(lounge).off) - 23 * 60) <= 20, evening(lounge).off);
  // its own: 40% and off around 22:00
  assert.equal(evening(hall).on, 40);
  assert.ok(Math.abs(minutes(evening(hall).off) - 22 * 60) <= 20, evening(hall).off);
  assert.equal(engine.weekFor(shed), null, 'not lived in: kept off');
  // only one of them its own: the other from the house's
  engine.saveGroup({ name: 'Hall', devices: ['light.hall'], livedIn: true, away: { offTime: null, brightness: 55 } }, hall.id);
  assert.deepEqual(engine.awayFor(hall), { offTime: '23:00', brightness: 55 });
  // saved without it: kept; empty: the house's again
  engine.saveGroup({ name: 'Hall', devices: ['light.hall'], livedIn: true }, hall.id);
  assert.deepEqual(hall.away, { offTime: null, brightness: 55 });
  engine.saveGroup({ name: 'Hall', devices: ['light.hall'], livedIn: true, away: { offTime: '', brightness: '' } }, hall.id);
  assert.equal(hall.away, null);
  engine.saveSettings({ awayOffTime: '21:30', awayBrightness: 30 });
  assert.deepEqual(engine.awayFor(hall), { offTime: '21:30', brightness: 30 });
  for (const t of [engine.timer, engine.tickTimer, store.saveTimer, store.timer]) timers.push(t);
});
