// A room thermometer that's stopped reporting: noticed, the room goes by its radiators (or off),
// Needs attention, Home Assistant's notifications and a phone, and back once it reports again
// (a report of the same value, which only Home Assistant's REST API shows, is enough).
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/quiet-test.js
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
async function until(fn, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}
const lounge = async () => (await heat('GET', 'state')).zones.find((z) => z.name === 'Lounge');
const log = async () => (await heat('GET', 'log?limit=40')).entries.map((e) => e.msg);

await step('not heard from for 100 minutes: the Lounge goes by its radiator, and says so', async () => {
  const s = await heat('GET', 'state');
  await heat('PUT', 'settings', { notify: { ...s.settings.notify, quiet: { enabled: true, service: 'notify.mobile_app_toms_iphone', ha: true } } });
  await mock('POST', '/reset-calls');
  await mock('POST', '/quiet', { entity: 'sensor.lounge_temperature', minutes: 100 });
  const z = await until(async () => { const x = await lounge(); return x.thermometer?.quiet ? x : null; }, 'the thermometer counted as quiet');
  assert.equal(z.thermometer.quiet.reason, 'long');
  assert.equal(z.thermometer.quiet.action, 'trvs');
  const trv = (await mock('GET', '/climate'))['climate.lounge_trv'].current;
  assert.equal(z.current, trv, 'the radiator\'s own reading');
  assert.ok(z.warnings.some((w) => /Lounge temperature hasn't reported since .*: going by the radiators until it does/.test(w)), z.warnings.join(' | '));
  const st = await heat('GET', 'state');
  assert.ok(st.attention.some((a) => a.key === `quiet-${z.id}`));
  assert.ok((await log()).some((m) => /^Lounge: Lounge temperature hasn't reported since .*, so it's going by its radiators' own readings until it does$/.test(m)));
  const calls = await until(async () => { const c = await mock('GET', '/calls'); return c.some((x) => x.domain === 'notify') && c.some((x) => x.domain === 'persistent_notification') ? c : null; }, 'the alerts');
  const phone = calls.find((x) => x.domain === 'notify');
  assert.equal(phone.service, 'mobile_app_toms_iphone');
  assert.equal(phone.data.title, 'Lounge: thermometer not reporting');
  const bell = calls.find((x) => x.domain === 'persistent_notification');
  assert.equal(bell.service, 'create');
  assert.equal(bell.data.notification_id, `home_control_thermometer_${z.id}`);
  const pub = await until(async () => {
    const r = (await mock('GET', '/published')).states['sensor.home_heating']?.attributes?.attention || [];
    return r.some((t) => /Lounge temperature/.test(typeof t === 'string' ? t : t.text)) ? r : null;
  }, 'the dashboard\'s Needs attention', 30000);
  assert.ok(pub);
});

await step('it reports the same reading again (only REST shows it): back to the thermometer', async () => {
  await mock('POST', '/reset-calls');
  await mock('POST', '/report', { entity: 'sensor.lounge_temperature' });
  const z = await until(async () => { const x = await lounge(); return x.thermometer && !x.thermometer.quiet ? x : null; }, 'back', 90000);
  assert.equal(z.current, 18.4);
  assert.ok((await log()).some((m) => /^Lounge: Lounge temperature is reporting again \(18\.4°\), so the room goes by it again$/.test(m)));
  const calls = await until(async () => { const c = await mock('GET', '/calls'); return c.some((x) => x.domain === 'persistent_notification') ? c : null; }, 'the notification cleared');
  assert.equal(calls.find((x) => x.domain === 'persistent_notification').service, 'dismiss');
  assert.ok(!(await heat('GET', 'state')).attention.some((a) => a.key === `quiet-${z.id}`));
});

await step('set to turn the heating off: frost protection until it reports (the Bedroom, with a thermometer of its own now)', async () => {
  await heat('PUT', 'settings', { quietSensor: { action: 'off', minutes: 45 } });
  assert.deepEqual((await heat('GET', 'state')).settings.quietSensor, { action: 'off', minutes: 45 });
  const bed = (await heat('GET', 'state')).zoneConfig.find((z) => z.name === 'Bedroom');
  await heat('PUT', `zones/${bed.id}`, { ...bed, sensor: 'sensor.office_switch_temperature' });
  await mock('POST', '/quiet', { entity: 'sensor.office_switch_temperature', minutes: 50 });
  const room = async () => (await heat('GET', 'state')).zones.find((z) => z.id === bed.id);
  const z = await until(async () => { const x = await room(); return x.source === 'quiet' ? x : null; }, 'frost protection');
  assert.equal(z.target, (await heat('GET', 'state')).settings.frostTemp);
  assert.equal(z.calling, false);
  assert.equal(z.thermometer.quiet.action, 'off');
  await mock('POST', '/sensor', { entity: 'sensor.office_switch_temperature', state: '17.1' });
  const back = await until(async () => { const x = await room(); return x.source !== 'quiet' && !x.thermometer.quiet ? x : null; }, 'back on its schedule');
  assert.equal(back.current, 17.1);
  await heat('PUT', 'settings', { quietSensor: { action: 'trvs', minutes: 90 } });
  await heat('PUT', `zones/${bed.id}`, bed);
});

console.log(`\n${passed} quiet thermometer checks passed`);
