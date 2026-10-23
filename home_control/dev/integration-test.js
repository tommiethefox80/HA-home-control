// Hive (the integration behind the radiators and boiler) not working in Home Assistant: told under
// Needs attention, in Home Assistant's notifications and on the phone, and again when it's working.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/integration-test.js
// (about five minutes: it checks every 30 s, and a failure is told once it's still so a minute later)
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
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }
async function until(fn, what, ms = 150000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1000);
  }
}
const attention = async () => (await heat('GET', 'state')).attention || [];
const hiveItem = async () => (await attention()).find((a) => a.key.startsWith('integration-'));
const phone = async () => (await mock('GET', '/calls')).filter((c) => c.domain === 'notify' && c.service === 'mobile_app_toms_iphone');

await step('working: nothing said', async () => {
  await heat('PUT', 'settings', { notify: { integration: { enabled: true, service: 'notify.mobile_app_toms_iphone' } } });
  const s = (await heat('GET', 'state')).settings.notify.integration;
  assert.deepEqual(s, { enabled: true, service: 'notify.mobile_app_toms_iphone', ha: true });
  await sleep(35000); // a look at the integrations
  assert.equal(await hiveItem(), undefined);
  await mock('POST', '/reset-calls');
});

await step('Hive fails to set up: Needs attention (with a button to Hive), Home Assistant\'s notifications and the phone, once', async () => {
  await mock('POST', '/integration', { domain: 'hive', state: 'setup_error' });
  const a = await until(hiveItem, 'Needs attention');
  assert.match(a.text, /^Hive isn't working in Home Assistant: it failed to set up, since \d\d:\d\d\. Home Control can't change Lounge radiator, Bedroom radiator and the boiler until it's fixed/);
  assert.match(a.text, /in the Hive app, put the thermostat and radiators back on Schedule/);
  assert.equal(a.href, '/config/integrations/integration/hive');
  assert.equal(a.hrefText, 'Open Hive in Home Assistant');
  const att = await attention();
  assert.equal(att.some((x) => x.key.startsWith('off-') || x.key === 'boiler-offline'), false, 'not each device\'s own "offline" too');
  const n = await mock('POST', '/notifications');
  assert.equal(n.home_control_hive?.title, 'Hive isn\'t working');
  assert.match(n.home_control_hive.message, /\[Open Hive in Home Assistant\]\(\/config\/integrations\/integration\/hive\)$/);
  const p = await until(async () => { const x = await phone(); return x.length ? x : null; }, 'the phone alert', 20000);
  assert.equal(p[0].data.title, 'Hive isn\'t working');
  const log = (await heat('GET', 'state')).log.map((l) => l.msg);
  assert.ok(log.some((m) => /^Hive isn't working in Home Assistant/.test(m)));
  // the dashboard card shows it too
  const pub = await until(async () => { const s = (await mock('GET', '/published')).states['sensor.home_heating']; return s?.attributes?.attention?.some?.((x) => /Hive isn't working/.test(typeof x === 'string' ? x : x.text)) ? s : null; }, 'the dashboard sensor', 60000);
  assert.ok(pub);
  // meanwhile: the boiler isn't shown or counted as running, rooms that want heat aren't heating,
  // and the dashboard's boiler sensor is unavailable rather than on
  const st = await heat('GET', 'state');
  assert.equal(st.boiler.reachable, false);
  assert.equal(st.boiler.on, false);
  assert.ok(st.zones.every((z) => !z.heating), JSON.stringify(st.zones.map((z) => [z.name, z.calling, z.heating])));
  await until(async () => (await mock('GET', '/published')).states['binary_sensor.home_boiler']?.state === 'unavailable', 'the boiler sensor unavailable', 60000);
  await sleep(35000);
  assert.equal((await phone()).length, 1, 'told once');
  const notes = (await heat('GET', 'state')).log.filter((l) => l.at > Date.now() - 90000).map((l) => l.msg);
  assert.equal(notes.some((m) => /^Boiler (ON|OFF)/.test(m)), false, 'nothing switched while it can\'t be reached');
});

await step('working again: cleared everywhere, and the phone told', async () => {
  await mock('POST', '/reset-calls');
  await mock('POST', '/integration', { domain: 'hive', state: 'loaded' });
  await until(async () => !(await hiveItem()), 'Needs attention cleared', 60000);
  const n = await mock('POST', '/notifications');
  assert.equal(n.home_control_hive, undefined, 'Home Assistant\'s notification dismissed');
  const p = await until(async () => { const x = await phone(); return x.length ? x : null; }, 'the phone told', 20000);
  assert.equal(p[0].data.title, 'Hive is working again');
  assert.match(p[0].data.message, /^Hive is working again in Home Assistant, so Home Control is looking after Lounge radiator, Bedroom radiator and the boiler again\.$/);
});

await step('needs signing in again (and Home Assistant\'s notifications turned off here)', async () => {
  await heat('PUT', 'settings', { notify: { integration: { enabled: true, service: 'notify.mobile_app_toms_iphone', ha: false } } });
  await mock('POST', '/reset-calls');
  await mock('POST', '/integration', { domain: 'hive', state: 'setup_error', reauth: true });
  const a = await until(hiveItem, 'Needs attention');
  assert.match(a.text, /^Hive needs signing in again in Home Assistant \(Settings → Devices & services → Hive\)/);
  const calls = await mock('GET', '/calls');
  assert.equal(calls.some((c) => c.domain === 'persistent_notification'), false, 'not in Home Assistant\'s notifications');
  await mock('POST', '/integration', { domain: 'hive', state: 'loaded', reauth: false });
  await until(async () => !(await hiveItem()), 'cleared', 60000);
});

await step('a test alert', async () => {
  await mock('POST', '/reset-calls');
  await heat('POST', 'notify/test', { which: 'integration' });
  const p = await until(async () => { const x = await phone(); return x.length ? x : null; }, 'the test', 10000);
  assert.equal(p[0].data.title, 'Hive isn\'t working (test)');
});

console.log(`\n${passed} integration checks passed`);
