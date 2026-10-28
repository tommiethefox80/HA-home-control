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
  assert.deepEqual(engine.awayFor(hall), { offTime: '23:00', brightness: 55, morning: null });
  // saved without it: kept; empty: the house's again
  engine.saveGroup({ name: 'Hall', devices: ['light.hall'], livedIn: true }, hall.id);
  assert.deepEqual(hall.away, { offTime: null, brightness: 55, morning: null });
  engine.saveGroup({ name: 'Hall', devices: ['light.hall'], livedIn: true, away: { offTime: '', brightness: '' } }, hall.id);
  assert.equal(hall.away, null);
  engine.saveSettings({ awayOffTime: '21:30', awayBrightness: 30 });
  assert.deepEqual(engine.awayFor(hall), { offTime: '21:30', brightness: 30, morning: null });
  for (const t of [engine.timer, engine.tickTimer, store.saveTimer, store.timer]) timers.push(t);
});

test('Away: lived-in mornings, on around a time until about sunrise, on dark mornings only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-away-m-'));
  const store = new LightStore(dir, { info() {}, warn() {} });
  const engine = new LightingEngine({ ha: new StubHa(), store, log: { info() {}, warn() {} }, now: () => Date.UTC(2026, 11, 14, 12) });
  // Northwich: sunrise about 08:20 in mid-December, about 04:40 in mid-June
  engine.config = { time_zone: 'Europe/London', latitude: 53.26, longitude: -2.52 };
  const { group: lounge } = engine.saveGroup({ name: 'Lounge', devices: ['light.lounge_lamp'], livedIn: true });
  const { group: hall } = engine.saveGroup({ name: 'Hall', devices: ['light.hall'], livedIn: true, away: { morning: false } });
  const { group: bed } = engine.saveGroup({ name: 'Bedroom', devices: ['light.bed'], livedIn: true, away: { morning: '07:15' } });
  engine.data.mode = 'away';
  const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  // the house's mornings start off: evenings only
  assert.equal(engine.weekFor(lounge)[0].length, 3, 'midnight, on at sunset, off in the evening');
  engine.saveSettings({ awayMorning: '06:30' });
  for (let d = 0; d < 7; d++) {
    const day = engine.weekFor(lounge)[d];
    assert.equal(day.length, 5, JSON.stringify(day));
    const [, mOn, mOff, eOn, eOff] = day;
    assert.ok(mOn.on && !mOff.on && eOn.on && !eOff.on);
    assert.ok(Math.abs(minutes(mOn.time) - 6 * 60 - 30) <= 15, mOn.time);
    assert.ok(minutes(mOff.time) >= 8 * 60 && minutes(mOff.time) <= 8 * 60 + 50, `off around sunrise: ${mOff.time}`);
    assert.ok(minutes(eOn.time) >= 15 * 60 + 40 && minutes(eOn.time) <= 16 * 60 + 40, `on around sunset: ${eOn.time}`);
    assert.equal(mOn.brightness, 70);
  }
  // varies from day to day, the same each time it's worked out
  const days = Object.values(engine.weekFor(lounge)).map((d) => d[1].time);
  assert.ok(new Set(days).size > 1, days.join(' '));
  assert.deepEqual(Object.values(engine.weekFor(lounge)).map((d) => d[1].time), days);
  // a group with none, and one with its own
  assert.equal(engine.weekFor(hall)[0].length, 3);
  assert.equal(engine.awayFor(hall).morning, null);
  assert.ok(Math.abs(minutes(engine.weekFor(bed)[0][1].time) - 7 * 60 - 15) <= 15);
  // in summer the sun's up first: evenings only
  const summer = new LightingEngine({ ha: new StubHa(), store, log: { info() {}, warn() {} }, now: () => Date.UTC(2026, 5, 15, 12) });
  summer.config = engine.config;
  assert.ok(Object.values(summer.weekFor(lounge)).every((d) => d.length === 3), 'no mornings in June');
  // cleared: evenings only again
  engine.saveSettings({ awayMorning: '' });
  assert.equal(store.data.settings.awayMorning, null);
  assert.equal(engine.weekFor(lounge)[0].length, 3);
  for (const e of [engine, summer]) for (const t of [e.timer, e.tickTimer]) timers.push(t);
  for (const t of [store.saveTimer, store.timer]) timers.push(t);
});
