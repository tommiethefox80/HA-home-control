// Renames in Home Assistant: a new name shows straight away, and a new entity ID is followed by
// whatever used the old one (lighting groups, rooms, cameras).
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/rename-test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
};
const app = (m, p, b) => j(m, APP + p, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }
const kitchen = async () => (await app('GET', '/api/lighting/state')).groups.find((g) => g.name === 'Kitchen');

await step('set up: a lighting group with a socket, a room with a radiator, a camera', async () => {
  await app('POST', '/api/lighting/groups', { name: 'Kitchen', devices: ['switch.kettle_plug', 'light.kitchen_spots'] });
  await app('POST', '/api/zones', { name: 'Lounge', trvs: ['climate.lounge_trv'], sensor: 'sensor.lounge_temperature' });
  await app('PUT', '/api/house', { modules: { cameras: true } });
  await sleep(1500);
  await app('POST', '/api/cameras/cameras', { entity: 'camera.front_door_live_view' });
  const g = await kitchen();
  assert.deepEqual(g.devices.map((d) => d.id), ['switch.kettle_plug', 'light.kitchen_spots']);
});

await step('each one in use is noted with its permanent registry ID and its name', async () => {
  const file = path.join(ROOT, 'dev/data/entity-ids.json');
  const want = ['switch.kettle_plug', 'light.kitchen_spots', 'climate.lounge_trv', 'sensor.lounge_temperature', 'camera.front_door_live_view'];
  let known = {};
  for (let i = 0; i < 50 && !want.every((id) => known[id]); i++) { await sleep(500); try { known = JSON.parse(fs.readFileSync(file, 'utf8')).known; } catch { /* not yet */ } }
  for (const id of want) assert.match(known[id]?.rid || '', /^[0-9a-f]{32}$/, `${id}: ${JSON.stringify(known[id])}`);
  assert.equal(known['switch.kettle_plug'].name, 'Kettle plug');
});

await step('a new name in Home Assistant shows straight away', async () => {
  await mock('POST', '/sensor', { entity: 'switch.kettle_plug', state: 'off', attrs: { friendly_name: 'Kettle' } });
  await sleep(600);
  const d = (await kitchen()).devices.find((x) => x.id === 'switch.kettle_plug');
  assert.equal(d.name, 'Kettle');
});

await step('a socket given a new entity ID stays in its group, under its new name', async () => {
  assert.equal((await mock('POST', '/rename', { from: 'switch.kettle_plug', to: 'switch.kettle_socket', name: 'Kettle socket' })).ok, true);
  await sleep(1000);
  const g = await kitchen();
  const d = g.devices.find((x) => x.id === 'switch.kettle_socket');
  assert.ok(d, `group follows the new ID (${g.devices.map((x) => x.id)})`);
  assert.ok(!g.devices.some((x) => x.id === 'switch.kettle_plug'), 'old ID gone');
  assert.equal(d.name, 'Kettle socket');
  assert.equal(d.available, true);
  assert.equal(d.missing, false);
  const act = (await app('GET', '/api/lighting/activity')).items;
  assert.ok(act.some((a) => /renamed switch\.kettle_plug to switch\.kettle_socket/.test(a.text || a.msg || '')), JSON.stringify(act.slice(0, 3)));
});

await step('the socket still switches under its new ID', async () => {
  await mock('POST', '/reset-calls');
  const g = await kitchen();
  await app('POST', `/api/lighting/groups/${g.id}/set`, { device: 'switch.kettle_socket', on: true });
  await sleep(1200);
  const calls = await mock('GET', '/calls');
  assert.ok(calls.some((c) => JSON.stringify(c).includes('switch.kettle_socket')), JSON.stringify(calls));
  assert.ok(!calls.some((c) => JSON.stringify(c).includes('switch.kettle_plug')));
});

await step('a radiator given a new entity ID stays in its room', async () => {
  await mock('POST', '/rename', { from: 'climate.lounge_trv', to: 'climate.lounge_radiator' });
  await sleep(1000);
  const st = await app('GET', '/api/state');
  const z = st.zones.find((x) => x.name === 'Lounge');
  const trvs = z.trvs.map((t) => t.entity_id);
  assert.deepEqual(trvs, ['climate.lounge_radiator'], JSON.stringify(z.trvs));
  const log = (await app('GET', '/api/log')).entries;
  assert.ok(log.some((e) => /renamed climate\.lounge_trv to climate\.lounge_radiator/.test(e.msg || e.text || '')), JSON.stringify(log.slice(0, 3)));
});

await step('a camera given a new entity ID is still the same camera', async () => {
  await mock('POST', '/rename', { from: 'camera.front_door_live_view', to: 'camera.front_door' });
  await sleep(1500);
  const st = await app('GET', '/api/cameras/state');
  const cams = st.cameras.map((c) => c.entity);
  assert.ok(cams.includes('camera.front_door'), JSON.stringify(cams));
  assert.ok(!cams.includes('camera.front_door_live_view'));
});

await step('a rename missed while the connection was down is caught when it comes back', async () => {
  await mock('POST', '/rename', { from: 'switch.kettle_socket', to: 'switch.kitchen_kettle', silent: true });
  await sleep(500);
  assert.ok((await kitchen()).devices.some((d) => d.id === 'switch.kettle_socket' && d.missing), 'not followed yet: nothing said so');
  await mock('POST', '/drop');
  await sleep(9000); // reconnect, then each part reads Home Assistant, then the check
  const g = await kitchen();
  assert.ok(g.devices.some((d) => d.id === 'switch.kitchen_kettle' && !d.missing), JSON.stringify(g.devices.map((d) => [d.id, d.missing])));
});

await step('a rename made while Home Control was off is followed when it starts', async () => {
  const pidFile = path.join(ROOT, 'dev/logs/server.pid');
  process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
  await sleep(1500);
  await mock('POST', '/rename', { from: 'switch.kitchen_kettle', to: 'switch.kettle', name: 'Kettle' });
  await mock('POST', '/rename', { from: 'climate.lounge_radiator', to: 'climate.lounge_rad', silent: true });
  const out = fs.openSync(path.join(ROOT, 'dev/logs/server.log'), 'a');
  const child = spawn('node', ['server/src/index.js'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, MEDIA_DIR: path.join(ROOT, 'dev/data/media'), HA_MEDIA_DIR: path.join(ROOT, 'dev/data/media'), HA_URL: 'http://localhost:8123', HA_TOKEN: 'dev', DATA_DIR: 'dev/data', PORT: '8099' },
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  for (let i = 0; i < 30; i++) { await sleep(500); try { await app('GET', '/api/state'); break; } catch { /* starting */ } }
  await sleep(8000);
  const g = await kitchen();
  assert.ok(g.devices.some((d) => d.id === 'switch.kettle' && d.name === 'Kettle' && !d.missing), JSON.stringify(g.devices.map((d) => [d.id, d.name])));
  const z = (await app('GET', '/api/state')).zones.find((x) => x.name === 'Lounge');
  assert.deepEqual(z.trvs.map((t) => t.entity_id), ['climate.lounge_rad']);
});

await step('an integration removed and added back, with a new entity ID, is matched by its unique ID', async () => {
  await mock('POST', '/readd', { from: 'switch.kettle', to: 'switch.kettle_2' });
  await sleep(5000);
  const g = await kitchen();
  assert.ok(g.devices.some((d) => d.id === 'switch.kettle_2' && !d.missing), JSON.stringify(g.devices.map((d) => [d.id, d.missing])));
});

await step('a device that disappears keeps the last name it had', async () => {
  await fetch('http://localhost:8123/api/states/light.kitchen_spots', { method: 'DELETE', headers: { Authorization: 'Bearer dev' } });
  await sleep(800);
  const d = (await kitchen()).devices.find((x) => x.id === 'light.kitchen_spots');
  assert.equal(d.missing, true);
  assert.equal(d.name, 'Kitchen spots');
});

await step('an ID nothing uses changes nothing', async () => {
  const before = (await kitchen()).devices.map((d) => d.id);
  await mock('POST', '/rename', { from: 'light.porch', to: 'light.front_porch' });
  await sleep(800);
  assert.deepEqual((await kitchen()).devices.map((d) => d.id), before);
});

console.log(`\n${passed} passed`);
