// Energy, end to end against the mock Home Assistant with its stand-in Octopus Energy integration
// (Intelligent Octopus Go, a Home Mini, gas and a car on a Projekt EV charger).
// Run: sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh && node dev/energy-test.js
import assert from 'node:assert/strict';

const APP = 'http://localhost:8099'; const MOCK = 'http://localhost:8124';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, body) => {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
};
const en = (m, p, b) => j(m, `${APP}/api/energy/${p}`, b);
const mock = (m, p, b) => j(m, MOCK + p, b);
const state = () => en('GET', 'state');
let passed = 0;
async function step(name, fn) { process.stdout.write(`- ${name} ... `); await fn(); passed++; console.log('ok'); }
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(400);
  }
}

await step('Energy starts off, and has no dashboard sensor', async () => {
  assert.equal((await j('GET', `${APP}/api/house`)).modules.energy, false);
  const pub = (await mock('GET', '/published')).states;
  assert.equal(pub['sensor.home_energy'], undefined);
});

await step('turned on, with Octopus: the tariff, the price now and its band', async () => {
  await mock('POST', '/octopus', { on: true, tariff: 'iog', homeMini: true, gas: true, ev: true });
  await j('PUT', `${APP}/api/house`, { modules: { energy: true } });
  const s = await until(async () => { const x = await state(); return x.price && x.found.dashboard ? x : null; }, 'prices and the Energy dashboard');
  assert.equal(s.tariff.name, 'Intelligent Octopus Go');
  assert.ok([7, 26.5].includes(s.price.p), String(s.price.p));
  assert.deepEqual({ cheap: s.limits.cheap, kind: s.limits.kind }, { cheap: 7, kind: 'two' });
  assert.ok(s.rates.length >= 96, 'today and tomorrow');
  assert.ok(s.rates.some((r) => r.adj && r.p === 7), 'the car\'s extra cheap slot');
  const extra = s.cheapRuns.find((r) => r.extra);
  assert.ok(extra, JSON.stringify(s.cheapRuns));
  assert.equal(extra.end - extra.start, 3600000);
});

await step('today\'s cost and use from the Home Mini, gas too, and yesterday\'s from the smart meter', async () => {
  const s = await state();
  assert.equal(s.elec.today.src, 'octopus');
  assert.ok(s.elec.today.cost > 0.5, JSON.stringify(s.elec.today));
  assert.equal(s.elec.today.standing, 0.54);
  assert.ok(s.elec.use.length > 0 && s.elec.use[0].kwh != null);
  assert.ok(s.elec.demand.w > 0);
  assert.ok(s.elec.last.cost > 1);
  assert.ok(s.gas.p > 5 && s.gas.p < 7);
  assert.ok(s.gas.today.cost > 0);
});

await step('the car: planned charging, and bump charge, charge target and ready-by from here', async () => {
  let s = await state();
  assert.equal(s.ev.provider, 'PROJEKT');
  assert.equal(s.ev.soc, null, 'a charger, not the car: no battery level');
  assert.equal(s.ev.planned.length, 2);
  assert.equal(s.ev.bump, false);
  await mock('POST', '/reset-calls');
  await en('POST', 'ev', { what: 'bump', value: true });
  s = await until(async () => { const x = await state(); return x.ev.bump && x.ev.state === 'BOOSTING' ? x : null; }, 'bump charging');
  assert.equal(s.ev.stateText, 'Bump charging');
  await en('POST', 'ev', { what: 'bump', value: false });
  await en('POST', 'ev', { what: 'target', value: 90 });
  await en('POST', 'ev', { what: 'ready', value: '06:30' });
  s = await until(async () => { const x = await state(); return x.ev.target.value === 90 && x.ev.ready.value === '06:30' && !x.ev.bump ? x : null; }, 'the car settings');
  await assert.rejects(en('POST', 'ev', { what: 'ready', value: '03:00' }), /half hour, from 04:00/);
  await assert.rejects(en('POST', 'ev', { what: 'target', value: 120 }), /between 10% and 100%/);
  const calls = (await mock('GET', '/calls')).map((c) => `${c.domain}.${c.service}`);
  for (const c of ['switch.turn_on', 'switch.turn_off', 'number.set_value', 'select.select_option']) assert.ok(calls.includes(c), `${c} in ${calls}`);
  const act = (await en('GET', 'activity')).items.map((e) => e.text);
  assert.ok(act.some((t) => /Bump charge started from here/.test(t)));
});

await step('history: each day\'s cost and use, and what used the most', async () => {
  const h = await en('GET', 'history?days=7');
  assert.equal(h.list.length, 7, JSON.stringify(h.list.map((d) => d.day)));
  assert.equal(h.costs, true);
  assert.ok(h.list.every((d) => d.elecKwh > 0 && d.elecCost > 0));
  assert.ok(h.list.slice(0, -1).every((d) => d.gasKwh > 0), 'gas each whole day');
  assert.equal(h.devices[0].name, 'Car charger', 'the car used the most');
  assert.ok(h.devices.some((d) => d.name === 'Dishwasher'), 'without "energy" on the end');
  await assert.rejects(en('GET', 'history?days=abc').then((x) => { if (x.days !== 30) throw new Error('bad'); return x; }).then(() => { throw new Error('ok'); }), /ok/);
});

await step('a plan picks the car\'s cheap hour, then switches the socket on when it\'s cheap now', async () => {
  const s0 = await state();
  const extra = s0.cheapRuns.find((r) => r.extra);
  // done by three hours from now: the car's extra cheap hour is the cheapest
  const by = new Intl.DateTimeFormat('en-GB', { timeZone: s0.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(extra.end + 3600000));
  await assert.rejects(en('POST', 'plans', { name: 'X', entity: 'sensor.nope', minutes: 60, by }), /socket or switch/);
  let s = await en('POST', 'plans', { name: 'Dishwasher', entity: 'switch.dishwasher_plug', minutes: 60, by });
  const p = s.plans[0];
  assert.equal(p.next.start, extra.start, JSON.stringify(p.next));
  assert.equal(p.next.avg, 7);
  assert.equal(p.next.running, false);
  // Octopus moves the car's charging to now: the plan goes now too
  await mock('POST', '/reset-calls');
  await mock('POST', '/octopus', { dispatchNow: true });
  s = await until(async () => { const x = await state(); return x.plans[0].next?.running ? x : null; }, 'the plan to start', 40000);
  const calls = await mock('GET', '/calls');
  assert.ok(calls.some((c) => c.domain === 'switch' && c.service === 'turn_on' && c.data.entity_id === 'switch.dishwasher_plug'), JSON.stringify(calls));
  await until(async () => (await state()).plans[0].on === true, 'the socket on');
  // stop it from here: the socket goes off
  s = await en('POST', `plans/${p.id}/skip`);
  assert.equal(s.plans[0].next?.running ?? false, false);
  await until(async () => (await state()).plans[0].on === false, 'the socket off');
  const act = (await en('GET', 'activity')).items.map((e) => e.text);
  assert.ok(act.some((t) => /^Dishwasher: Dishwasher plug on, the cheapest hour before/.test(t)), act.join('\n'));
  assert.ok(act.some((t) => /Dishwasher: stopped from here, Dishwasher plug off/.test(t)), act.join('\n'));
});

await step('phone alerts: cheap electricity now, told once', async () => {
  await mock('POST', '/reset-calls');
  await en('PUT', 'settings', { alerts: { notify: ['notify.mobile_app_toms_iphone'], cheapBelow: 10 } });
  await until(async () => (await mock('GET', '/calls')).some((c) => c.domain === 'notify' && c.data.title === 'Cheap electricity now'), 'the cheap alert', 30000);
  await sleep(1500);
  await en('PUT', 'settings', { bands: { mode: 'auto' } }); // another look
  await sleep(1500);
  const n = (await mock('GET', '/calls')).filter((c) => c.domain === 'notify' && c.data.title === 'Cheap electricity now').length;
  assert.equal(n, 1, 'only once for this stretch');
  const sent = await en('POST', 'alerts/test');
  assert.equal(sent.sent, 1);
  await assert.rejects(en('PUT', 'settings', { bands: { mode: 'fixed', cheap: 30, peak: 20 } }), /below peak/);
});

await step('sensor.home_energy for dashboards: the price, the chart, the car, the plans', async () => {
  const s = await until(async () => { const x = (await mock('GET', '/published')).states['sensor.home_energy']; return x && x.attributes.plans?.length ? x : null; }, 'sensor.home_energy', 30000);
  assert.equal(s.attributes.unit_of_measurement, 'p/kWh');
  assert.ok(Number(s.state) === 7 || Number(s.state) === 26.5, s.state);
  assert.equal(s.attributes.tariff, 'Intelligent Octopus Go');
  assert.ok(s.attributes.rates.length >= 96);
  assert.equal(s.attributes.ev.bump_entity, 'switch.octopus_energy_a1b2c3d4_intelligent_bump_charge');
  assert.equal(s.attributes.plans[0].name, 'Dishwasher');
  assert.ok(s.attributes.today_cost > 0);
  assert.match(s.attributes.summary, /p now/);
});

await step('settings: the sources found, the phones and the sockets for plans', async () => {
  const v = await en('GET', 'settings');
  assert.equal(v.meters.length, 1);
  assert.equal(v.meters[0].tariff, 'Intelligent Octopus Go');
  assert.equal(v.dashboard.electricity.length, 1);
  assert.equal(v.dashboard.electricity[0].cost, true);
  assert.equal(v.dashboard.devices, 3);
  assert.equal(v.ev, true);
  assert.ok(v.phones.some((p) => p.service === 'notify.mobile_app_toms_iphone' && p.phone));
  assert.equal(v.switches[0].socket, true, 'sockets first');
  assert.ok(!v.switches.some((x) => x.entity.includes('octopus_energy')), 'not Octopus\'s own switches');
});

await step('Agile: prices that change, cheapest times, peak, and paid to use', async () => {
  await mock('POST', '/octopus', { tariff: 'agile', tomorrow: true, ev: false });
  const s = await until(async () => { const x = await state(); return x.tariff?.name === 'Agile Octopus' && x.rates.some((r) => r.b === 'free') ? x : null; }, 'Agile prices');
  assert.equal(s.limits.kind, 'varies');
  assert.ok(s.rates.some((r) => r.b === 'peak'));
  assert.equal(s.ev, null);
  assert.equal(s.cheapest.length, 3);
  assert.ok(s.cheapest[0].avg <= s.cheapest[2].avg);
});

await step('turned off: the dashboard sensor goes, and nothing is switched', async () => {
  await j('PUT', `${APP}/api/house`, { modules: { energy: false } });
  await until(async () => !(await mock('GET', '/published')).states['sensor.home_energy'], 'sensor.home_energy removed', 20000);
  await assert.rejects(en('POST', 'plans', { name: 'Y', entity: 'switch.dishwasher_plug', minutes: 60, by: '07:00' }), /turned off/);
  await mock('POST', '/octopus', { on: false });
});

console.log(`\n${passed} energy checks passed`);
