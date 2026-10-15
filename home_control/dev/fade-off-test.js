// A bulb that jumps to full brightness when asked to fade off (light.lounge_lamp in the mock).
// Checks that a scheduled "off" really switches it off and isn't mistaken for someone at the switch.
import assert from 'node:assert/strict';
import { zonedParts, minutesToTime } from '../server/src/lighting/schedule.js';
const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (m, url, b) => { const r = await fetch(url, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
const lamp = async () => (await j('GET', `${MOCK}/states`))['light.lounge_lamp'];
const nowMin = zonedParts(Date.now(), 'Europe/London').minutes;
const t = (d) => minutesToTime(nowMin + d);
const every = (pts) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, pts]));
// save, then "Back to schedule" so it applies straight away
const schedule = async (body) => { await j('PUT', `${APP}/api/lighting/schedules/lounge`, body); await j('POST', `${APP}/api/lighting/groups/lounge/resume`); };
let ok = true;
const check = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) ok = false; };

await j('PUT', `${APP}/api/lighting/settings`, { graceSeconds: 5, defaultTransition: 2 });
await j('POST', `${APP}/api/lighting/groups`, { name: 'Lounge', devices: ['light.lounge_lamp'] });
// on at 40%, then a scheduled "off" with a 1 minute fade, as on Tom's Monday
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40, fade: 60 }]) });
await sleep(4000);
console.log('before:', JSON.stringify(await lamp()));
for (const fade of [60, null]) {
  await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }, { time: t(-1), on: false, fade }]) });
  await sleep(fade ? 70000 : 8000);
  const l = await lamp();
  const g = (await j('GET', `${APP}/api/lighting/state`)).groups.find((x) => x.id === 'lounge');
  const act = (await j('GET', `${APP}/api/lighting/activity`)).items.slice(0, 4).map((i) => i.text);
  console.log(`after off (${fade ? 'fade 1 min' : 'Quick'}):`, JSON.stringify(l), '|', g.status.text);
  check(l.state === 'off', `lamp is off (${fade ? '1 min fade' : 'Quick'})`);
  check(!act.some((a) => /at the switch/.test(a)), 'not mistaken for someone at the switch');
  console.log('   ', act.join('\n     '));
  await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }]) });
  await j('POST', `${APP}/api/lighting/groups/lounge/resume`);
  await sleep(6000);
}
// turning it off from the app
await j('POST', `${APP}/api/lighting/groups/lounge/set`, { on: false });
await sleep(6000);
check((await lamp()).state === 'off', 'lamp is off after pressing off in the app');
// a light that comes back on once even after a plain off: switched off again, and told plainly
await j('POST', `${APP}/api/lighting/groups/lounge/resume`);
await sleep(5000);
check((await lamp()).state === 'on', 'lamp back on with the schedule');
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 1 });
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }, { time: t(-1), on: false }]) });
await sleep(6000);
let act = (await j('GET', `${APP}/api/lighting/activity`)).items.slice(0, 3).map((i) => i.text);
check((await lamp()).state === 'off', 'lamp that bounced once ends up off');
check(act.some((a) => /came back on by itself.*after being switched off/.test(a)), 'says it came back on by itself');
check(!act.some((a) => /at the switch/.test(a)), 'not mistaken for someone at the switch');
// one that never stays off: gives up after two more tries and says what to check
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }]) });
await sleep(5000);
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 10 });
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }, { time: t(-1), on: false }]) });
await sleep(9000);
act = (await j('GET', `${APP}/api/lighting/activity`)).items.slice(0, 3).map((i) => i.text);
check(act.some((a) => /keeps coming back on by itself/.test(a)), 'warns when it keeps coming back on');
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 0 });
// a light that goes back on but doesn't tell Home Assistant, so Home Assistant still says "off"
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }]) });
await sleep(5000);
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 1, silent: true });
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }, { time: t(-1), on: false }]) });
await sleep(12000);
const calls = (await j('GET', `${MOCK}/calls`)).filter((c) => c.service === 'update_entity');
act = (await j('GET', `${APP}/api/lighting/activity`)).items.slice(0, 3).map((i) => i.text);
check(calls.length > 0, 'asks Home Assistant to re-read the light after switching it');
check(act.some((a) => /came back on by itself/.test(a)), 'finds out it is really on');
const real = (await j('GET', `${MOCK}/states`))['light.lounge_lamp'];
check(real.state === 'off' && !real.really, `and the bulb is really off (${JSON.stringify(real)})`);
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 0 });

// Tom's 22:00: set to 80% here, then the scheduled off with a 10 s fade; the bulb comes back on at
// full brightness 25 s after the final off, and Home Assistant only hears about it then.
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }]) });
await sleep(5000);
await j('POST', `${APP}/api/lighting/groups/lounge/set`, { on: true, brightness: 80 });
await sleep(3000);
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 1, delay: 25000 });
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }, { time: t(-1), on: false, fade: 10 }]) });
await sleep(45000);
act = (await j('GET', `${APP}/api/lighting/activity`)).items.slice(0, 4).map((i) => i.text);
console.log('    late comeback:', act.slice(0, 2).join(' | '));
check((await lamp()).state === 'off', 'a bulb that comes back on 25 s after the off ends up off');
check(act.some((a) => /came back on by itself at 100% \d+ s after being switched off/.test(a)), 'says it came back on by itself, and when');
check(!act.some((a) => /at the switch/.test(a)), 'not mistaken for someone at the switch');
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 0 });

// the same, but silently: Home Assistant still says off until the app reads it back again
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }]) });
await sleep(5000);
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 1, silent: true, delay: 12000 });
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }, { time: t(-1), on: false }]) });
await sleep(26000);
const real2 = (await j('GET', `${MOCK}/states`))['light.lounge_lamp'];
act = (await j('GET', `${APP}/api/lighting/activity`)).items.slice(0, 3).map((i) => i.text);
check(act.some((a) => /came back on by itself/.test(a)), 'a silent comeback 12 s later is found by the later read-back');
check(real2.state === 'off' && !real2.really, `and the bulb is really off (${JSON.stringify(real2)})`);
await j('POST', `${MOCK}/bounce`, { entity: 'light.lounge_lamp', times: 0 });

// Tom's 19:30: a fade up to 40%, and a report from part-way through it (30%) arrives well after the fade
await j('PUT', `${APP}/api/lighting/settings`, { graceSeconds: 30 });
await schedule({ week: every([{ time: t(-60), on: false }]) });
await sleep(5000);
await j('POST', `${MOCK}/lag`, { entity: 'light.lounge_lamp', at: 30000, value: 30 });
await schedule({ week: every([{ time: t(-60), on: false }, { time: t(-1), on: true, brightness: 40, fade: 10 }]) });
await sleep(36000);
act = (await j('GET', `${APP}/api/lighting/activity`)).items.slice(0, 3).map((i) => i.text);
const g2 = (await j('GET', `${APP}/api/lighting/state`)).groups.find((x) => x.id === 'lounge');
check(!act.some((a) => /at the switch/.test(a)) && g2.override?.type !== 'manual', `a late report from the middle of a fade isn't a person (${g2.status.text})`);
check((await lamp()).brightness === Math.round(0.4 * 255), 'and it ends at 40%');
await j('PUT', `${APP}/api/lighting/settings`, { graceSeconds: 5 });

// a real person at the wall switch, a while after the off, is still noticed
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }]) });
await sleep(5000);
await schedule({ week: every([{ time: t(-60), on: true, brightness: 40 }, { time: t(-1), on: false }]) });
await sleep(65000);
await j('POST', `${MOCK}/human`, { entity: 'light.lounge_lamp', on: true, brightness: 70 });
await sleep(1500);
const g = (await j('GET', `${APP}/api/lighting/state`)).groups.find((x) => x.id === 'lounge');
check(g.override?.type === 'manual', `a real switch press is still respected (${g.status.text})`);
console.log(ok ? 'fade-off checks passed' : 'fade-off checks FAILED');
process.exit(ok ? 0 : 1);
