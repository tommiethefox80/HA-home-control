// Plans: switching a socket on at the cheapest time before a deadline, and off again after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Engine } from '../../src/energy/engine.js';
import { Store } from '../../src/energy/store.js';

const SLOT = 30 * 60000;
// far from the real date: adding a plan also looks at the real clock, which mustn't land in these prices
const T0 = Date.UTC(2030, 0, 15, 0, 0);
const at = (h, m = 0) => T0 + (h * 60 + m) * 60000;
const K = 'abc_123';
const quiet = { info() {}, warn() {}, error() {} };

// Intelligent Octopus Go rates for a day (7p 23:30–05:30, else 26.5p; 7p while the car charges 18:00–19:00 on day 0)
function day(start) {
  const out = [];
  for (let t = start; t < start + 86400000; t += SLOT) {
    const m = ((t - T0) / 60000) % 1440;
    const car = t >= at(18) && t < at(19);
    out.push({ start: new Date(t).toISOString(), end: new Date(t + SLOT).toISOString(), value_inc_vat: m >= 1410 || m < 330 || car ? 0.07 : 0.265, is_intelligent_adjusted: car });
  }
  return out;
}

class StubHa extends EventEmitter {
  constructor() { super(); this.calls = []; this.connected = true; }
  callService(domain, service, data) { this.calls.push({ domain, service, entity: data.entity_id }); return Promise.resolve(); }
  send() { return Promise.reject(new Error('not here')); }
}

function setup(days = [T0, T0 + 86400000]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-energy-'));
  const ha = new StubHa();
  const store = new Store(dir, quiet);
  const e = new Engine({ ha, store, log: quiet });
  e.ready = true; e.tz = 'UTC';
  const st = (id, state, attributes = e.states.get(id)?.attributes || {}) => e.states.set(id, { entity_id: id, state, attributes, last_updated: String(Math.random()) });
  st(`sensor.octopus_energy_electricity_${K}_current_rate`, '0.265', { tariff: 'E-1R-INTELLI-VAR-24-10-29-N' });
  st(`event.octopus_energy_electricity_${K}_current_day_rates`, 'x', { rates: day(days[0]) });
  st(`event.octopus_energy_electricity_${K}_next_day_rates`, 'x', { rates: days[1] ? day(days[1]) : [] });
  st('switch.dishwasher', 'off', { friendly_name: 'Dishwasher plug' });
  st('switch.immersion', 'off', { friendly_name: 'Immersion' });
  return { e, ha, st, store };
}

test('a plan waits for the cheapest time, switches on, then off, then plans tomorrow', () => {
  const { e, ha, st } = setup();
  const now0 = at(15);
  e.addPlan({ name: 'Dishwasher', entity: 'switch.dishwasher', minutes: 60, by: '07:00' });
  e.tick(now0);
  const pl = e.data.plans[0];
  // the car's extra cheap hour, 18:00–19:00, is the cheapest before 07:00 tomorrow
  assert.equal(pl.next.start, at(18));
  assert.equal(pl.next.avg, 7);
  assert.equal(pl.next.provisional, false);
  assert.ok(pl.next.average > 15, `the average between now and then is much higher (${pl.next.average})`);
  assert.equal(ha.calls.length, 0);
  // 18:00: on
  e.tick(at(18, 0) + 5000);
  assert.deepEqual(ha.calls, [{ domain: 'switch', service: 'turn_on', entity: 'switch.dishwasher' }]);
  assert.ok(pl.run);
  st('switch.dishwasher', 'on');
  e.tick(at(18, 30));
  assert.equal(ha.calls.length, 1, 'switched once');
  // 19:00: off, done; tomorrow's run is worked out (rates known only up to the end of tomorrow)
  e.tick(at(19, 0) + 5000);
  assert.deepEqual(ha.calls[1], { domain: 'switch', service: 'turn_off', entity: 'switch.dishwasher' });
  assert.equal(pl.run, null);
  assert.match(pl.last.text, /^Ran 18:00–19:00 at 7p average/);
  e.tick(at(19, 1));
  assert.equal(pl.next.key, '2030-01-17', 'the next one is for 07:00 the day after tomorrow');
  assert.equal(pl.next.provisional, true, 'not all its prices are known yet');
  assert.equal(pl.next.start, at(23) + 86400000, 'for now, the best of what is known (the night after is not)');
  const lines = e.data.events.map((x) => x.text);
  assert.ok(lines.some((t) => /Dishwasher: Dishwasher plug on, the cheapest hour before 07:00, 18:00–19:00 at 7p average/.test(t)), lines.join('\n'));
  assert.ok(lines.some((t) => /Dishwasher: done, Dishwasher plug off/.test(t)), lines.join(" | "));
});

test('it doesn\'t start on a guess while later prices are still to come', () => {
  // only today's prices known; the deadline's tomorrow morning, when the night is cheapest
  const { e, ha } = setup([T0, null]);
  e.addPlan({ name: 'Dishwasher', entity: 'switch.dishwasher', minutes: 60, by: '07:00' });
  e.tick(at(19, 10)); // after the car's hour: the cheapest known is 23:30–00:00 then unknown
  const pl = e.data.plans[0];
  assert.equal(pl.next?.provisional ?? true, true);
  e.tick(at(23, 30) + 1000);
  // 23:30 is the cheapest known, but the rest of the night isn't known: still waits (it isn't urgent)
  assert.equal(ha.calls.length, 0);
  // close to the deadline it goes with what it knows
  e.tick(T0 + 86400000 + 4.5 * 3600000);
  assert.equal(ha.calls.length, 0, 'nothing known after midnight: nothing to run on');
});

test('split runs, a price limit, and once only', () => {
  const { e, ha, st } = setup();
  e.addPlan({ name: 'Hot water', entity: 'switch.immersion', minutes: 120, by: '06:00', together: false, repeat: 'once' });
  e.tick(at(15));
  const pl = e.data.plans[0];
  assert.deepEqual(pl.next.slots, [[at(18), at(19)], [at(23, 30), at(24, 30)]]);
  e.tick(at(18) + 1000);
  st('switch.immersion', 'on');
  e.tick(at(19) + 1000);
  assert.deepEqual(ha.calls.map((c) => c.service), ['turn_on', 'turn_off'], 'off between the two');
  st('switch.immersion', 'off');
  e.tick(at(23, 30) + 1000);
  st('switch.immersion', 'on');
  e.tick(at(24, 30) + 1000);
  assert.deepEqual(ha.calls.map((c) => c.service), ['turn_on', 'turn_off', 'turn_on', 'turn_off']);
  assert.equal(pl.enabled, false, 'once: off after it ran');
  // a limit nothing meets: not run, and said so
  e.addPlan({ name: 'Car top-up', entity: 'switch.dishwasher', minutes: 60, by: '17:00', maxP: 5 });
  e.tick(at(25));
  const p2 = e.data.plans[1];
  assert.match(p2.last.text, /no time at 5p or less/);
});

test('a socket already on is left on at the end (it wasn\'t switched on here); skip and stop', () => {
  const { e, ha, st } = setup();
  st('switch.dishwasher', 'on');
  e.addPlan({ name: 'Dishwasher', entity: 'switch.dishwasher', minutes: 60, by: '07:00' });
  e.tick(at(18) + 1000);
  e.tick(at(19) + 1000);
  assert.equal(ha.calls.length, 0, 'never switched: it was already on');
  st('switch.dishwasher', 'off');
  const pl = e.data.plans[0];
  // skip the next one
  e.tick(at(20));
  const key = pl.next.key;
  e.skipPlan(pl.id);
  assert.equal(pl.done[key], 'skipped');
  // stop one that's running
  e.addPlan({ name: 'Now', entity: 'switch.immersion', minutes: 60, by: '01:00' });
  e.tick(at(23, 30) + 1000);
  const p2 = e.data.plans[1];
  assert.ok(p2.run);
  e.skipPlan(p2.id);
  assert.equal(p2.run, null);
  assert.deepEqual(ha.calls.map((c) => `${c.service} ${c.entity}`), ['turn_on switch.immersion', 'turn_off switch.immersion']);
});

test('a plan that needs a socket Home Assistant has, and sensible lengths and times', () => {
  const { e } = setup();
  assert.throws(() => e.addPlan({ name: 'X', entity: 'switch.nope', minutes: 60, by: '07:00' }), /socket or switch/);
  assert.throws(() => e.addPlan({ name: 'X', entity: 'switch.dishwasher', minutes: 900, by: '07:00' }), /12 hours/);
  assert.throws(() => e.addPlan({ name: 'X', entity: 'switch.dishwasher', minutes: 60, by: '7am' }), /07:00/);
  assert.throws(() => e.addPlan({ name: ' ', entity: 'switch.dishwasher', minutes: 60, by: '07:00' }), /name/);
  const p = e.addPlan({ name: 'X', entity: 'switch.dishwasher', minutes: 50, by: '07:00' });
  assert.equal(p.minutes, 60, 'rounded to the half hour');
});
