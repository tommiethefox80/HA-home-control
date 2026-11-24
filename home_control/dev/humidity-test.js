// Humidity: found on the room thermometer's device, shown with what it means, chosen or turned off
// in the room's settings, kept in the History chart and on the dashboard sensor.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/humidity-test.js
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
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(300);
  }
}
const known = (a) => (a || []).filter((v) => v != null).length;
const lounge = async () => (await heat('GET', 'state')).zones.find((z) => z.name === 'Lounge');
const config = async () => (await heat('GET', 'state')).zoneConfig.find((z) => z.name === 'Lounge');

await step('found on the thermometer\'s device, with what it means', async () => {
  const z = await until(async () => { const x = await lounge(); return x?.humidity ? x : null; }, 'the Lounge humidity');
  assert.equal(z.humidity.entity, 'sensor.lounge_monitor_humidity');
  assert.equal(z.humidity.auto, true);
  assert.equal(z.humidity.now, 62);
  assert.equal(z.humidity.level, 'humid');
  assert.ok(z.humidity.dew > 10 && z.humidity.dew < 12);
  assert.ok(z.humidity.coldSpot.rh > 62, 'more humid against the cold walls');
  assert.equal(z.thermometer.entity_id, 'sensor.lounge_temperature');
  const bed = (await heat('GET', 'state')).zones.find((x) => x.name === 'Bedroom');
  assert.equal(bed.humidity, null, 'no thermometer, and its radiator doesn\'t report humidity');
  // the room editor's list: humidity sensors, and each thermometer's own
  const ents = await heat('GET', 'entities');
  assert.deepEqual(ents.filter((e) => e.kind === 'humidity').map((e) => e.entity_id).sort(), ['sensor.bathroom_humidity', 'sensor.lounge_monitor_humidity']);
  assert.equal(ents.find((e) => e.entity_id === 'sensor.lounge_temperature').humidity, 'sensor.lounge_monitor_humidity');
});

await step('a cold night: very humid, and the windows running wet', async () => {
  await mock('POST', '/sensor', { entity: 'sensor.lounge_monitor_humidity', state: '74' });
  await mock('POST', '/sensor', { entity: 'weather.home', state: 'cloudy', attrs: { temperature: -1 } });
  const z = await until(async () => { const x = await lounge(); return x.humidity.now === 74 && x.humidity.windows ? x : null; }, 'condensation');
  assert.equal(z.humidity.level, 'damp');
  const pub = await until(async () => {
    const r = (await mock('GET', '/published')).states['sensor.home_heating']?.attributes?.rooms?.find((x) => x.name === 'Lounge');
    return r?.humidity === 74 ? r : null;
  }, 'the dashboard sensor', 30000);
  assert.equal(pub.condensation, true);
  await mock('POST', '/sensor', { entity: 'sensor.lounge_monitor_humidity', state: '62' });
  await mock('POST', '/sensor', { entity: 'weather.home', state: 'cloudy', attrs: { temperature: 12 } });
});

await step('chosen in the room\'s settings, or turned off', async () => {
  const c = await config();
  await heat('PUT', `zones/${c.id}`, { ...c, humidity: 'sensor.bathroom_humidity' });
  let z = await until(async () => { const x = await lounge(); return x.humidity?.entity === 'sensor.bathroom_humidity' ? x : null; }, 'the chosen sensor');
  assert.equal(z.humidity.now, 71);
  assert.equal(z.humidity.auto, false);
  assert.equal((await config()).humidity, 'sensor.bathroom_humidity');
  await heat('PUT', `zones/${c.id}`, { ...c, humidity: 'none' });
  z = await until(async () => { const x = await lounge(); return x.humidity === null ? x : null; }, 'none');
  assert.equal((await config()).humidity, false);
  // saving the room without saying leaves it as it was
  const { humidity, ...rest } = await config();
  await heat('PUT', `zones/${c.id}`, rest);
  assert.equal((await config()).humidity, false);
  await heat('PUT', `zones/${c.id}`, { ...c, humidity: 'auto' });
  z = await until(async () => { const x = await lounge(); return x.humidity?.entity === 'sensor.lounge_monitor_humidity' ? x : null; }, 'automatic again');
  assert.equal((await config()).humidity, null);
});

await step('the last day on the chart: humidity and the coldest spots, every 5 minutes', async () => {
  const d = await heat('GET', 'today?fresh=1');
  const r = d.rooms.find((x) => x.name === 'Lounge');
  assert.ok(known(r.humidity) > 250, String(known(r.humidity)));
  assert.ok(known(r.coldSpot) > 250);
  assert.ok(r.coldSpot.every((v, k) => v == null || r.humidity[k] == null || v >= r.humidity[k]), 'never drier at the cold spots');
  assert.equal(d.rooms.find((x) => x.name === 'Bedroom').humidity, undefined);
  const h = await heat('GET', 'history?hours=48');
  assert.ok(known(h.rooms.find((x) => x.name === 'Lounge').humidity) > 250);
});

await step('a week: kept every half hour (filled in from Home Assistant), and the week\'s damp', async () => {
  let d;
  for (let i = 0; i < 50; i++) {
    d = await heat('GET', 'history?hours=168&fresh=1');
    if (known(d.rooms.find((x) => x.name === 'Lounge')?.humidity) > 300) break;
    await sleep(2000);
  }
  assert.equal(d.source, 'log');
  const r = d.rooms.find((x) => x.name === 'Lounge');
  assert.ok(known(r.humidity) > 300, String(known(r.humidity)));
  assert.ok(known(r.coldSpot) > 300);
  const z = await until(async () => { const x = await lounge(); return x.humidity?.week ? x : null; }, 'the week\'s damp', 20000);
  const w = z.humidity.week;
  assert.ok(w.hours >= 150, String(w.hours));
  assert.ok(['fine', 'watch', 'mould'].includes(w.verdict));
  assert.ok(w.coldAvg > w.avgRh);
  assert.ok(w.warmerAvg < w.coldAvg, 'a degree warmer is drier at the walls');
});

console.log(`\n${passed} humidity checks passed`);
