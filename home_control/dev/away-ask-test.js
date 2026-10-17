// The heating comes on with everyone out: the chosen phones are asked, with buttons, whether to turn it off.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/away-ask-test.js
import assert from 'node:assert/strict';

const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
};
const heat = (m, p, b) => j(m, `${APP}/api/${p}`, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(300);
  }
}
// home is at 53.26, -2.52 in the mock
const where = { home: { state: 'home', lat: 53.26, lon: -2.52 }, far: { state: 'not_home', lat: 53.48, lon: -2.24 }, near: { state: 'not_home', lat: 53.268, lon: -2.52 } };
const put = (person, place, name) => mock('POST', '/sensor', { entity: `person.${person}`, state: where[place].state, attrs: { friendly_name: name, latitude: where[place].lat, longitude: where[place].lon } });
const everyone = async (place) => { await put('tom', place, 'Tom'); await put('sam', place, 'Sam'); await sleep(400); };
const asks = async () => (await mock('GET', '/calls')).filter((c) => c.domain === 'notify' && c.data?.data?.tag === 'home-control-empty');

await step('set up: a boiler, a room that wants heat, and the alert on for one phone', async () => {
  await everyone('far');
  await heat('PUT', 'settings', {
    boiler: { entity: 'climate.heating', onTemp: 30, offTemp: 7, minOnMinutes: 0, minOffMinutes: 0 },
    notify: { empty: { enabled: true, services: ['notify.mobile_app_toms_iphone', 'notify.nope here'], minutes: 90 } },
  });
  const s = (await heat('GET', 'state')).settings;
  assert.deepEqual(s.notify.empty, { enabled: true, services: ['notify.mobile_app_toms_iphone'], minutes: 90 });
  await mock('POST', '/reset-calls');
});

let first;
await step('the boiler fires with everyone out: the phone is asked, with three buttons', async () => {
  await heat('POST', 'zones', { name: 'Lounge', trvs: ['climate.lounge_trv'], sensor: 'sensor.lounge_temperature', schedule: Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp: 21 }]])) });
  const a = await until(async () => { const x = await asks(); return x.length ? x : null; }, 'the question');
  assert.equal(a.length, 1);
  first = a[0];
  assert.equal(first.service, 'mobile_app_toms_iphone');
  assert.equal(first.data.title, 'Heating on, everyone\'s out');
  assert.match(first.data.message, /The boiler's come on for Lounge, but no one's home/);
  assert.deepEqual(first.data.data.actions.map((x) => x.title), ['Off for 1.5 hours', 'Off until we\'re back', 'Off until we\'re nearly home']);
  assert.match(first.data.data.actions[0].action, /^HC_HEAT_FOR_\w+$/);
  const log = (await heat('GET', 'log')).entries.map((e) => e.msg);
  assert.ok(log.some((m) => /everyone out: asked notify\.mobile_app_toms_iphone/.test(m)), log.slice(0, 5).join('\n'));
});

await step('"Off until we\'re nearly home": Away, and the phone told', async () => {
  await mock('POST', '/reset-calls');
  await mock('POST', '/fire', { event_type: 'mobile_app_notification_action', data: { action: first.data.data.actions[2].action } });
  const s = await until(async () => { const x = await heat('GET', 'state'); return x.mode === 'away' ? x : null; }, 'Away');
  assert.equal(s.awayBack, 'near');
  assert.equal(s.awayUntil, null);
  const told = await until(async () => { const x = await asks(); return x.length ? x : null; }, 'the confirmation');
  assert.equal(told[0].data.title, 'Heating off');
  assert.match(told[0].data.message, /Away until someone's within 2 miles of home/);
  assert.equal(told[0].data.data.actions, undefined, 'no buttons on the answer');
  await until(async () => (await heat('GET', 'state')).boiler.on === false, 'the boiler off');
  const pub = (await mock('GET', '/published')).states['sensor.home_heating'];
  await until(async () => (await mock('GET', '/published')).states['sensor.home_heating']?.attributes?.mode_text === 'Away until someone\'s nearly home', 'the dashboard wording', 30000).catch(() => { throw new Error(`mode_text: ${pub?.attributes?.mode_text}`); });
});

await step('someone heading home (under 2 miles): back on the schedules', async () => {
  await put('sam', 'near', 'Sam');
  const s = await until(async () => { const x = await heat('GET', 'state'); return x.mode === 'auto' ? x : null; }, 'back to schedules');
  assert.equal(s.awayBack, null);
  const log = (await heat('GET', 'log')).entries.map((e) => e.msg);
  assert.ok(log.some((m) => /Mode: Schedules \(automatic: Sam is 0\.\d miles away\)/.test(m)), log.slice(0, 5).join('\n'));
});

await step('a button on an old alert changes nothing', async () => {
  await everyone('far');
  await mock('POST', '/fire', { event_type: 'mobile_app_notification_action', data: { action: 'HC_HEAT_FOR_zzzzzz' } });
  await sleep(800);
  assert.equal((await heat('GET', 'state')).mode, 'auto');
});

await step('asked once while everyone\'s out; again after someone\'s been home: "Off for 1.5 hours"', async () => {
  await mock('POST', '/reset-calls');
  // the boiler goes off and on again with everyone still out: not asked again
  await heat('POST', 'mode', { mode: 'off' });
  await heat('POST', 'mode', { mode: 'auto' });
  await until(async () => (await heat('GET', 'state')).boiler.on, 'the boiler on');
  await sleep(800);
  assert.equal((await asks()).length, 0, 'not asked twice');
  // someone comes home and goes out again: asked again
  await put('tom', 'home', 'Tom');
  await sleep(1500);
  await put('tom', 'far', 'Tom');
  await heat('POST', 'mode', { mode: 'off' });
  await heat('POST', 'mode', { mode: 'auto' });
  const a = await until(async () => { const x = await asks(); return x.length ? x : null; }, 'the second question');
  const before = Date.now();
  await mock('POST', '/fire', { event_type: 'mobile_app_notification_action', data: { action: a[0].data.data.actions[0].action } });
  const s = await until(async () => { const x = await heat('GET', 'state'); return x.mode === 'away' && x.awayUntil ? x : null; }, 'Away for 90 min');
  assert.ok(Math.abs(s.awayUntil - (before + 90 * 60000)) < 10000, String(s.awayUntil - before));
});

await step('not asked when someone\'s on their way home, nor while Away automatically will deal with it', async () => {
  await heat('POST', 'mode', { mode: 'auto' });
  await put('tom', 'home', 'Tom');
  await sleep(1500);
  await mock('POST', '/reset-calls');
  // someone within 2 miles
  await put('tom', 'near', 'Tom'); await put('sam', 'far', 'Sam');
  await heat('POST', 'mode', { mode: 'off' }); await heat('POST', 'mode', { mode: 'auto' });
  await until(async () => (await heat('GET', 'state')).boiler.on, 'the boiler on');
  await sleep(800);
  assert.equal((await asks()).length, 0, 'someone on the way home');
  // Away automatically on: it switches to Away itself after its wait, so no question. The boiler
  // fires from the schedule (a mode picked by hand while everyone's out overrules Away automatically,
  // and then it does ask)
  await heat('PUT', 'settings', { presence: { enabled: true, people: [], delayMinutes: 15, nearMiles: 2 } });
  await everyone('home');
  await heat('POST', 'mode', { mode: 'auto' });
  const zone = (await heat('GET', 'state')).zones[0].id;
  const flat = (t) => Object.fromEntries(DAYS.map((d) => [d, [{ time: '00:00', temp: t }]]));
  await heat('PUT', `zones/${zone}/schedule`, flat(5));
  await until(async () => !(await heat('GET', 'state')).boiler.on, 'the boiler off');
  await everyone('far');
  await mock('POST', '/reset-calls');
  await heat('PUT', `zones/${zone}/schedule`, flat(21));
  await until(async () => (await heat('GET', 'state')).boiler.on, 'the boiler on');
  await sleep(1000);
  assert.equal((await asks()).length, 0, 'Away automatically is in charge');
});

await step('a test alert has the buttons, and pressing one changes nothing', async () => {
  await mock('POST', '/reset-calls');
  await heat('POST', 'notify/test', { which: 'empty' });
  const a = await until(async () => { const x = await asks(); return x.length ? x : null; }, 'the test');
  assert.match(a[0].data.title, /\(test\)$/);
  assert.equal(a[0].data.data.actions.length, 3);
  const mode = (await heat('GET', 'state')).mode;
  await mock('POST', '/fire', { event_type: 'mobile_app_notification_action', data: { action: a[0].data.data.actions[0].action } });
  await sleep(800);
  assert.equal((await heat('GET', 'state')).mode, mode);
});

console.log(`\n${passed} away-ask checks passed`);
