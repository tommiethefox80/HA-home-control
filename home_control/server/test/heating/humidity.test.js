// Humidity: found on the thermometer's device, what it means now, and the week's damp at the
// coldest spots (corners, round the windows), kept in the half-hourly history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dewPoint, coldSpotRh, humidityNow, dampWeek, findHumidity, levelOf, coldSeries } from '../../src/heating/humidity.js';
import { LongLog, HALF, buildHistory } from '../../src/heating/longlog.js';

const H = 3600000; const D = 24 * H;

test('the dew point, and how humid the air is against the coldest spots', () => {
  assert.equal(Math.round(dewPoint(20, 50) * 10) / 10, 9.3);
  assert.equal(Math.round(dewPoint(18, 100) * 10) / 10, 18);
  // 18° and 60% with 0° outside: the coldest spots are 13.5°, where the same air is about 80%
  assert.equal(Math.round(coldSpotRh(18, 60, 0)), 80);
  // milder outside, drier there; a degree warmer, drier too
  assert.ok(coldSpotRh(18, 60, 10) < 70);
  assert.ok(coldSpotRh(18, 60, 0, { warmer: 1 }) < coldSpotRh(18, 60, 0) - 3);
  assert.equal(coldSpotRh(18, 60, null), null);
  assert.deepEqual(['dry', 'ok', 'humid', 'damp'], [38, 50, 65, 75].map(levelOf));
  assert.deepEqual(coldSeries([18, 18, null], [60, null, 60], [0, 0, 0]), [80, null, null]);
});

test('now: its level, and the windows running wet on a cold night', () => {
  const mild = humidityNow({ temp: 20, rh: 50, out: 10 });
  assert.equal(mild.level, 'ok');
  assert.equal(mild.windows, false);
  const cold = humidityNow({ temp: 16.5, rh: 74, out: -1 });
  assert.equal(cold.level, 'damp');
  assert.equal(cold.windows, true, 'the glass (about 10°) is below the dew point (about 12°)');
  assert.ok(cold.coldSpot.rh >= 95);
  // no outside temperature: just the room's
  const none = humidityNow({ temp: 19, rh: 55, out: null });
  assert.equal(none.coldSpot, null);
  assert.equal(humidityNow({ temp: 19, rh: null, out: 5 }), null);
});

test('found on the thermometer\'s device, or named the same way', () => {
  const states = new Map([
    ['sensor.lounge_temperature', { state: '19', attributes: { device_class: 'temperature' } }],
    ['sensor.lounge_monitor_humidity', { state: '55', attributes: { device_class: 'humidity', unit_of_measurement: '%' } }],
    ['sensor.lounge_monitor_battery', { state: '90', attributes: { device_class: 'battery', unit_of_measurement: '%' } }],
    ['sensor.bedroom_temp', { state: '17', attributes: { device_class: 'temperature' } }],
    ['sensor.bedroom_humidity', { state: '61', attributes: { unit_of_measurement: '%' } }],
    ['sensor.hall_temperature', { state: '17', attributes: { device_class: 'temperature' } }],
  ]);
  const registry = new Map([['sensor.lounge_temperature', 'd1'], ['sensor.lounge_monitor_humidity', 'd1'], ['sensor.lounge_monitor_battery', 'd1']]);
  const ha = {
    states, registry,
    companionFor(id, t) { const dev = registry.get(id); for (const [e, d] of registry) if (d === dev && e !== id && t(e, states.get(e))) return e; return null; },
  };
  assert.equal(findHumidity(ha, 'sensor.lounge_temperature'), 'sensor.lounge_monitor_humidity');
  assert.equal(findHumidity(ha, 'sensor.bedroom_temp'), 'sensor.bedroom_humidity');
  assert.equal(findHumidity(ha, 'sensor.hall_temperature'), null);
  assert.equal(findHumidity(ha, null), null);
});

test('found by name too, before Home Assistant\'s device list has arrived: a "temp" in the device\'s name doesn\'t throw it', () => {
  // (Tom's: a ZHA monitor named "Heidi And Annie's Temp Monitor")
  const states = new Map([
    ['sensor.heidi_and_annie_s_temp_monitor_temperature', { state: '18.1', attributes: { device_class: 'temperature' } }],
    ['sensor.heidi_and_annie_s_temp_monitor_humidity', { state: '64.2', attributes: { device_class: 'humidity', unit_of_measurement: '%' } }],
    ['sensor.heidi_and_annie_s_temp_monitor_battery', { state: '100', attributes: { device_class: 'battery', unit_of_measurement: '%' } }],
    ['sensor.temp_lounge', { state: '19', attributes: { device_class: 'temperature' } }],
    ['sensor.lounge_humidity', { state: '55', attributes: { device_class: 'humidity', unit_of_measurement: '%' } }],
  ]);
  const ha = { states, companionFor: () => null };
  assert.equal(findHumidity(ha, 'sensor.heidi_and_annie_s_temp_monitor_temperature'), 'sensor.heidi_and_annie_s_temp_monitor_humidity');
  assert.equal(findHumidity(ha, 'sensor.temp_lounge'), 'sensor.lounge_humidity');
});

// a week of half hours: each night 23:00–07:00 the room at nightT and nightRh, the day 20° and 50%
function week({ nightT, nightRh, out = 3, now = Date.UTC(2026, 10, 24, 12) }) {
  const pts = [];
  for (let t = now - 7 * D; t < now; t += HALF) {
    const h = new Date(t).getUTCHours();
    const night = h >= 23 || h < 7;
    pts.push({ at: t, temp: night ? nightT : 20, rh: night ? nightRh : 50, out });
  }
  return pts;
}

test('the week: mould where the coldest spots average 80%, damp at times where they\'re over it each night', () => {
  // a cold, humid bedroom: 15° and 75% all night, 3° outside
  const bad = dampWeek(week({ nightT: 15, nightRh: 75 }).map((p) => ({ ...p, temp: 15, rh: 75 })), { tz: 'UTC' });
  assert.equal(bad.verdict, 'mould');
  assert.ok(bad.coldAvg >= 90);
  assert.ok(bad.warmerAvg < bad.coldAvg);
  // humid nights only: over 80% for 8 hours a night, fine by day
  const nights = dampWeek(week({ nightT: 16, nightRh: 68 }), { tz: 'UTC' });
  assert.equal(nights.verdict, 'watch');
  assert.equal(nights.perDay, 8);
  assert.equal(nights.night, 1, 'all overnight');
  // a warm, dry room
  const fine = dampWeek(week({ nightT: 19, nightRh: 50 }), { tz: 'UTC' });
  assert.equal(fine.verdict, 'fine');
  assert.equal(fine.overHours, 0);
  // no outside temperature: from the room's own humidity
  const noOut = dampWeek(week({ nightT: 16, nightRh: 75 }).map((p) => ({ ...p, rh: 72, out: null })), { tz: 'UTC' });
  assert.equal(noOut.coldAvg, null);
  assert.equal(noOut.verdict, 'mould');
  // less than a day and a half: nothing yet
  assert.equal(dampWeek(week({ nightT: 16, nightRh: 68 }).slice(-60)), null);
});

test('kept every half hour with the temperature, filled in where it was missing, and drawn on the History chart', async () => {
  const log = new LongLog(null);
  const t0 = Date.UTC(2026, 10, 10, 18, 0);
  const eng = { boilerFiring: () => false, outsideNow: () => 4 };
  for (let m = 0; m <= 31; m++) {
    log.sample(t0 + m * 60000, eng, [
      { id: 'bed', enabled: true, current: 18, target: 18, heating: false, humidity: { now: m < 15 ? 60 : 64 } },
      { id: 'hall', enabled: true, current: 17, target: 17, heating: false, humidity: null },
    ]);
  }
  const x = log.at(t0);
  assert.equal(x.rooms.bed.rh, 62.1, '14 minutes at 60%, 16 at 64%');
  assert.equal(x.rooms.hall.rh, null);
  assert.equal(log.data.rooms.hall.rh, undefined, 'none kept for a room without humidity');
  // a half hour kept before humidity was: filled in from Home Assistant without touching the rest
  log.put(t0 - HALF, { rooms: { bed: { t: 17.5, g: 18, h: 10 } }, out: 4, boil: 10 });
  log.put(t0 - HALF, { rooms: { bed: { t: 99, g: 99, h: 99, rh: 66 } }, out: 99, boil: 99 }, { onlyGaps: true });
  assert.deepEqual(log.at(t0 - HALF).rooms.bed, { t: 17.5, g: 18, h: 10, rh: 66 });
  // and earlier than anything kept: everything lines up
  log.put(t0 - 3 * HALF, { rooms: { bed: { t: 17, g: 18, h: 0, rh: 70 } }, out: 3, boil: 0 });
  assert.equal(log.at(t0 - 3 * HALF).rooms.bed.rh, 70);
  assert.equal(log.at(t0 - HALF).rooms.bed.rh, 66);
  assert.equal(log.at(t0).rooms.bed.rh, 62.1);

  // the chart: a week, every half hour, with the coldest spots alongside
  const big = new LongLog(null);
  const now = Date.UTC(2026, 10, 15, 8, 0);
  for (let t = now - 8 * D; t < now; t += HALF) big.put(t, { rooms: { bed: { t: 18, g: 18, h: 0, rh: 60 }, hall: { t: 17, g: 17, h: 0 } }, out: 0, boil: 0 });
  const engine = {
    ha: { timeZone: 'Europe/London', states: new Map(), get: () => null, send: async () => ({}) },
    s: { boiler: { entity: 'climate.boiler' }, outsideEntity: 'weather.home' },
    zones: [{ id: 'bed', name: 'Bedroom', enabled: true, trvs: [] }, { id: 'hall', name: 'Hall', enabled: true, trvs: [] }],
    longLog: big, dailyLog: { days: {} }, callLog: null,
  };
  const d = await buildHistory(engine, { from: now - 7 * D, to: now, now });
  const bed = d.rooms[0];
  assert.ok(bed.humidity.filter((v) => v === 60).length > 300);
  assert.ok(bed.coldSpot.filter((v) => v === 80).length > 300, 'at 0° outside, 18° and 60% is 80% at the coldest spots');
  assert.equal(d.rooms[1].humidity, undefined, 'none for a room without');
});

test('just after the app starts: looked for again as soon as Home Assistant\'s device list arrives', async () => {
  const { EventEmitter } = await import('node:events');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { Engine } = await import('../../src/heating/engine.js');
  const { Store } = await import('../../src/heating/store.js');
  const { PredictionLog } = await import('../../src/heating/predictions.js');
  // a monitor whose humidity sensor can't be told from its name, only by being on the same device
  const states = new Map([
    ['sensor.nursery_thermo', { entity_id: 'sensor.nursery_thermo', state: '19', attributes: { device_class: 'temperature' } }],
    ['sensor.aqara_9f3e_humidity', { entity_id: 'sensor.aqara_9f3e_humidity', state: '58', attributes: { device_class: 'humidity', unit_of_measurement: '%' } }],
    ['climate.nursery', { entity_id: 'climate.nursery', state: 'heat', attributes: { current_temperature: 19.5, temperature: 19 } }],
  ]);
  const ha = Object.assign(new EventEmitter(), {
    states, timeZone: 'UTC', connected: false, registry: null,
    get: (id) => states.get(id), callService: () => Promise.resolve(), childLockFor: () => null,
    companionFor(id, t) { const dev = this.registry?.get(id); if (!dev) return null; for (const [e, d] of this.registry) if (d === dev && e !== id && t(e, states.get(e))) return e; return null; },
  });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-hum-')));
  const flat = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ time: '00:00', temp: 19 }]]));
  store.data.zones = [{ id: 'n', name: 'Nursery', enabled: true, trvs: ['climate.nursery'], sensor: 'sensor.nursery_thermo', schedule: flat }];
  const engine = new Engine(ha, store, () => {});
  engine.predictionLog = new PredictionLog(null);
  await engine.tick();
  assert.equal(engine.views[0].humidity, null, 'not yet: no device list, and the names don\'t match');
  ha.registry = new Map([['sensor.nursery_thermo', 'd1'], ['sensor.aqara_9f3e_humidity', 'd1'], ['climate.nursery', 'd2']]);
  await engine.tick();
  assert.equal(engine.views[0].humidity?.now, 58, 'straight away, not 10 minutes later');
});
