// Cameras: four makes as their integrations set them up in Home Assistant (UniFi Protect, Ring,
// Reolink, a plain RTSP camera), movement alerts and recording on schedules, offline alerts and
// the cameras' own settings. Runs its own copy of the app (port 8097, minutes sped up) against
// the mock Home Assistant from dev/run.sh.
//   sh dev/run.sh && node dev/cameras-test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zonedParts, minutesToTime } from '../server/src/lighting/schedule.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = 'http://localhost:8097'; const MOCK = 'http://localhost:8124';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cams-'));
const MEDIA = path.join(HERE, 'data', 'media'); // where the mock Home Assistant is allowed to save
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || r.status), { status: r.status });
  return d;
};
const cam = (m, p, b) => j(m, `${APP}/api/cameras/${p}`, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const calls = async (domain) => (await mock('GET', '/calls')).filter((c) => !domain || c.domain === domain);
const sensor = (entity, state) => mock('POST', '/sensor', { entity, state });
const t = (d) => minutesToTime((zonedParts(Date.now(), 'Europe/London').minutes + d + 1440) % 1440);
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }

fs.rmSync(path.join(MEDIA, 'home_control'), { recursive: true, force: true });
const app = spawn('node', [path.join(HERE, '../server/src/index.js')], {
  env: { ...process.env, HA_URL: 'http://localhost:8123', HA_TOKEN: 'dev', DATA_DIR: DATA, PORT: '8097', MEDIA_DIR: MEDIA, HA_MEDIA_DIR: MEDIA, HC_TIME_SCALE: '0.02', HA_CONFIG_DIR: path.join(DATA, 'none') },
  stdio: ['ignore', fs.openSync(path.join(DATA, 'app.log'), 'a'), fs.openSync(path.join(DATA, 'app.log'), 'a')],
});
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });
for (let i = 0; i < 40; i++) { try { await fetch(`${APP}/api/house`); break; } catch { await sleep(250); } }
await sleep(1500);

await step('cameras start off, and say nothing to Home Assistant until turned on', async () => {
  assert.equal((await j('GET', `${APP}/api/house`)).modules.cameras, false);
  await j('PUT', `${APP}/api/house`, { modules: { cameras: true } });
  await sleep(500);
  const st = await cam('GET', 'state');
  assert.equal(st.disabled, false);
  assert.deepEqual(st.candidates.map((c) => c.name).sort(), ['Driveway', 'Front door', 'Garden', 'Shed']);
  assert.deepEqual(st.candidates.find((c) => c.name === 'Garden'), { entity: 'camera.garden_high_resolution_channel', name: 'Garden', make: 'Ubiquiti', model: 'G5 Turret Ultra', integration: 'UniFi Protect', online: true });
});

await step('each make\'s movement sensors and own settings are found', async () => {
  for (const c of (await cam('GET', 'state')).candidates) await cam('POST', 'cameras', { entity: c.entity });
  for (const id of ['garden', 'front_door', 'driveway', 'shed']) await cam('PUT', `cameras/${id}`, { record: { seconds: 5 } }); // short clips, so they're done between checks
  const st = await cam('GET', 'state');
  const by = Object.fromEntries(st.cameras.map((c) => [c.id, c]));
  assert.deepEqual(by.garden.movement.map((m) => `${m.name}:${m.kind}`), ['Motion:movement', 'Person detected:person', 'Vehicle detected:vehicle']);
  assert.ok(!by.garden.movement.some((m) => /dark/i.test(m.name)), 'Is dark isn\'t movement');
  assert.deepEqual(by.front_door.movement.map((m) => `${m.name}:${m.kind}`), ['Ding:visitor', 'Motion:movement']);
  assert.equal(by.shed.movement.length, 0);
  const g = Object.fromEntries(by.garden.controls.map((c) => [c.name, c]));
  assert.equal(g['Privacy mode'].group, 'privacy');
  assert.deepEqual(g['Recording mode'].options, ['Always', 'Never', 'Detections']);
  assert.equal(g['Infrared mode'].group, 'night');
  assert.equal(g['Reboot device'].group, 'device');
  const d = Object.fromEntries(by.driveway.controls.map((c) => [c.name, c]));
  assert.equal(d.Floodlight.domain, 'light');
  assert.equal(d['Motion sensitivity'].max, 50);
  assert.equal(by.shed.hasStream, false);
  assert.equal(by.garden.hasStream, true);
});

await step('a camera\'s own settings can be changed from here', async () => {
  await mock('POST', '/reset-calls');
  await cam('POST', 'cameras/garden/control', { entity: 'select.garden_recording_mode', value: 'Always' });
  await cam('POST', 'cameras/garden/control', { entity: 'switch.garden_privacy_mode' });
  await cam('POST', 'cameras/driveway/control', { entity: 'number.driveway_motion_sensitivity', value: 99 });
  await sleep(400);
  const c = await calls();
  assert.deepEqual(c.map((x) => `${x.domain}.${x.service}`), ['select.select_option', 'switch.toggle', 'number.set_value']);
  assert.equal(c[2].data.value, 50, 'kept within the camera\'s range');
  const st = await cam('GET', 'state');
  assert.equal(st.cameras.find((x) => x.id === 'garden').controls.find((x) => x.name === 'Recording mode').state, 'Always');
  await assert.rejects(cam('POST', 'cameras/garden/control', { entity: 'light.driveway_floodlight' }), /doesn't belong/);
  await cam('POST', 'cameras/garden/control', { entity: 'switch.garden_privacy_mode' }); // back off
});

await step('phones to alert: the Home Assistant app phones come first; a test alert goes to the chosen ones', async () => {
  const targets = await cam('GET', 'notify-targets');
  assert.deepEqual(targets.slice(0, 2).map((x) => x.service).sort(), ['notify.mobile_app_sams_pixel_8', 'notify.mobile_app_toms_iphone']);
  assert.ok(targets.slice(0, 2).every((x) => x.phone));
  await assert.rejects(cam('POST', 'test-alert'), /Choose a phone/);
  await cam('PUT', 'settings', { notify: ['notify.mobile_app_toms_iphone', 'notify.bogus'] });
  await mock('POST', '/reset-calls');
  assert.equal((await cam('POST', 'test-alert')).sent, 1, 'one phone got it; the other isn\'t there');
  const n = (await calls('notify')).filter((x) => x.service === 'mobile_app_toms_iphone');
  assert.equal(n.length, 1);
  assert.ok((await cam('GET', 'activity')).items.some((e) => /Couldn't alert notify\.bogus/.test(e.text)), 'the failed one is noted');
  await cam('PUT', 'settings', { notify: ['notify.mobile_app_toms_iphone'] });
  assert.match(n[0].data.message, /^Test alert/);
  assert.ok(n[0].data.data.image.startsWith('/api/camera_proxy/'), 'with a picture');
});

await step('movement while someone\'s home: saved, but no alert (alerts are "when everyone\'s out" to start with)', async () => {
  await cam('PUT', 'cameras/garden', { record: { when: 'always', seconds: 6 } });
  await sleep(100);
  await mock('POST', '/reset-calls');
  await sensor('binary_sensor.garden_motion', 'on');
  await sleep(300);
  await sensor('binary_sensor.garden_person_detected', 'on');
  await sleep(3500);
  const c = await calls();
  assert.deepEqual(c.filter((x) => x.domain === 'camera').map((x) => x.service).sort(), ['record', 'snapshot']);
  const rec = c.find((x) => x.service === 'record').data;
  assert.equal(rec.duration, 6);
  assert.equal(rec.lookback, 5);
  assert.ok(rec.filename.startsWith(path.join(MEDIA, 'home_control/garden/')));
  assert.equal(c.filter((x) => x.domain === 'notify').length, 0);
  let ev = (await cam('GET', 'activity?camera=garden')).items[0];
  assert.equal(ev.text, 'Person seen', 'motion then person reads as a person');
  assert.ok(ev.picture, 'picture saved straight away');
  for (let i = 0; i < 40 && !ev.clip; i++) { await sleep(500); ev = (await cam('GET', 'activity?camera=garden')).items[0]; }
  assert.ok(ev.clip, 'clip saved once finished, and served');
  const r = await fetch(`${APP}/api/cameras/media/garden/${ev.clip}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  await sensor('binary_sensor.garden_motion', 'off'); await sensor('binary_sensor.garden_person_detected', 'off');
});

await step('when everyone\'s out (house on Away), movement alerts the phones with a picture, then waits', async () => {
  await cam('PUT', 'cameras/garden', { alerts: { cooldownMinutes: 10 } }); // 12 s here
  await j('POST', `${APP}/api/mode`, { mode: 'away' });
  await sleep(300);
  assert.equal((await cam('GET', 'state')).away, true);
  await mock('POST', '/reset-calls');
  await sensor('binary_sensor.garden_person_detected', 'on');
  await sleep(2500);
  let n = await calls('notify');
  assert.equal(n.length, 1);
  assert.equal(n[0].data.title, 'Garden');
  assert.match(n[0].data.message, /^Person seen at \d\d:\d\d$/);
  assert.equal(n[0].data.data.entity_id, 'camera.garden_high_resolution_channel');
  // straight after: no second alert (at most one every 10 minutes for this camera)
  await sensor('binary_sensor.garden_person_detected', 'off'); await sleep(200);
  await sensor('binary_sensor.garden_person_detected', 'on'); await sleep(2000);
  n = await calls('notify');
  assert.equal(n.length, 1, 'waited');
  await sensor('binary_sensor.garden_person_detected', 'off');
  await j('POST', `${APP}/api/mode`, { mode: 'auto' });
});

await step('between set times; only the movement that counts; the doorbell', async () => {
  await cam('PUT', 'cameras/driveway', { alerts: { when: 'times', from: t(-30), to: t(30) }, movement: ['binary_sensor.driveway_person'] });
  await mock('POST', '/reset-calls');
  await sensor('binary_sensor.driveway_motion', 'on'); await sleep(2500);
  assert.equal((await calls('notify')).length, 0, 'plain motion doesn\'t count on this camera');
  await sensor('binary_sensor.driveway_person', 'on'); await sleep(2500);
  assert.equal((await calls('notify')).length, 1, 'a person, inside the times');
  await sensor('binary_sensor.driveway_motion', 'off'); await sensor('binary_sensor.driveway_person', 'off');
  await cam('PUT', 'cameras/driveway', { alerts: { when: 'times', from: t(60), to: t(120) } });
  await sleep(3000); // past the wait between alerts
  await mock('POST', '/reset-calls');
  await sensor('binary_sensor.driveway_person', 'on'); await sleep(2500);
  assert.equal((await calls('notify')).length, 0, 'outside the times');
  await sensor('binary_sensor.driveway_person', 'off');
  // a Ring doorbell press is an event entity
  await cam('PUT', 'cameras/front_door', { alerts: { when: 'always' } });
  await mock('POST', '/reset-calls');
  await sensor('event.front_door_ding', new Date().toISOString()); await sleep(2500);
  const n = await calls('notify');
  assert.equal(n.length, 1);
  assert.match(n[0].data.message, /^Someone at the door at/);
});

await step('a camera with no video stream keeps pictures, and says once why there\'s no clip', async () => {
  await sleep(16000); // the doorbell's last clip has finished
  await mock('POST', '/sensor', { entity: 'camera.front_door_live_view', state: 'idle', attrs: { supported_features: 0 } });
  await mock('POST', '/reset-calls');
  await sensor('event.front_door_motion', new Date().toISOString()); await sleep(2500);
  let ev = (await cam('GET', 'activity?camera=front_door')).items;
  const notes = () => ev.filter((e) => e.type === 'note' && /Couldn't save a clip/.test(e.text));
  assert.equal(notes().length, 1, ev.map((e) => e.text).join(' | '));
  assert.match(notes()[0].text, /only pictures are kept/);
  const mv = ev.find((e) => e.type === 'movement');
  assert.ok(mv.picture, 'picture kept');
  assert.equal(mv.clip, null);
  await sensor('event.front_door_motion', new Date().toISOString()); await sleep(2500);
  ev = (await cam('GET', 'activity?camera=front_door')).items;
  assert.equal(notes().length, 1, 'said once, not every time');
  await mock('POST', '/sensor', { entity: 'camera.front_door_live_view', state: 'idle', attrs: { supported_features: 2 } });
});

await step('offline: told after the wait, and when it\'s back', async () => {
  await cam('PUT', 'settings', { offlineMinutes: 1 }); // 1.2 s here
  await mock('POST', '/reset-calls');
  await sensor('camera.shed', 'unavailable');
  await sleep(2500);
  let n = await calls('notify');
  assert.equal(n.length, 1, JSON.stringify(n));
  assert.match(n[0].data.message, /^Offline since/);
  const st = await cam('GET', 'state');
  assert.equal(st.cameras.find((c) => c.id === 'shed').online, false);
  await sensor('camera.shed', 'idle');
  await sleep(800);
  n = await calls('notify');
  assert.equal(n.length, 2);
  assert.match(n[1].data.message, /^Back online/);
  const ev = (await cam('GET', 'activity?camera=shed')).items.map((e) => e.text);
  assert.match(ev[0], /back online after/);
  assert.match(ev[1], /offline since/);
});

await step('the dashboard sensor lists every camera and the settings chosen for the card', async () => {
  await cam('PUT', 'cameras/driveway', { card: ['light.driveway_floodlight', 'siren.driveway_siren', 'not.mine'] });
  await sleep(3000);
  const s = (await mock('GET', '/published')).states['sensor.home_cameras'];
  assert.ok(s, 'sensor.home_cameras written');
  assert.equal(s.attributes.total, 4);
  assert.equal(Number(s.state), 4);
  const d = s.attributes.cameras.find((c) => c.id === 'driveway');
  assert.deepEqual(d.controls.map((c) => c.id), ['light.driveway_floodlight', 'siren.driveway_siren']);
});

await step('turned off: no alerts, no recording, and its sensor is removed', async () => {
  await j('PUT', `${APP}/api/house`, { modules: { cameras: false } });
  await mock('POST', '/reset-calls');
  await sensor('event.front_door_ding', new Date().toISOString()); await sleep(2500);
  assert.deepEqual((await calls()).filter((c) => ['notify', 'camera'].includes(c.domain)), []);
  await sleep(1500);
  assert.ok(!(await mock('GET', '/published')).states['sensor.home_cameras']);
  await assert.rejects(cam('POST', 'cameras/garden/control', { entity: 'switch.garden_privacy_mode' }), (e) => e.status === 409);
});

app.kill();
console.log(`\n${passed} camera checks passed`);
process.exit(0);
