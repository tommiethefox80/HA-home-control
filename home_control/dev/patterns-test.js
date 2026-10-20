// Changes made by hand that keep happening, turned into schedule changes: read from the last weeks
// of Activity, suggested, made (with Undo), made automatically, and new changes recorded as they happen.
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/seed.js && node dev/patterns-test.js
// (it restarts the app itself, with four Fridays of changes put into Activity)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const DATA = new URL('./data/', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;
const TZ = 'Europe/London';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
};
const pat = (m, p = '', b) => j(m, `${APP}/api/patterns${p}`, b);
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

// local wall-clock instants in the house's time zone
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
function localAt(daysAgo, hh, mm) {
  const ref = parts(Date.now() - daysAgo * 86400000);
  const guess = Date.UTC(Number(ref.year), Number(ref.month) - 1, Number(ref.day), hh, mm);
  const p = parts(guess);
  const off = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - guess;
  return guess - off;
}
const dow = (daysAgo) => parts(Date.now() - daysAgo * 86400000).weekday;
// the last four Fridays and the last five weekdays (before today)
const fridays = []; const weekdays = [];
for (let d = 1; fridays.length < 4; d++) if (dow(d) === 'Fri') fridays.push(d);
for (let d = 1; weekdays.length < 5; d++) if (!['Sat', 'Sun'].includes(dow(d))) weekdays.push(d);

await step('four Fridays and five weekdays of changes put into Activity, and the app restarted', async () => {
  const heat = await j('GET', `${APP}/api/state`);
  const lounge = heat.zones.find((z) => z.name === 'Lounge'); const bedroom = heat.zones.find((z) => z.name === 'Bedroom');
  assert.ok(lounge && bedroom);
  execSync('sh dev/run.sh stop', { cwd: ROOT });
  const act = JSON.parse(fs.readFileSync(`${DATA}activity.json`, 'utf8'));
  const added = [];
  // the Lounge radiator turned up to 22° at 20:00 on Fridays (its schedule has 21° from 17:00 to 22:30), once before 1.13.1's wording
  for (const [i, d] of fridays.entries()) {
    added.push({ at: localAt(d, 20, i), msg: i === 3 ? `Lounge: Lounge TRV changed by hand to 22° — holding until Fri 22:30` : `Lounge: Lounge TRV changed to 22° on the radiator itself, or in its own app (Hive) (it was 21°, and Home Control wanted 21°) — holding until Fri 22:30` });
  }
  // the Bedroom held at 18° here at 21:30 on weekdays, then back to schedule at 22:00
  for (const d of weekdays) {
    added.push({ at: localAt(d, 21, 30), msg: `Bedroom: set to 18° until ${dow(d)} 22:30` });
    added.push({ at: localAt(d, 22, 0), msg: 'Bedroom: back to schedule' });
  }
  act.entries = [...act.entries, ...added].sort((a, b) => b.at - a.at);
  fs.writeFileSync(`${DATA}activity.json`, JSON.stringify(act));
  // the Lounge lights turned off here at about 22:15 on Fridays (the schedule has them on at 35% until 23:30)
  const light = JSON.parse(fs.readFileSync(`${DATA}lighting.json`, 'utf8'));
  for (const [i, d] of fridays.entries()) light.activity.push({ at: localAt(d, 22, 12 + i), text: `Lounge: turned off here, until 23:30.`, group: 'lounge' });
  light.activity.sort((a, b) => a.at - b.at);
  fs.writeFileSync(`${DATA}lighting.json`, JSON.stringify(light));
  fs.rmSync(`${DATA}patterns.json`, { force: true });
  execSync('sh dev/run.sh', { cwd: ROOT });
  await until(async () => (await pat('GET')).heating?.since < Date.now() - 20 * 86400000 || null, 'the earlier changes read', 40000);
});

let sugs;
await step('suggested: the Lounge at 22° from 20:00 on Fridays; the Bedroom at 18° 21:30 to 22:00 on weekdays; the Lounge lights off at 22:15 on Fridays', async () => {
  const all = await pat('POST', '/run');
  sugs = all;
  const h = all.heating.suggestions;
  const lounge = h.find((s) => s.name === 'Lounge');
  assert.ok(lounge, JSON.stringify(h, null, 1));
  assert.equal(lounge.change, 'Make it 22° from 20:00 on Fridays');
  assert.equal(lounge.why, 'Lounge was turned up to 22° at about 20:00 on each of the last 4 Fridays.');
  const bed = h.find((s) => s.name === 'Bedroom');
  assert.ok(bed, JSON.stringify(h, null, 1));
  assert.equal(bed.change, 'Make it 18° from 21:30 until 22:00 on weekdays');
  assert.match(bed.why, /^Bedroom was turned down to 18° at about 21:30 on each of the last 5 weekdays\.$/);
  const l = all.lighting.suggestions.find((s) => s.name === 'Lounge');
  assert.ok(l, JSON.stringify(all.lighting, null, 1));
  assert.equal(l.change, 'Turn off at 22:15 instead of 23:30 on Fridays');
  // the same on the pages' live state
  assert.equal((await j('GET', `${APP}/api/state`)).learn.suggestions.length, 2);
  assert.equal((await j('GET', `${APP}/api/lighting/state`)).learn.suggestions.length, 1);
});

// PATTERNS_SETUP_ONLY=1: stop here, with the suggestions showing (for screenshots)
if (process.env.PATTERNS_SETUP_ONLY) { console.log('\nset up, suggestions showing'); process.exit(0); }

await step('"Change the schedule": Fridays get 22° from 20:00, said in Activity; then Undo', async () => {
  const s = sugs.heating.suggestions.find((x) => x.name === 'Lounge');
  const after = await pat('POST', `/heating/${s.id}/apply`);
  assert.equal(after.suggestions.some((x) => x.id === s.id), false);
  assert.equal(after.applied[0].auto, false);
  const st = await j('GET', `${APP}/api/state`);
  const z = st.zones.find((x) => x.name === 'Lounge');
  assert.deepEqual(st.schedules[z.id].fri.map((p) => `${p.time} ${p.temp}`), ['06:30 20', '09:00 17', '17:00 21', '20:00 22', '22:30 16']);
  assert.deepEqual(st.schedules[z.id].thu.map((p) => p.time), ['06:30', '09:00', '17:00', '22:30']);
  assert.ok(st.log.some((l) => l.msg === 'Lounge: schedule changed from a suggestion: make it 22° from 20:00 on Fridays, as Lounge was turned up to 22° at about 20:00 on each of the last 4 Fridays.'), st.log.slice(0, 3).map((l) => l.msg).join('\n'));
  // looking again doesn't suggest it again
  assert.equal((await pat('POST', '/run')).heating.suggestions.some((x) => x.name === 'Lounge'), false);
  await pat('POST', `/heating/${s.id}/undo`);
  const back = await j('GET', `${APP}/api/state`);
  assert.deepEqual(back.schedules[z.id].fri.map((p) => p.time), ['06:30', '09:00', '17:00', '22:30']);
  assert.ok(back.log.some((l) => /^Lounge: schedule change undone/.test(l.msg)));
  assert.equal((await pat('POST', '/run')).heating.suggestions.some((x) => x.name === 'Lounge'), false, 'not straight back after an Undo');
});

await step('"Not now" and "Don\'t suggest this"', async () => {
  const bed = sugs.heating.suggestions.find((x) => x.name === 'Bedroom');
  const v = await pat('POST', `/heating/${bed.id}/never`);
  assert.equal(v.suggestions.length, 0);
  assert.equal((await pat('POST', '/run')).heating.suggestions.length, 0);
});

await step('a group set to change automatically: its schedule changes straight away, with an Undo', async () => {
  const cfg = await j('GET', `${APP}/api/lighting/config`);
  const g = cfg.groups.find((x) => x.id === 'lounge');
  await j('PUT', `${APP}/api/lighting/groups/lounge`, { ...g, learn: 'auto' });
  assert.equal((await j('GET', `${APP}/api/lighting/config`)).groups.find((x) => x.id === 'lounge').learn, 'auto');
  const v = await pat('POST', '/run');
  assert.equal(v.lighting.suggestions.length, 0);
  assert.equal(v.lighting.applied[0].auto, true);
  const sch = (await j('GET', `${APP}/api/lighting/schedules`)).schedules.lounge;
  assert.deepEqual(sch[4].map((p) => p.time || p.anchor), ['07:00', '09:00', 'sunset', '21:30', '22:15']);
  assert.equal(sch[4][4].on, false);
  assert.deepEqual(sch[3].map((p) => p.time || p.anchor), ['07:00', '09:00', 'sunset', '21:30', '23:30']);
  const act = (await j('GET', `${APP}/api/lighting/activity`)).items.map((a) => a.text);
  assert.ok(act.some((t) => /^Lounge: schedule changed automatically: turn off at 22:15 instead of 23:30 on Fridays/.test(t)), act.slice(0, 3).join('\n'));
});

await step('new changes are recorded as they happen: a radiator turned up, a group switched here', async () => {
  const before = JSON.parse(fs.readFileSync(`${DATA}patterns.json`, 'utf8'));
  const n = before.parts.heating.events.length;
  await j('POST', `${MOCK}/knob`, { entity: 'climate.bedroom_trv', temperature: 25 });
  // the opposite of what its schedule wants now (a change that matches the schedule isn't one)
  const kitchen = (await j('GET', `${APP}/api/lighting/state`)).groups.find((g) => g.id === 'kitchen');
  const schedOn = !!kitchen.target?.on && kitchen.source !== 'override';
  await j('POST', `${APP}/api/lighting/groups/kitchen/set`, schedOn ? { on: false } : { on: true, brightness: 50 });
  // (a change within two minutes of another to the same room or group is the same change: the
  // seed set the kitchen a moment ago, so this one can replace that rather than add to the count)
  const after = await until(async () => {
    const d = JSON.parse(fs.readFileSync(`${DATA}patterns.json`, 'utf8'));
    return d.parts.heating.events.length > n && d.parts.lighting.events.some((e) => e.item === 'kitchen' && e.src === 'app') ? d : null;
  }, 'the changes recorded', 15000);
  const h = after.parts.heating.events.at(-1);
  assert.equal(h.value, 25); assert.equal(h.cls, 'up'); assert.equal(h.src, 'radiator');
  const l = after.parts.lighting.events.filter((e) => e.item === 'kitchen').at(-1);
  assert.equal(l.item, 'kitchen'); assert.equal(l.value.on, !schedOn); assert.equal(l.src, 'app');
  // an automation changing a radiator isn't a person's habit: not recorded
  const count = after.parts.heating.events.length;
  await j('POST', `${MOCK}/knob`, { entity: 'climate.lounge_trv', temperature: 23, context: { parent_id: 'automation-run' } });
  await until(async () => (await j('GET', `${APP}/api/state`)).log.some((l) => /Lounge radiator changed to 23° by an automation/.test(l.msg)), 'the automation\'s change seen');
  await sleep(1500);
  const d2 = JSON.parse(fs.readFileSync(`${DATA}patterns.json`, 'utf8'));
  assert.equal(d2.parts.heating.events.length, count);
  assert.equal(d2.parts.heating.events.some((e) => e.value === 23), false);
  // back to schedule ends it
  const z = (await j('GET', `${APP}/api/state`)).zones.find((x) => x.name === 'Bedroom');
  await j('DELETE', `${APP}/api/zones/${z.id}/override`);
  await until(async () => JSON.parse(fs.readFileSync(`${DATA}patterns.json`, 'utf8')).parts.heating.events.at(-1).endedAt != null, 'ended');
});

console.log(`\n${passed} pattern checks passed`);
