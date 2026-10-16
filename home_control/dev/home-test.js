// Heating and lighting together in one app: heating still works, and Away is shared.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/home-test.js
import assert from 'node:assert/strict';
import { zonedParts, minutesToTime } from '../server/src/lighting/schedule.js';

const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
};
const heat = (m, p, b) => j(m, APP + '/api/' + p, b);
const light = (m, p, b) => j(m, APP + '/api/lighting/' + p, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const nowMin = zonedParts(Date.now(), 'Europe/London').minutes;
const t = (d) => minutesToTime(Math.max(0, Math.min(1439, nowMin + d)));
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }

await step('one connection serves both: heating and lighting are both connected', async () => {
  assert.equal((await heat('GET', 'state')).haConnected, true);
  assert.equal((await light('GET', 'state')).connected, true);
});

await step('heating still drives radiators and the boiler', async () => {
  await heat('PUT', 'settings', { boiler: { entity: 'climate.heating', onTemp: 30, offTemp: 7, minOnMinutes: 0, minOffMinutes: 0 }, commandGraceSeconds: 30 });
  const sched = Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp: 21 }]]));
  const r = await heat('POST', 'zones', { name: 'Lounge', trvs: ['climate.lounge_trv'], sensor: 'sensor.lounge_temperature', schedule: sched });
  assert.ok(r.id);
  await sleep(5000);
  const c = await mock('GET', '/climate');
  assert.equal(c['climate.lounge_trv'].temperature, 21, `radiator set to 21 (${JSON.stringify(c['climate.lounge_trv'])})`);
  const st = await heat('GET', 'state');
  assert.equal(st.zones[0].calling, true, 'room below target is calling for heat');
  assert.equal(st.boiler.on, true, 'boiler on');
  assert.equal(c['climate.heating'].temperature, 30, 'Hive thermostat pushed up to fire the boiler');
});

await step('dashboard sensors: heating, boiler and lighting are written to Home Assistant', async () => {
  await sleep(2500);
  let pub = (await mock('GET', '/published')).states;
  const h = pub['sensor.home_heating'];
  assert.ok(h, 'sensor.home_heating written');
  assert.equal(h.state, 'Schedules');
  assert.equal(h.attributes.rooms[0].name, 'Lounge');
  assert.equal(h.attributes.rooms[0].target, 21);
  assert.equal(h.attributes.boiler_on, true);
  assert.match(h.attributes.boiler, /^Boiler on for Lounge/);
  assert.equal(pub['binary_sensor.home_boiler'].state, 'on');
  assert.equal(pub['binary_sensor.home_boiler'].attributes.device_class, 'heat');
  // today's boiler run time, for the dashboard card and Home Assistant's statistics
  assert.equal(typeof h.attributes.boiler_today_minutes, 'number', JSON.stringify(h.attributes));
  assert.match(h.attributes.boiler_today, /^\d+m$|^\d+h( \d+m)?$/);
  const bt = pub['sensor.home_boiler_today'];
  assert.ok(bt, 'sensor.home_boiler_today written');
  assert.equal(Number(bt.state), h.attributes.boiler_today_minutes);
  assert.equal(bt.attributes.unit_of_measurement, 'min');
  assert.equal(bt.attributes.state_class, 'total_increasing');
  assert.ok(pub['sensor.home_lighting'], 'sensor.home_lighting written');
  // when the boiler next fires: a timestamp sensor, unknown while it's on
  const bn = pub['sensor.home_boiler_next'];
  assert.ok(bn, 'sensor.home_boiler_next written');
  assert.equal(bn.attributes.device_class, 'timestamp');
  assert.equal(bn.state, 'unknown');
  assert.ok(h.attributes.rooms.every((r) => 'next' in r && 'next_heat' in r), 'rooms carry their next heat');
  // a mode change shows within a couple of seconds, not at the next slow refresh
  await heat('POST', 'mode', { mode: 'off' });
  await sleep(2500);
  pub = (await mock('GET', '/published')).states;
  assert.equal(pub['sensor.home_heating'].state, 'Off');
  assert.equal(pub['sensor.home_heating'].attributes.icon, 'mdi:radiator-off');
  await heat('POST', 'mode', { mode: 'auto' });
  // nothing is rewritten when nothing changed
  await sleep(2500);
  const before = (await mock('GET', '/published')).count;
  await sleep(6000);
  assert.ok((await mock('GET', '/published')).count - before <= 1, 'quiet when nothing changes');
});

await step('a radiator knob turned by hand is still respected', async () => {
  await mock('POST', '/knob', { entity: 'climate.lounge_trv', temperature: 23 });
  await sleep(2500);
  const st = await heat('GET', 'state');
  const log = st.log.map((l) => l.msg).join(' | ');
  assert.match(log, /changed by hand to 23°/, log);
});

await step('heating Away puts the lights in Away too, and back', async () => {
  await light('POST', 'groups', { name: 'Lounge', devices: ['light.lounge_lamp'], livedIn: true });
  await heat('POST', 'mode', { mode: 'away' });
  await sleep(1500);
  assert.equal((await light('GET', 'state')).mode, 'away');
  const act = (await light('GET', 'activity')).items.map((i) => i.text);
  assert.match(act[0], /Heating set to Away\. Away mode on\./, act[0]);
  await heat('POST', 'mode', { mode: 'auto' });
  await sleep(1500);
  assert.equal((await light('GET', 'state')).mode, 'schedule');
  await light('POST', 'groups/lounge/set', { on: true, brightness: 40 });
  await sleep(5000);
  const lg = (await mock('GET', '/published')).states['sensor.home_lighting'];
  const lounge = lg.attributes.groups.find((g) => g.name === 'Lounge');
  assert.equal(lounge.on, true, JSON.stringify(lounge));
  assert.equal(lounge.level, '40%');
  assert.ok(Number(lg.state) >= 1);
  assert.match(lg.attributes.summary, /on in Lounge/);
});

await step('Away on the Lighting page sets the heating to Away too', async () => {
  await light('POST', 'mode', { mode: 'away' });
  await sleep(800);
  assert.equal((await heat('GET', 'state')).mode, 'away');
  await light('POST', 'mode', { mode: 'schedule' });
  await sleep(800);
  assert.equal((await heat('GET', 'state')).mode, 'auto');
});

await step('a Home Assistant script setting lighting to Away (lighting_control_mode) sets the heating too', async () => {
  await mock('POST', '/fire', { event_type: 'lighting_control_mode', data: { mode: 'away' } });
  await sleep(1000);
  assert.equal((await light('GET', 'state')).mode, 'away');
  assert.equal((await heat('GET', 'state')).mode, 'away');
  await mock('POST', '/fire', { event_type: 'lighting_control_mode', data: { mode: 'schedules' } });
  await sleep(1000);
  assert.equal((await light('GET', 'state')).mode, 'schedule');
  assert.equal((await heat('GET', 'state')).mode, 'auto');
});

await step('heating Off leaves the lights alone, and lighting Away then leaves the heating off', async () => {
  await heat('POST', 'mode', { mode: 'off' });
  await sleep(1200);
  assert.equal((await light('GET', 'state')).mode, 'schedule');
  await light('POST', 'mode', { mode: 'away' });
  await sleep(800);
  assert.equal((await heat('GET', 'state')).mode, 'off', 'heating stays off');
  await light('POST', 'mode', { mode: 'schedule' });
});

await step('with the heating off, lights still go Away when everyone leaves, and come back', async () => {
  await heat('PUT', 'settings', { presence: { enabled: true, people: [], delayMinutes: 0, nearMiles: 2 } });
  await mock('POST', '/sensor', { entity: 'person.tom', state: 'not_home', attrs: { latitude: 53.5, longitude: -2.2 } });
  await mock('POST', '/sensor', { entity: 'person.sam', state: 'not_home', attrs: { latitude: 53.5, longitude: -2.2 } });
  await sleep(33000); // the house check runs every 30 s
  assert.equal((await light('GET', 'state')).mode, 'away');
  assert.equal((await heat('GET', 'state')).mode, 'off', 'heating still off');
  await mock('POST', '/sensor', { entity: 'person.sam', state: 'home', attrs: { latitude: 53.26, longitude: -2.52 } });
  await sleep(33000);
  assert.equal((await light('GET', 'state')).mode, 'schedule');
  await mock('POST', '/sensor', { entity: 'person.tom', state: 'home', attrs: { latitude: 53.26, longitude: -2.52 } });
  await heat('PUT', 'settings', { presence: { enabled: false, people: [], delayMinutes: 15, nearMiles: 2 } });
  await heat('POST', 'mode', { mode: 'auto' });
});

await step('bringing lighting across: imported, paused until started, then nothing changes until the next change', async () => {
  const exported = {
    groups: [
      { id: 'lounge', name: 'Lounge', devices: ['light.lounge_lamp', 'light.lounge_ceiling'], livedIn: true },
      { id: 'backroom', name: 'Backroom', devices: ['switch.kettle_plug'] },
    ],
    schedules: {
      lounge: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ time: t(-60), on: false }, { time: t(60), on: true, brightness: 40 }]])),
      backroom: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ time: t(-60), on: false }]])),
    },
    scenes: [{ id: 'goodnight', name: 'Goodnight', until: 'morning', others: 'off', groups: { backroom: { action: 'on', minutes: 5 } } }],
    settings: { stepSize: 5, autoAway: true },
  };
  await mock('POST', '/human', { entity: 'light.lounge_lamp', on: true, brightness: 60 });
  await mock('POST', '/reset-calls');
  const r = await light('POST', 'import', exported);
  assert.deepEqual(r.imported, { groups: 2, scenes: 1 });
  assert.equal(r.paused, true);
  await sleep(16000);
  const lightCalls = (await mock('GET', '/calls')).filter((c) => ['light', 'switch'].includes(c.domain) || c.service === 'update_entity');
  assert.equal(lightCalls.length, 0, `nothing sent to lights while paused: ${JSON.stringify(lightCalls)}`);
  await assert.rejects(light('POST', 'groups/lounge/set', { on: false }), /paused/);
  await mock('POST', '/fire', { event_type: 'lighting_control_scene', data: { scene: 'Goodnight' } });
  await sleep(1500);
  const sceneCalls = (await mock('GET', '/calls')).filter((c) => ['light', 'switch'].includes(c.domain));
  assert.equal(sceneCalls.length, 0, `a scene from Home Assistant while paused changed lights: ${JSON.stringify(sceneCalls)}`);
  const cfg = await light('GET', 'config');
  assert.equal(cfg.settings.stepSize, 5);
  assert.equal(cfg.settings.autoAway, false, 'own presence stays off: the house handles it');
  await light('POST', 'paused', { paused: false });
  await sleep(4000);
  assert.equal((await mock('GET', '/states'))['light.lounge_lamp'].state, 'on', 'left as it was');
  const g = (await light('GET', 'state')).groups.find((x) => x.id === 'lounge');
  assert.match(g.status.text, /^Left as it is until/, g.status.text);
});

console.log(`\n${passed} Home checks passed`);
