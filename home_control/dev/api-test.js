// End-to-end API tests against the mock HA. Run: sh dev/run.sh && node dev/api-test.js
import assert from 'node:assert/strict';
import { zonedParts, minutesToTime } from '../server/src/lighting/schedule.js';

const APP = 'http://localhost:8099';
const MOCK = 'http://localhost:8124';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status, data });
  return data;
};
const app = (m, p, b) => j(m, APP + p, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const states = () => mock('GET', '/states');
const group = async (id) => (await app('GET', '/api/lighting/state')).groups.find((g) => g.id === id);

// Save a schedule, then "Back to schedule" so it applies straight away (saving alone waits for the next change).
const schedule = async (id, body) => {
  const r = await app('PUT', `/api/lighting/schedules/${id}`, body);
  await app('POST', `/api/lighting/groups/${id}/resume`);
  return r;
};

let passed = 0;
async function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  passed++;
  console.log('ok');
}

const nowMin = zonedParts(Date.now(), 'Europe/London').minutes;
const t = (delta) => minutesToTime(Math.max(0, Math.min(1439, nowMin + delta)));
const everyDay = (pts) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, pts]));

await step('settings validate and save', async () => {
  const r = await app('PUT', '/api/lighting/settings', { graceSeconds: 5, defaultTransition: 1, dashboardPath: '//evil', stepSize: 7 });
  assert.equal(r.settings.graceSeconds, 5);
  assert.equal(r.settings.dashboardPath, '/');
  assert.equal(r.settings.stepSize, 10);
  // each light and socket: off to start with, on the page and the card separately
  assert.deepEqual(r.settings.showDevices, { page: false, card: false });
  const r2 = await app('PUT', '/api/lighting/settings', { showDevices: { page: 'yes', card: 0 } });
  assert.deepEqual(r2.settings.showDevices, { page: true, card: false });
  assert.deepEqual((await app('GET', '/api/lighting/state')).settings.showDevices, { page: true, card: false });
  await app('PUT', '/api/lighting/settings', { showDevices: { page: false, card: false } });
});

await step('groups are created, validated and devices are exclusive', async () => {
  await assert.rejects(app('POST', '/api/lighting/groups', { name: '  ' }), /name/);
  const a = await app('POST', '/api/lighting/groups', { name: 'Lounge', devices: ['light.lounge_ceiling', 'light.lounge_lamp', 'switch.lounge_uplighter_plug', 'sensor.bad', 'nonsense'] });
  assert.deepEqual(a.group.devices, ['light.lounge_ceiling', 'light.lounge_lamp', 'switch.lounge_uplighter_plug']);
  await app('POST', '/api/lighting/groups', { name: 'Hallway', devices: ['light.hallway', 'light.lounge_lamp'], motion: { entity: 'binary_sensor.hallway_motion', minutes: 1, brightness: 80 }, lux: { entity: 'sensor.hallway_illuminance', threshold: 50 } });
  const st = await app('GET', '/api/lighting/state');
  assert.deepEqual(st.groups.find((g) => g.id === 'lounge').devices.map((d) => d.id), ['light.lounge_ceiling', 'switch.lounge_uplighter_plug']);
  await app('PUT', '/api/lighting/groups/hallway', { name: 'Hallway', devices: ['light.hallway'], motion: { entity: 'binary_sensor.hallway_motion', minutes: 1, brightness: 80 }, lux: { entity: 'sensor.hallway_illuminance', threshold: 50 } });
  await app('PUT', '/api/lighting/groups/lounge', { name: 'Lounge', devices: ['light.lounge_ceiling', 'light.lounge_lamp', 'switch.lounge_uplighter_plug'] });
  await app('POST', '/api/lighting/groups', { name: 'Christmas lights', devices: ['switch.christmas_tree_plug', 'switch.garden_festoon_socket'] });
  const st2 = await app('GET', '/api/lighting/state');
  assert.deepEqual(st2.groups.map((g) => g.id), ['lounge', 'hallway', 'christmas-lights']);
  assert.equal(st2.groups.find((g) => g.id === 'christmas-lights').dimmable, false);
});

await step('an empty schedule leaves things alone', async () => {
  const g = await group('lounge');
  assert.equal(g.source, 'none');
  assert.match(g.status.text, /No schedule/);
  assert.equal((await states())['light.lounge_lamp'].state, 'on');
});

await step('schedule turns the group on with brightness and colour temperature', async () => {
  await mock('POST', '/reset-calls');
  const r = await schedule('lounge', { week: everyDay([{ time: t(-60), on: true, brightness: 40, kelvin: 2700 }, { time: t(120), on: false }, { time: '99:99', on: true }]) });
  assert.equal(r.schedules.lounge[0].length, 2);
  await sleep(3500);
  const s = await states();
  assert.equal(s['light.lounge_ceiling'].state, 'on');
  assert.equal(Math.round(s['light.lounge_ceiling'].brightness / 2.55), 40);
  assert.equal(s['light.lounge_ceiling'].kelvin, 2700);
  assert.equal(Math.round(s['light.lounge_lamp'].brightness / 2.55), 40);
  assert.equal(s['switch.lounge_uplighter_plug'].state, 'on');
  const calls = await mock('GET', '/calls');
  const plug = calls.find((c) => [].concat(c.data.entity_id).includes('switch.lounge_uplighter_plug'));
  assert.equal(plug.domain, 'switch');
  assert.equal(plug.data.brightness_pct, undefined);
  const lamp = calls.find((c) => [].concat(c.data.entity_id).includes('light.lounge_lamp'));
  assert.equal(lamp.data.color_temp_kelvin, undefined, 'no kelvin for a brightness-only light');
  const g = await group('lounge');
  assert.match(g.status.text, /On schedule\. Turns off at/);
});

await step('saving a schedule leaves lights as they are until its next change', async () => {
  // Tom's Backroom test: light on, at 08:10 save "off at 08:11". Nothing should change until 08:11.
  await app('POST', '/api/lighting/groups', { name: 'Backroom', devices: ['switch.kettle_plug'] });
  await mock('POST', '/human', { entity: 'switch.kettle_plug', on: true });
  await sleep(500);
  await mock('POST', '/reset-calls');
  // at least a minute away, worked out now (the run takes a few minutes, so t() from the start can be too close)
  const soon = minutesToTime((zonedParts(Date.now(), 'Europe/London').minutes + 2) % 1440);
  await app('PUT', '/api/lighting/schedules/backroom', { week: everyDay([{ time: soon, on: false }]) });
  await sleep(4000);
  assert.equal((await states())['switch.kettle_plug'].state, 'on', 'still on after saving');
  assert.equal((await mock('GET', '/calls')).filter((c) => JSON.stringify(c.data).includes('kettle')).length, 0, 'nothing sent');
  const g = await group('backroom');
  assert.match(g.status.text, /^Left as it is until \d\d:\d\d, then the new schedule takes over$/, g.status.text);
  // "Back to schedule" applies it now
  await app('POST', '/api/lighting/groups/backroom/resume');
  await sleep(2500);
  assert.equal((await states())['switch.kettle_plug'].state, 'off');
  await app('DELETE', '/api/lighting/groups/backroom');
});

await step('commands are only sent when a device differs', async () => {
  await mock('POST', '/reset-calls');
  await sleep(16000); // one full tick
  assert.equal((await mock('GET', '/calls')).length, 0);
});

await step('a change at the wall switch holds until the next scheduled change', async () => {
  await mock('POST', '/reset-calls');
  await mock('POST', '/human', { entity: 'light.lounge_lamp', on: false });
  await sleep(700);
  const g = await group('lounge');
  assert.equal(g.override.type, 'manual');
  assert.match(g.status.text, /Changed at the switch until \d\d:\d\d/);
  await sleep(16000);
  const calls = await mock('GET', '/calls');
  assert.equal(calls.length, 0, 'must not fight the person');
  const act = await app('GET', '/api/lighting/activity');
  assert.match(act.items[0].text, /Lounge: Lamp turned off at the switch\. Leaving it until/);
});

await step('a change in the HA app names the person', async () => {
  await mock('POST', '/human', { entity: 'light.lounge_ceiling', on: true, brightness: 90, user: 'u1' });
  await sleep(500);
  const act = await app('GET', '/api/lighting/activity');
  assert.match(act.items[0].text, /Ceiling set to 90% by Tom/);
});

await step('back to schedule restores the scheduled state', async () => {
  await app('POST', '/api/lighting/groups/lounge/resume');
  await sleep(3500);
  const s = await states();
  assert.equal(s['light.lounge_lamp'].state, 'on');
  assert.equal(Math.round(s['light.lounge_ceiling'].brightness / 2.55), 40);
  assert.equal((await group('lounge')).override, null);
});

await step('setting the group here holds until the next change', async () => {
  await app('POST', '/api/lighting/groups/lounge/set', { brightness: 70 });
  await sleep(3500);
  const s = await states();
  assert.equal(Math.round(s['light.lounge_lamp'].brightness / 2.55), 70);
  assert.equal(s['light.lounge_ceiling'].kelvin, 2700, 'keeps the colour temperature');
  const g = await group('lounge');
  assert.equal(g.override.type, 'hold');
  assert.match(g.status.text, /Set here until/);
});

await step('quick brightness presses are not mistaken for someone at the switch', async () => {
  for (const b of [50, 60, 70, 80]) { await app('POST', '/api/lighting/groups/lounge/set', { brightness: b }); await sleep(250); }
  await sleep(4000);
  const g = await group('lounge');
  assert.equal(g.override?.type, 'hold', `expected a hold, got ${g.override?.type} (${g.status.text})`);
  const s = await states();
  assert.equal(Math.round(s['light.lounge_lamp'].brightness / 2.55), 80);
  assert.equal(Math.round(s['light.lounge_ceiling'].brightness / 2.55), 80);
  const act = await app('GET', '/api/lighting/activity');
  assert.ok(!act.items.slice(0, 6).some((i) => /at the switch/.test(i.text)), 'no false manual change in the log');
});

await step('while a change is settling, the app shows what was asked for', async () => {
  await app('POST', '/api/lighting/groups/lounge/set', { brightness: 30 });
  await sleep(500); // devices are mid-transition now
  const g = await group('lounge');
  assert.equal(g.current.brightness, 30, `shown ${g.current.brightness}`);
  assert.ok(g.devices.every((d) => d.kind !== 'light' || d.brightness === 30));
  await sleep(3000);
});

await step('a timer on one light leaves the others alone', async () => {
  await app('POST', '/api/lighting/groups/lounge/set', { device: 'light.lounge_ceiling', kelvin: 4000, minutes: 30 });
  await sleep(3500);
  const s = await states();
  assert.equal(s['light.lounge_ceiling'].kelvin, 4000);
  assert.equal(Math.round(s['light.lounge_lamp'].brightness / 2.55), 30, 'the lamp keeps the last group setting');
  assert.equal((await group('lounge')).override.type, 'timer');
});

await step('bad input is refused with a plain message', async () => {
  await assert.rejects(app('POST', '/api/lighting/groups/nope/set', { on: true }), /no longer exists/);
  await assert.rejects(app('POST', '/api/lighting/mode', { mode: 'party' }), /Unknown mode/);
  await assert.rejects(app('POST', '/api/lighting/groups/lounge/set', { device: 'light.porch', on: true }), /isn't in this group/);
});

await step('All off is a one-press action: everything off until its next change, schedules keep running', async () => {
  await app('POST', '/api/lighting/scenes/all-off/run');
  await sleep(4000);
  const s = await states();
  for (const id of ['light.lounge_ceiling', 'light.lounge_lamp', 'switch.lounge_uplighter_plug']) assert.equal(s[id].state, 'off', id);
  const st = await app('GET', '/api/lighting/state');
  assert.equal(st.mode, 'schedule', 'not a mode any more');
  const g = st.groups.find((x) => x.id === 'lounge');
  assert.match(g.status.text, /^All off until \d\d:\d\d/, g.status.text);
  assert.ok(g.override.until, 'ends at the next scheduled change');
  assert.match((await app('GET', '/api/lighting/activity')).items[0].text, /^All off: everything switched off until its next scheduled change\./);
  // older scripts and dashboards that set the mode to "off" get the same action
  await app('POST', '/api/lighting/groups/lounge/resume');
  await sleep(3000);
  await app('POST', '/api/lighting/mode', { mode: 'off' });
  await sleep(3000);
  assert.equal((await app('GET', '/api/lighting/state')).mode, 'schedule');
  assert.equal((await states())['light.lounge_lamp'].state, 'off');
  for (const id of ['lounge', 'hallway', 'christmas-lights']) await app('POST', `/api/lighting/groups/${id}/resume`);
  await sleep(4000);
  assert.equal((await states())['light.lounge_lamp'].state, 'on');
});

await step('sockets follow schedules', async () => {
  await schedule('christmas-lights', { week: everyDay([{ time: t(-5), on: true }, { time: t(180), on: false }]) });
  await sleep(4000);
  const s = await states();
  assert.equal(s['switch.christmas_tree_plug'].state, 'on');
  assert.equal(s['switch.garden_festoon_socket'].state, 'on');
});

await step('movement turns the hallway on when it is dark', async () => {
  await mock('POST', '/sensor', { entity: 'binary_sensor.hallway_motion', state: 'on' });
  await sleep(1500);
  assert.equal(Math.round((await states())['light.hallway'].brightness / 2.55), 80);
  assert.match((await group('hallway')).status.text, /On for movement until/);
  await mock('POST', '/sensor', { entity: 'binary_sensor.hallway_motion', state: 'off' });
});

await step('copying a schedule to other groups', async () => {
  const r = await app('POST', '/api/lighting/schedules/lounge/copy', { to: ['hallway'] });
  assert.equal(r.copied, 1);
  assert.deepEqual(r.schedules.hallway, r.schedules.lounge);
  await assert.rejects(app('POST', '/api/lighting/schedules/lounge/copy', { to: [] }), /at least one/);
});

await step('it is bright enough, so the schedule does not switch on', async () => {
  // take motion out of the picture for this check
  await app('PUT', '/api/lighting/groups/hallway', { name: 'Hallway', devices: ['light.hallway'], lux: { entity: 'sensor.hallway_illuminance', threshold: 50 } });
  await schedule('hallway', { week: everyDay([{ time: t(-30), on: false }, { time: t(240), on: true }]) });
  await sleep(2000);
  assert.equal((await states())['light.hallway'].state, 'off');
  await mock('POST', '/sensor', { entity: 'sensor.hallway_illuminance', state: '500' });
  await sleep(500);
  await schedule('hallway', { week: everyDay([{ time: t(-30), on: true, brightness: 50 }, { time: t(240), on: false }]) });
  await sleep(2500);
  assert.equal((await states())['light.hallway'].state, 'off');
  assert.match((await group('hallway')).status.text, /Bright enough/);
  await mock('POST', '/sensor', { entity: 'sensor.hallway_illuminance', state: '10' });
  await sleep(2500);
  assert.equal((await states())['light.hallway'].state, 'on');
});

await step('history for the chart has 5-minute buckets and motion bands', async () => {
  await app('PUT', '/api/lighting/groups/hallway', { name: 'Hallway', devices: ['light.hallway'], motion: { entity: 'binary_sensor.hallway_motion', minutes: 1, brightness: 80 }, lux: { entity: 'sensor.hallway_illuminance', threshold: 50 } });
  const h = await app('GET', '/api/lighting/history/hallway');
  assert.equal(h.points.length, 289);
  assert.ok(h.bands.length >= 3);
  assert.ok(h.points.some((p) => p.actual > 0));
});

await step('away keeps non lived-in groups off', async () => {
  await app('PUT', '/api/lighting/groups/christmas-lights', { name: 'Christmas lights', devices: ['switch.christmas_tree_plug', 'switch.garden_festoon_socket'], livedIn: false });
  await app('POST', '/api/lighting/mode', { mode: 'away' });
  await sleep(4500);
  assert.equal((await states())['switch.christmas_tree_plug'].state, 'off');
  assert.match((await group('christmas-lights')).status.text, /Away\. Kept off/);
  await app('POST', '/api/lighting/mode', { mode: 'schedule' });
});

await step('the power button uses the scheduled level for the time of day', async () => {
  // no movement sensor here: its stay-on time from the earlier check could still be running
  await app('PUT', '/api/lighting/groups/hallway', { name: 'Hallway', devices: ['light.hallway'] });
  await sleep(3000); // let the previous step's commands land
  await schedule('hallway', { week: everyDay([{ time: t(-120), on: true, brightness: 25, kelvin: 2200 }, { time: t(-60), on: false }]) });
  await sleep(4000);
  assert.equal((await states())['light.hallway'].state, 'off');
  assert.equal((await group('hallway')).turnOn.brightness, 25);
  await app('POST', '/api/lighting/groups/hallway/set', { on: true });
  await sleep(2500);
  assert.equal(Math.round((await states())['light.hallway'].brightness / 2.55), 25);
  // an "on" change due within the hour wins
  await schedule('hallway', { week: everyDay([{ time: t(-120), on: true, brightness: 25 }, { time: t(-60), on: false }, { time: t(30), on: true, brightness: 80 }]) });
  await sleep(2500);
  const g = await group('hallway');
  assert.equal(g.turnOn.brightness, 80);
  assert.match(g.turnOn.note, /due at/);
  await app('POST', '/api/lighting/groups/hallway/set', { on: true });
  await sleep(2500);
  assert.equal(Math.round((await states())['light.hallway'].brightness / 2.55), 80);
});

await step("without a schedule, the group's own turn-on level is used", async () => {
  await app('POST', '/api/lighting/groups', { name: 'Office', devices: ['light.office_desk'], onBrightness: 40 });
  await app('POST', '/api/lighting/groups/office/set', { on: true });
  await sleep(2500);
  assert.equal(Math.round((await states())['light.office_desk'].brightness / 2.55), 40);
  assert.equal((await group('office')).turnOn.note, "this group's usual level");
});

await step('a Goodnight scene is there from the start and turns everything off until the morning', async () => {
  const st = await app('GET', '/api/lighting/state');
  assert.ok(st.scenes.some((x) => x.id === 'goodnight'));
  await app('POST', '/api/lighting/scenes/goodnight/run');
  await sleep(3500);
  const s = await states();
  for (const id of ['light.lounge_ceiling', 'light.lounge_lamp', 'light.hallway', 'switch.christmas_tree_plug', 'light.office_desk']) assert.equal(s[id].state, 'off', id);
  const g = await group('lounge');
  assert.match(g.status.text, /^Goodnight until \d\d:\d\d tomorrow$/, g.status.text);
});

await step('scenes can be made, set levels, leave groups alone and use timers', async () => {
  await assert.rejects(app('POST', '/api/lighting/scenes', { name: ' ' }), /name/);
  const r = await app('POST', '/api/lighting/scenes', {
    name: 'Film night', until: 'next', others: 'leave',
    groups: { lounge: { action: 'on', brightness: 20, kelvin: 2200 }, hallway: { action: 'on', brightness: 5, minutes: 1 }, nope: { action: 'on' } },
  });
  assert.equal(r.scene.id, 'film-night');
  assert.deepEqual(Object.keys(r.scene.groups).sort(), ['hallway', 'lounge']);
  await assert.rejects(app('POST', '/api/lighting/scenes', { name: 'film night' }), /already/);
  await app('POST', '/api/lighting/scenes/film-night/run');
  await sleep(3500);
  const s = await states();
  assert.equal(Math.round(s['light.lounge_lamp'].brightness / 2.55), 20);
  assert.equal(s['light.lounge_ceiling'].kelvin, 2200);
  assert.equal(Math.round(s['light.hallway'].brightness / 2.55), 5);
  assert.equal(s['light.office_desk'].state, 'off', 'groups not in the scene are left alone');
  assert.equal((await group('hallway')).override.type, 'timer');
  assert.match((await group('lounge')).status.text, /^Film night until/);
});

await step('Home Assistant can run a scene and change the mode with an event', async () => {
  await mock('POST', '/fire', { event_type: 'lighting_control_scene', data: { scene: 'goodnight' } });
  await sleep(1500);
  const act = await app('GET', '/api/lighting/activity');
  assert.match(act.items[0].text, /^Goodnight \(from Home Assistant\)/);
  await mock('POST', '/fire', { event_type: 'lighting_control_mode', data: { mode: 'away' } });
  await sleep(800);
  assert.equal((await app('GET', '/api/lighting/state')).mode, 'away');
  await mock('POST', '/fire', { event_type: 'lighting_control_scene', data: { scene: 'party' } });
  await sleep(800);
  assert.match((await app('GET', '/api/lighting/activity')).items[0].text, /no scene called "party"/);
  await mock('POST', '/fire', { event_type: 'lighting_control_mode', data: { mode: 'schedules' } });
  await sleep(800);
  assert.equal((await app('GET', '/api/lighting/state')).mode, 'schedule');
});

await step('a seasonal schedule sleeps outside its dates', async () => {
  await app('PUT', '/api/lighting/groups/christmas-lights', { name: 'Christmas lights', devices: ['switch.christmas_tree_plug', 'switch.garden_festoon_socket'], season: { from: '12-01', to: '01-06' } });
  await app('POST', '/api/lighting/groups/christmas-lights/resume');
  await sleep(1000);
  let g = await group('christmas-lights');
  assert.equal(g.source, 'none');
  assert.match(g.status.text, /^Schedule sleeping until 1 December/);
  assert.equal(g.season.active, false);
  await mock('POST', '/reset-calls');
  await mock('POST', '/human', { entity: 'switch.christmas_tree_plug', on: true });
  await sleep(16000);
  assert.equal((await mock('GET', '/calls')).filter((c) => JSON.stringify(c.data).includes('christmas')).length, 0, 'left alone');
  assert.equal((await group('christmas-lights')).override, null, 'no hold needed: it is not being managed');
  // a season that includes today wakes the schedule up
  const today = new Date();
  const md = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await app('PUT', '/api/lighting/groups/christmas-lights', { name: 'Christmas lights', devices: ['switch.christmas_tree_plug', 'switch.garden_festoon_socket'], season: { from: md(new Date(today - 86400000 * 3)), to: md(new Date(+today + 86400000 * 3)) } });
  await sleep(1000);
  g = await group('christmas-lights');
  assert.equal(g.season.active, true);
  assert.equal(g.source, 'schedule');
});

await step('movement uses the night level inside the night window', async () => {
  await app('POST', '/api/lighting/groups/hallway/resume');
  await schedule('hallway', { week: everyDay([{ time: t(-90), on: false }]) });
  await app('PUT', '/api/lighting/groups/hallway', { name: 'Hallway', devices: ['light.hallway'], motion: { entity: 'binary_sensor.hallway_motion', minutes: 1, brightness: 60, night: { brightness: 7, from: t(-30), to: t(30) } } });
  await sleep(2500);
  await mock('POST', '/sensor', { entity: 'binary_sensor.hallway_motion', state: 'on' });
  await sleep(2000);
  assert.equal(Math.round((await states())['light.hallway'].brightness / 2.55), 7);
  await mock('POST', '/sensor', { entity: 'binary_sensor.hallway_motion', state: 'off' });
  await app('PUT', '/api/lighting/groups/hallway', { name: 'Hallway', devices: ['light.hallway'], motion: { entity: 'binary_sensor.hallway_motion', minutes: 1, brightness: 60, night: { brightness: 7, from: t(60), to: t(120) } } });
  await sleep(500);
  await mock('POST', '/sensor', { entity: 'binary_sensor.hallway_motion', state: 'on' });
  await sleep(2000);
  assert.equal(Math.round((await states())['light.hallway'].brightness / 2.55), 60, 'outside the night window');
  await mock('POST', '/sensor', { entity: 'binary_sensor.hallway_motion', state: 'off' });
});

await step('a group can be shown on the dashboard card always, only in its season, or never', async () => {
  const card = async () => {
    await sleep(3500); // the lighting sensor is written at most every 3 seconds
    const pub = (await mock('GET', '/published')).states['sensor.home_lighting'];
    return Object.fromEntries(pub.attributes.groups.map((g) => [g.id, [g.card, g.shown]]));
  };
  const today = new Date();
  const md = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const later = new Date(today.getTime() + 40 * 86400000); const later2 = new Date(today.getTime() + 60 * 86400000);
  const base = { name: 'Office', devices: ['light.office_desk'] };
  await app('POST', '/api/lighting/groups', base).catch(() => {});
  assert.deepEqual((await card()).office, ['show', true], 'shown by default');
  await app('PUT', '/api/lighting/groups/office', { ...base, card: 'hide' });
  assert.deepEqual((await card()).office, ['hide', false]);
  // only in season: a season that starts in 40 days, so not shown today
  await app('PUT', '/api/lighting/groups/office', { ...base, season: { from: md(later), to: md(later2) }, card: 'season' });
  assert.deepEqual((await card()).office, ['season', false]);
  // a season that includes today
  await app('PUT', '/api/lighting/groups/office', { ...base, season: { from: md(new Date(today.getTime() - 86400000)), to: md(later) }, card: 'season' });
  assert.deepEqual((await card()).office, ['season', true]);
  // saving without the setting (an older page, a script) leaves it as it was
  await app('PUT', '/api/lighting/groups/office', { ...base, season: { from: md(later), to: md(later2) } });
  assert.deepEqual((await card()).office, ['season', false]);
  // no season any more: "only in season" makes no sense, so it's shown
  await app('PUT', '/api/lighting/groups/office', { ...base });
  assert.deepEqual((await card()).office, ['show', true]);
});

console.log(`\n${passed} API checks passed`);
