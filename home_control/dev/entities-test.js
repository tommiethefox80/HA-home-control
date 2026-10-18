// Groups, rooms, scenes and Away as Home Assistant entities, through MQTT discovery, against the
// mock Home Assistant (which has MQTT: the mqtt.publish action, mqtt/subscribe and retained messages).
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/entities-test.js
import assert from 'node:assert/strict';

const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
};
const ent = (m, b) => j(m, `${APP}/api/ha-entities`, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const heat = (m, p, b) => j(m, `${APP}/api/${p}`, b);
const light = (m, p, b) => j(m, `${APP}/api/lighting/${p}`, b);
const retained = async () => (await mock('POST', '/mqtt', {})).retained;
const configs = async () => Object.entries(await retained()).filter(([t]) => t.endsWith('/config')).map(([t, p]) => [t, JSON.parse(p)]);
const send = (topic, payload) => mock('POST', '/mqtt-send', { topic, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }
async function until(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}
const group = async (name) => (await light('GET', 'state')).groups.find((g) => g.name === name);

await step('off to start with: nothing in MQTT', async () => {
  const v = await ent('GET');
  assert.equal(v.settings.enabled, false);
  assert.equal((await configs()).length, 0);
  // the heating part's own entity list (for its pickers) is still there
  assert.ok(Array.isArray(await j('GET', `${APP}/api/entities`)), 'heating\'s /api/entities is untouched');
});

await step('without MQTT in Home Assistant: says so, and makes nothing', async () => {
  await mock('POST', '/mqtt', { on: false });
  const v = await ent('PUT', { enabled: true });
  assert.equal(v.mqtt, false);
  assert.equal(v.entities.length, 0);
  assert.equal((await configs()).length, 0);
});

let cfg;
await step('with MQTT: a light for each group, a thermostat for each room, the scenes, Away and the heating mode', async () => {
  await mock('POST', '/mqtt', { on: true });
  const v = await ent('GET');
  assert.equal(v.mqtt, true);
  await until(async () => (await configs()).length === 12, '12 entities');
  cfg = Object.fromEntries((await configs()).map(([t, c]) => [c.unique_id, { topic: t, ...c }]));
  const lights = Object.values(cfg).filter((c) => c.topic.startsWith('homeassistant/light/home_control/'));
  assert.equal(lights.length, 6);
  const lounge = cfg.home_control_light_lounge;
  assert.equal(lounge.name, null, 'named by its device');
  assert.equal(lounge.default_entity_id, 'light.home_control_lounge');
  assert.equal(lounge.device.name, 'Lounge lights');
  assert.deepEqual(lounge.device.identifiers, ['home_control_group_lounge'], 'keyed by the group, not its name');
  assert.equal(lounge.device.suggested_area, 'Lounge', 'in the Lounge area');
  assert.deepEqual(lounge.supported_color_modes, ['color_temp']);
  assert.equal(cfg['home_control_light_christmas-lights'].device.name, 'Christmas lights', '"Christmas lights" needs no "lights" after it');
  assert.equal(cfg['home_control_light_christmas-lights'].device.suggested_area, undefined, 'no such area: not put in one');
  assert.deepEqual(cfg['home_control_light_christmas-lights'].supported_color_modes, ['onoff']);
  const rooms = Object.values(cfg).filter((c) => c.topic.startsWith('homeassistant/climate/'));
  assert.equal(rooms.length, 2);
  assert.deepEqual(rooms.map((r) => r.device.name).sort(), ['Bedroom heating', 'Lounge heating']);
  assert.ok(rooms.every((r) => r.name === null && r.device.identifiers[0].startsWith('home_control_room_')));
  assert.equal(cfg.home_control_away.device.name, 'Home Control');
  assert.deepEqual(cfg.home_control_heating_mode.options, ['Schedules', 'Away', 'Heating off']);
  assert.equal(cfg['home_control_scene_film-night'].name, 'Film night');
  assert.equal(cfg['home_control_scene_film-night'].device, undefined, 'a scene is just "Film night", not "Home Control Film night"');
  // a light's state has a colour mode only with its value (Home Assistant warns otherwise)
  for (const [t, p] of Object.entries(await retained())) {
    if (!/^home_control\/light\/.*\/state$/.test(t)) continue;
    const st = JSON.parse(p);
    if (st.color_mode === 'color_temp') assert.ok(st.color_temp > 1000, `${t}: ${p}`);
  }
  assert.deepEqual(v.entities.find((e) => e.id === 'light.home_control_lounge'), { id: 'light.home_control_lounge', name: 'Lounge lights', kind: 'light' });
  assert.equal(v.entities.find((e) => e.id === 'switch.home_control_away').name, 'Home Control Away');
  const r = await retained();
  assert.equal(r['home_control/status'], 'online');
  assert.ok(r['home_control/light/lounge/state'], 'each light has its state');
  assert.equal(v.entities.length, 12);
});

await step('a light switched in Home Assistant switches the group, and its state follows', async () => {
  await send('home_control/light/kitchen/set', { state: 'ON', brightness: 128 });
  await until(async () => { const g = await group('Kitchen'); return g.override && g.target?.on && g.target.brightness === 50; }, 'the kitchen on at 50%');
  await until(async () => { const s = JSON.parse((await retained())['home_control/light/kitchen/state']); return s.state === 'ON' && Math.abs(s.brightness - 128) <= 3; }, 'the state on at 128');
  await send('home_control/light/kitchen/set', { state: 'OFF' });
  await until(async () => (await group('Kitchen')).target?.on === false, 'the kitchen off');
  await until(async () => JSON.parse((await retained())['home_control/light/kitchen/state']).state === 'OFF', 'the state off');
  const act = (await light('GET', 'activity')).items.map((a) => a.text);
  assert.ok(act.some((t) => /^Kitchen: turned off from Home Assistant/.test(t)), act.slice(0, 4).join('\n'));
});

await step('a room\'s temperature holds until its next change; off snoozes it; heat puts it back', async () => {
  const z = (await heat('GET', 'state')).zones.find((x) => x.name === 'Lounge');
  const t = `home_control/climate/${z.id}`;
  await send(`${t}/temperature/set`, '22.5');
  await until(async () => { const x = (await heat('GET', 'state')).zones.find((y) => y.id === z.id); return x.target === 22.5 && x.source === 'hold'; }, 'a hold at 22.5');
  await until(async () => JSON.parse((await retained())[`${t}/state`]).target === 22.5, 'the state at 22.5');
  await send(`${t}/mode/set`, 'off');
  await until(async () => (await heat('GET', 'state')).zones.find((y) => y.id === z.id).source === 'snooze', 'snoozed');
  await until(async () => { const s = JSON.parse((await retained())[`${t}/state`]); return s.mode === 'off' && s.action === 'off'; }, 'the state off');
  await send(`${t}/mode/set`, 'heat');
  await until(async () => (await heat('GET', 'state')).zones.find((y) => y.id === z.id).source === 'schedule', 'back on its schedule');
  await until(async () => JSON.parse((await retained())[`${t}/state`]).mode === 'heat', 'the state heat');
});

await step('a scene, Away and the heating mode from Home Assistant', async () => {
  await send('home_control/scene/film-night/set', 'ON');
  await until(async () => (await light('GET', 'activity')).items.some((a) => /Film night/.test(a.text)), 'the scene');
  await send('home_control/away/set', 'ON');
  await until(async () => (await heat('GET', 'state')).mode === 'away' && (await light('GET', 'state')).mode === 'away', 'the house Away');
  await until(async () => (await retained())['home_control/away/state'] === 'ON', 'Away on');
  await send('home_control/away/set', 'OFF');
  await until(async () => (await heat('GET', 'state')).mode === 'auto' && (await light('GET', 'state')).mode === 'schedule', 'back on the schedules');
  await send('home_control/heating_mode/set', 'Heating off');
  await until(async () => (await heat('GET', 'state')).mode === 'off', 'heating off');
  await until(async () => (await retained())['home_control/heating_mode/state'] === 'Heating off', 'the mode state');
  await send('home_control/heating_mode/set', 'Schedules');
  await until(async () => (await heat('GET', 'state')).mode === 'auto', 'schedules');
  // nonsense is ignored
  await send('home_control/light/nope/set', { state: 'ON' });
  await send('home_control/heating_mode/set', 'Banana');
  await sleep(500);
  assert.equal((await heat('GET', 'state')).mode, 'auto');
});

await step('a group renamed here: the same device and entity, with the new name', async () => {
  await light('PUT', 'groups/kitchen', { name: 'Kitchen spots', devices: ['light.kitchen_spots', 'light.kitchen_under_cabinet'] });
  const c = await until(async () => { const x = JSON.parse((await retained())['homeassistant/light/home_control/light_kitchen/config'] || '{}'); return x.device?.name === 'Kitchen spots' ? x : null; }, 'the new name');
  assert.deepEqual(c.device.identifiers, ['home_control_group_kitchen']);
  assert.equal(c.unique_id, 'home_control_light_kitchen');
  await light('PUT', 'groups/kitchen', { name: 'Kitchen', devices: ['light.kitchen_spots', 'light.kitchen_under_cabinet'] });
});

await step('a group deleted, or rooms turned off here: removed from Home Assistant', async () => {
  await j('DELETE', `${APP}/api/lighting/groups/office`);
  await until(async () => !(await retained())['homeassistant/light/home_control/light_office/config'], 'the office light removed');
  const log = (await mock('POST', '/mqtt', {})).log;
  assert.ok(log.some((m) => m.topic === 'homeassistant/light/home_control/light_office/config' && m.payload === '' && m.retain), 'an empty retained config removes it');
  await ent('PUT', { rooms: false });
  await until(async () => !(await configs()).some(([t]) => t.startsWith('homeassistant/climate/')), 'the rooms removed');
  await ent('PUT', { rooms: true });
  await until(async () => (await configs()).filter(([t]) => t.startsWith('homeassistant/climate/')).length === 2, 'the rooms back');
});

await step('after Home Assistant reconnects, commands still work', async () => {
  await mock('POST', '/drop');
  await sleep(7000);
  await send('home_control/light/bedroom/set', { state: 'ON' });
  await until(async () => (await group('Bedroom')).target?.on === true, 'the bedroom on', 15000);
});

await step('turned off: every entity removed from Home Assistant', async () => {
  await ent('PUT', { enabled: false });
  await until(async () => (await configs()).length === 0, 'nothing left');
  const v = await ent('GET');
  assert.equal(v.entities.length, 0);
});

console.log(`\n${passed} entity checks passed`);
