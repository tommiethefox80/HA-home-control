import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRates, rateAt, nextChange, knownUntil, bandLimits, bandOf, averageOver, cheapest, tariffName } from '../../src/energy/rates.js';

const SLOT = 30 * 60000;
const T0 = Date.UTC(2026, 9, 17, 0, 0); // midnight (UTC: the maths doesn't care about time zones)
const at = (h, m = 0) => T0 + (h * 60 + m) * 60000;
// Intelligent Octopus Go: 7p 23:30–05:30, 26.5p otherwise, and 7p while the car charges (here 18:00–19:00)
function iog() {
  const out = [];
  for (let t = T0; t < T0 + 48 * 3600000; t += SLOT) {
    const m = ((t - T0) / 60000) % 1440;
    const car = t >= at(18) && t < at(19);
    out.push({ start: new Date(t).toISOString(), end: new Date(t + SLOT).toISOString(), value_inc_vat: m >= 1410 || m < 330 || car ? 0.07 : 0.265, is_intelligent_adjusted: car });
  }
  return out;
}
// an Agile-ish day: varies every half hour, a peak 16:00–19:00, a dip below zero at 13:00
function agile() {
  const out = [];
  for (let t = T0; t < T0 + 24 * 3600000; t += SLOT) {
    const h = (t - T0) / 3600000;
    const p = h >= 13 && h < 13.5 ? -0.015 : h >= 16 && h < 19 ? 0.34 + (h % 1) * 0.02 : h < 5 ? 0.1 + h * 0.004 : 0.18 + (h % 3) * 0.01;
    out.push({ start: new Date(t).toISOString(), end: new Date(t + SLOT).toISOString(), value_inc_vat: p });
  }
  return out;
}

test('rates are read in pence, merged and in order', () => {
  const day = iog();
  const r = parseRates(day.slice(48), day.slice(0, 50)); // overlapping lists
  assert.equal(r.length, 96);
  assert.equal(r[0].start, T0);
  assert.equal(r[0].p, 7);
  assert.equal(r[20].p, 26.5);
  assert.equal(rateAt(r, at(18, 10)).adjusted, true);
  assert.deepEqual(parseRates([{ start: 'x', end: 'y', value_inc_vat: 1 }, null]), []);
});

test('when the price next changes, and how far ahead prices are known', () => {
  const r = parseRates(iog());
  assert.deepEqual(nextChange(r, at(12)), { at: at(18), p: 7 });
  assert.deepEqual(nextChange(r, at(18, 5)), { at: at(19), p: 26.5 });
  assert.equal(knownUntil(r, at(12)), T0 + 48 * 3600000);
  const gap = r.filter((x) => x.start !== at(20)); // a missing half hour
  assert.equal(knownUntil(gap, at(12)), at(20));
  assert.deepEqual(nextChange(gap, at(19, 10)), { at: at(20), p: null });
});

test('bands: two rates are cheap and standard; Agile has cheap and peak; one rate has none', () => {
  const two = bandLimits(parseRates(iog()));
  assert.deepEqual(two, { cheap: 7, peak: null, kind: 'two' });
  assert.equal(bandOf(7, two), 'cheap');
  assert.equal(bandOf(26.5, two), 'standard');
  const ag = parseRates(agile());
  const lim = bandLimits(ag);
  assert.equal(lim.kind, 'varies');
  assert.equal(bandOf(rateAt(ag, at(17)).p, lim), 'peak');
  assert.equal(bandOf(rateAt(ag, at(2)).p, lim), 'cheap');
  assert.equal(bandOf(rateAt(ag, at(13, 10)).p, lim), 'free');
  assert.equal(bandOf(rateAt(ag, at(10)).p, lim), 'standard');
  assert.equal(bandLimits(parseRates([{ start: at(0), end: at(24), value_inc_vat: 0.24 }])).kind, 'flat');
  assert.deepEqual(bandLimits([], { cheap: 12, peak: 30 }), { cheap: 12, peak: 30, kind: 'fixed' });
});

test('average price over a time, weighted by how long each lasts', () => {
  const r = parseRates(iog());
  assert.equal(averageOver(r, at(5), at(6)), (7 * 30 + 26.5 * 30) / 60);
  assert.equal(averageOver(r, at(47), at(49)), null, 'past what\'s known');
});

test('cheapest unbroken run: the car\'s extra cheap hour beats waiting for the night', () => {
  const r = parseRates(iog());
  const c = cheapest(r, { from: at(15), to: at(31), minutes: 60 });
  assert.equal(c.start, at(18));
  assert.equal(c.avg, 7);
  // 2 hours: the car's hour isn't long enough, so the night (the earliest of the cheapest)
  const c2 = cheapest(r, { from: at(15), to: at(31), minutes: 120 });
  assert.equal(c2.start, at(23, 30));
  assert.equal(c2.end, at(25, 30));
  // starting part way through a half hour: it can start straight away
  const c3 = cheapest(r, { from: at(23, 40), to: at(29), minutes: 60 });
  assert.equal(c3.start, at(23, 40));
  // too short a window
  assert.equal(cheapest(r, { from: at(15), to: at(15, 30), minutes: 60 }), null);
});

test('cheapest half hours that can be split, and a price limit', () => {
  const r = parseRates(iog());
  const c = cheapest(r, { from: at(15), to: at(30), minutes: 180, together: false });
  assert.deepEqual(c.slots, [[at(18), at(19)], [at(23, 30), at(25, 30)]]);
  assert.equal(c.avg, 7);
  assert.equal(cheapest(r, { from: at(8), to: at(17), minutes: 60, maxP: 10 }), null, 'nothing at 10p or less');
  const ag = parseRates(agile());
  const run = cheapest(ag, { from: at(12), to: at(15), minutes: 60 });
  assert.equal(run.start, at(12, 30), 'the hour with the negative half hour in it');
});

test('tariff names from Octopus tariff codes', () => {
  assert.equal(tariffName('E-1R-INTELLI-VAR-24-10-29-N'), 'Intelligent Octopus Go');
  assert.equal(tariffName('E-1R-AGILE-24-10-01-C'), 'Agile Octopus');
  assert.equal(tariffName('E-1R-GO-VAR-22-10-14-C'), 'Octopus Go');
  assert.equal(tariffName('E-1R-VAR-22-11-01-N'), 'Flexible Octopus');
  assert.equal(tariffName('E-1R-SILVER-FLEX-22-11-25-C'), 'Octopus Tracker');
  assert.equal(tariffName(''), null);
});
