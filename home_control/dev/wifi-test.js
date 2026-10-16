// Wi-Fi: a UniFi network as the UniFi Network integration sets it up in Home Assistant (a gateway,
// a PoE switch, three access points, three networks, clients, entities Home Assistant turns off to
// start with), switched from here and on schedules. Runs its own copy of the app (port 8096,
// minutes sped up) against the mock Home Assistant from dev/run.sh, on a fresh mock.
//   sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/wifi-test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zonedParts, minutesToTime } from '../server/src/lighting/schedule.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = 'http://localhost:8096'; const MOCK = 'http://localhost:8124';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || r.status), { status: r.status });
  return d;
};
const wifi = (m, p, b) => j(m, `${APP}/api/wifi/${p}`, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const calls = async (domain) => (await mock('GET', '/calls')).filter((c) => !domain || c.domain === domain);
const states = () => mock('GET', '/states');
const t = (d) => minutesToTime((zonedParts(Date.now(), 'Europe/London').minutes + d + 1440) % 1440);
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }

let app;
async function startApp() {
  app = spawn('node', [path.join(HERE, '../server/src/index.js')], {
    env: { ...process.env, HA_URL: 'http://localhost:8123', HA_TOKEN: 'dev', DATA_DIR: DATA, PORT: '8096', HC_TIME_SCALE: '0.02', HA_CONFIG_DIR: path.join(DATA, 'none'), MEDIA_DIR: path.join(DATA, 'media') },
    stdio: ['ignore', fs.openSync(path.join(DATA, 'app.log'), 'a'), fs.openSync(path.join(DATA, 'app.log'), 'a')],
  });
  for (let i = 0; i < 40; i++) { try { await fetch(`${APP}/api/house`); break; } catch { await sleep(250); } }
  await sleep(1500);
}
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });
await startApp();
const LOUNGE = '70a741000011'; const GARDEN = '70a741000013';
const HOME = '64b0a1c2d3e4f5a6b7c8d901'; const GUEST = '64b0a1c2d3e4f5a6b7c8d902';

await step('Wi-Fi starts off, and changes nothing until turned on', async () => {
  assert.equal((await j('GET', `${APP}/api/house`)).modules.wifi, false);
  await assert.rejects(wifi('POST', `devices/${LOUNGE}/led`, { on: false }), (e) => e.status === 409);
  assert.ok(!(await mock('GET', '/published')).states['sensor.home_wifi']);
  await j('PUT', `${APP}/api/house`, { modules: { wifi: true } });
  await sleep(800);
});

await step('access points, other devices, networks and who\'s connected are found from the UniFi integration', async () => {
  const s = await wifi('GET', 'state');
  assert.equal(s.unifi, true);
  assert.deepEqual(s.aps.map((a) => `${a.name}:${a.modelName}:${a.online}:${a.clients}`), ['Garden AP:U6 LR:true:1', 'Lounge AP:U6 Lite:true:3', 'Upstairs AP:U6 Pro:true:2']);
  assert.deepEqual(s.others.map((a) => `${a.name}:${a.kind}`), ['Dream Machine Pro:gateway', 'Office switch:switch']);
  assert.equal(s.aps.find((a) => a.name === 'Garden AP').update, '6.7.10');
  assert.deepEqual(s.networks.map((n) => `${n.name}:${n.on}:${n.clients}`), ['Fox Guest:true:1', 'Fox Home:true:4', 'Fox IoT:true:2']);
  const c = Object.fromEntries(s.clients.map((x) => [x.name, x]));
  assert.equal(s.clients.filter((x) => x.connected).length, 7);
  assert.deepEqual([c["Tom's iPhone"].network, c["Tom's iPhone"].ap, c["Tom's iPhone"].band], ['Fox Home', 'Lounge AP', '5 GHz']);
  assert.equal(c['Hue Bridge'].wired, true);
  assert.equal(c['Galaxy S24'].guest, true);
  assert.equal(c['Work laptop'].connected, false);
  assert.equal(c["Sam's iPad"].block, 'switch.sams_ipad_block');
  assert.ok(!s.clients.some((x) => x.name === 'Lounge AP'), 'the access points themselves aren\'t clients');
  assert.equal(s.untracked, 5);
  await sleep(6000);
  const pub = (await mock('GET', '/published')).states['sensor.home_wifi'];
  assert.equal(pub.state, '7');
  assert.equal(pub.attributes.summary, '3 access points online · 7 devices connected');
  assert.deepEqual(pub.attributes.networks.map((n) => n.entity), ['switch.fox_guest', 'switch.fox_home', 'switch.fox_iot']);
});

await step('a status light, all the lights, and a network switched from here', async () => {
  await mock('POST', '/reset-calls');
  await wifi('POST', `devices/${LOUNGE}/led`, { on: false });
  await sleep(400);
  assert.equal((await states())['light.lounge_ap_led'].state, 'off');
  const r = await wifi('POST', 'leds', { on: false });
  assert.equal(r.changed, 2, 'Upstairs AP and the switch (Garden AP\'s was already off)');
  await sleep(400);
  const st = await states();
  assert.deepEqual(['light.lounge_ap_led', 'light.upstairs_ap_led', 'light.garden_ap_led', 'light.office_switch_led'].map((x) => st[x].state), ['off', 'off', 'off', 'off']);
  await wifi('POST', `networks/${GUEST}/power`, { on: false });
  await sleep(400);
  assert.equal((await states())['switch.fox_guest'].state, 'off');
  assert.equal((await wifi('GET', 'state')).networks.find((n) => n.id === GUEST).on, false);
  await wifi('POST', `networks/${GUEST}/power`, { on: true });
  const ev = (await wifi('GET', 'activity')).items.map((e) => e.text);
  assert.match(ev[0], /Fox Guest turned on here/);
  assert.match(ev[2], /^Status lights off on (Upstairs AP and Office switch|Office switch and Upstairs AP)\.$/);
  assert.deepEqual((await calls('light')).map((c) => `${c.service} ${c.data.entity_id}`).sort(), ['turn_off light.lounge_ap_led', 'turn_off light.office_switch_led', 'turn_off light.upstairs_ap_led']);
});

await step('status lights off at night: made once at its time, then a light switched by hand is left alone', async () => {
  await wifi('POST', 'leds', { on: true });
  await sleep(400);
  await mock('POST', '/reset-calls');
  // the night started a minute ago
  await wifi('PUT', 'settings', { leds: { mode: 'off_between', from: t(-1), to: t(60) } });
  await sleep(1000);
  let st = await states();
  assert.deepEqual(['light.lounge_ap_led', 'light.upstairs_ap_led', 'light.garden_ap_led', 'light.office_switch_led'].map((x) => st[x].state), ['off', 'off', 'off', 'off']);
  await sleep(1600); // the schedule's one line in Activity
  assert.match((await wifi('GET', 'activity')).items[0].text, /^Status lights off on .+ \(schedule, \d\d:\d\d\)\.$/);
  // switched back on by hand: left alone until the next change
  await wifi('POST', `devices/${LOUNGE}/led`, { on: true });
  await sleep(1500); // a few schedule ticks
  assert.equal((await states())['light.lounge_ap_led'].state, 'on');
  // only some devices: the others aren't touched
  await wifi('PUT', 'settings', { leds: { devices: [GARDEN] } });
  await sleep(800);
  st = await states();
  assert.equal(st['light.lounge_ap_led'].state, 'on');
  const s = await wifi('GET', 'state');
  assert.deepEqual(s.aps.filter((a) => a.ledScheduled).map((a) => a.name), ['Garden AP']);
  // the morning (on again): made at its time
  await wifi('PUT', 'settings', { leds: { from: t(-90), to: t(-1), devices: null } });
  await sleep(1000);
  st = await states();
  assert.deepEqual(['light.upstairs_ap_led', 'light.garden_ap_led'].map((x) => st[x].state), ['on', 'on']);
  await wifi('PUT', 'settings', { leds: { mode: 'none' } });
});

await step('a guest network on only in the day; a network off at night', async () => {
  await mock('POST', '/reset-calls');
  await wifi('PUT', `networks/${GUEST}`, { schedule: { mode: 'on_between', from: t(30), to: t(-1) } });
  await sleep(1000);
  assert.equal((await states())['switch.fox_guest'].state, 'off');
  await wifi('PUT', `networks/${GUEST}`, { schedule: { mode: 'on_between', from: t(-1), to: t(30) } });
  await sleep(1000);
  assert.equal((await states())['switch.fox_guest'].state, 'on');
  assert.match((await wifi('GET', 'activity')).items[0].text, /^Fox Guest turned on \(schedule, \d\d:\d\d\)\.$/);
  await wifi('PUT', `networks/${HOME}`, { schedule: { mode: 'off_between', from: t(-1), to: t(30) } });
  await sleep(1000);
  assert.equal((await states())['switch.fox_home'].state, 'off');
  const view = await wifi('GET', 'settings');
  assert.deepEqual(view.networks.find((n) => n.id === HOME).schedule, { mode: 'off_between', from: t(-1), to: t(30) });
  await assert.rejects(wifi('PUT', `networks/${HOME}`, { schedule: { mode: 'off_between', from: '22:00', to: '22:00' } }), /different/);
  await wifi('PUT', `networks/${HOME}`, { schedule: { mode: 'none' } });
  await wifi('POST', `networks/${HOME}/power`, { on: true });
  await wifi('PUT', `networks/${GUEST}`, { schedule: { mode: 'none' } });
});

await step('an access point switched off through its PoE port; a port Home Assistant had turned off is turned on first', async () => {
  const view = await wifi('GET', 'settings');
  const lounge = view.devices.find((d) => d.name === 'Lounge AP');
  assert.ok(lounge.poeChoices[0].uplink, 'the ports on the switch it\'s plugged into come first');
  assert.equal(lounge.poeChoices.length, 8);
  await assert.rejects(wifi('POST', `devices/${LOUNGE}/power`, { on: false }), /Choose the PoE port/);
  await wifi('PUT', `devices/${LOUNGE}`, { poe: 'switch.office_switch_port_3_poe' });
  await mock('POST', '/reset-calls');
  await wifi('POST', `devices/${LOUNGE}/power`, { on: false });
  await sleep(400);
  assert.equal((await states())['switch.office_switch_port_3_poe'].state, 'off');
  let s = await wifi('GET', 'state');
  assert.equal(s.aps.find((a) => a.name === 'Lounge AP').switchedOff, true);
  await wifi('POST', `devices/${LOUNGE}/power`, { on: true });
  // Garden AP on port 5, which Home Assistant keeps turned off to start with
  await wifi('PUT', `devices/${GARDEN}`, { poe: 'switch.office_switch_port_5_poe' });
  assert.deepEqual((await calls('entity_registry')).map((c) => c.data), [{ entity_id: 'switch.office_switch_port_5_poe', disabled_by: null }]);
  await sleep(3500);
  s = await wifi('GET', 'state');
  assert.equal(s.aps.find((a) => a.name === 'Garden AP').power.enabled, true);
  // off at night
  await wifi('PUT', `devices/${GARDEN}`, { schedule: { mode: 'off_between', from: t(-1), to: t(30) } });
  await sleep(1000);
  assert.equal((await states())['switch.office_switch_port_5_poe'].state, 'off');
  await assert.rejects(wifi('PUT', `devices/${GARDEN}`, { schedule: { mode: 'on_between', from: '08:00', to: '20:00' } }), /switched off between/);
  await wifi('PUT', `devices/${GARDEN}`, { schedule: { mode: 'none' } });
  await wifi('POST', `devices/${GARDEN}/power`, { on: true });
});

await step('restart, block a device, track the ones Home Assistant doesn\'t, and the QR code to join', async () => {
  await mock('POST', '/reset-calls');
  await wifi('POST', `devices/${LOUNGE}/restart`);
  assert.deepEqual((await calls('button')).map((c) => c.data.entity_id), ['button.lounge_ap_restart']);
  await wifi('POST', 'clients/block', { entity: 'device_tracker.sams_ipad', blocked: true });
  await sleep(400);
  let s = await wifi('GET', 'state');
  assert.equal(s.clients.find((c) => c.name === "Sam's iPad").blocked, true);
  await wifi('POST', 'clients/block', { entity: 'device_tracker.sams_ipad', blocked: false });
  await assert.rejects(wifi('POST', 'clients/block', { entity: 'device_tracker.toms_iphone', blocked: true }), /can't be blocked/);
  const r = await wifi('POST', 'track-all');
  assert.equal(r.turnedOn, 5);
  await sleep(3500);
  s = await wifi('GET', 'state');
  assert.equal(s.untracked, 0);
  assert.equal(s.clients.filter((c) => c.connected).length, 12);
  assert.equal(s.aps.find((a) => a.name === 'Garden AP').clients, 6);
  // the QR code: turned off in Home Assistant to start with
  assert.deepEqual(s.networks.find((n) => n.id === GUEST).qr, { enabled: false, byUser: false });
  assert.equal((await fetch(`${APP}/api/wifi/networks/${GUEST}/qr.png`)).status, 404);
  await wifi('POST', `networks/${GUEST}/qr`);
  await sleep(3500);
  const img = await fetch(`${APP}/api/wifi/networks/${GUEST}/qr.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

await step('turned off: nothing switched, no schedules, and its sensor is removed', async () => {
  await wifi('PUT', 'settings', { leds: { mode: 'off_between', from: t(-1), to: t(60) } });
  await sleep(800);
  await wifi('POST', 'leds', { on: true });
  await sleep(300);
  await j('PUT', `${APP}/api/house`, { modules: { wifi: false } });
  await mock('POST', '/reset-calls');
  await wifi('PUT', 'settings', { leds: { from: t(-2) } }); // a schedule change would apply now if it were on
  await sleep(1500);
  assert.deepEqual(await calls('light'), []);
  await assert.rejects(wifi('POST', `networks/${GUEST}/power`, { on: false }), (e) => e.status === 409);
  await sleep(1500);
  assert.ok(!(await mock('GET', '/published')).states['sensor.home_wifi']);
});

app.kill();
console.log(`\n${passed} Wi-Fi checks passed`);
process.exit(0);
