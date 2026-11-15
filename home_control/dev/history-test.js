// The History chart: the last day straight from Home Assistant's history, a week from the app's
// half-hourly figures (filled in from Home Assistant's history about a minute after it starts),
// chosen dates, and bad ranges refused.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/history-test.js
import assert from 'node:assert/strict';

const APP = 'http://localhost:8099';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { const r = await fetch(APP + p); const d = await r.json(); return { status: r.status, d }; };
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }
const known = (arr) => (arr || []).filter((v) => v != null).length;

await step('the last day: every 5 minutes from Home Assistant, each room, outside and the boiler', async () => {
  const { d } = await get('/api/history?hours=24');
  assert.equal(d.source, 'ha');
  assert.equal(d.step, 5 * 60000);
  assert.equal(d.times.length, 289);
  assert.deepEqual(d.rooms.map((r) => r.name), ['Lounge', 'Bedroom']);
  for (const r of d.rooms) assert.ok(known(r.temps) > 250 && known(r.targets) > 250, r.name);
  assert.ok(known(d.outside.series) > 250);
  assert.ok(d.boilerRuns.length > 0 && d.boilerMinutes > 0);
});

await step('three days: every 15 minutes', async () => {
  const { d } = await get('/api/history?hours=72');
  assert.equal(d.step, 15 * 60000);
  assert.ok(known(d.rooms[0].temps) > 250);
});

await step('a week: every half hour, from the app\'s own figures (filled in from Home Assistant\'s history)', async () => {
  let d;
  for (let i = 0; i < 50; i++) {
    d = (await get('/api/history?hours=168')).d;
    if (known(d.rooms?.[0]?.temps) > 300) break;
    await sleep(2000);
  }
  assert.equal(d.source, 'log');
  assert.equal(d.step, 30 * 60000);
  for (const r of d.rooms) assert.ok(known(r.temps) > 300, `${r.name}: ${known(r.temps)}`);
  assert.ok(d.boilerMinutes > 0);
  assert.ok(known(d.outside.series) > 300);
});

await step('chosen dates, and bad ranges refused', async () => {
  const to = Date.now() - 86400000; const from = to - 2 * 86400000;
  const { d } = await get(`/api/history?from=${from}&to=${to}`);
  assert.ok(Math.abs(d.from - from) <= 15 * 60000 && d.end <= to);
  assert.equal((await get(`/api/history?from=${to}&to=${from}`)).status, 400);
  assert.equal((await get('/api/history')).status, 400);
});

console.log(`\n${passed} history checks passed`);
