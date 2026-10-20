// Spotting what people keep changing by hand, and turning it into schedule changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusters, daysFor, planDay, findPatterns, daysText, evidenceText, whenParts, Patterns, hhmm } from '../src/patterns.js';
import { zonedToUtc } from '../src/lighting/schedule.js';

const TZ = 'Europe/London';
const M = 60000; const H = 3600000; const DAY = 86400000;
// Tuesday 4 Nov 2025, 03:30 (no clock change in the month before)
const NOW = zonedToUtc(2025, 11, 4, 3 * 60 + 30, TZ);
const at = (daysAgo, hhmmStr) => {
  const [h, m] = hhmmStr.split(':').map(Number);
  const d = new Date(NOW - daysAgo * DAY);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const get = (t) => Number(p.find((x) => x.type === t).value);
  return zonedToUtc(get('year'), get('month'), get('day'), h * 60 + m, TZ);
};
const ev = (t, cls = 'off', value = 0) => ({ at: t, ...whenParts(t, TZ), cls, value });
// days ago of the last few Fridays before Tue 4 Nov: 31 Oct (4), 24 Oct (11), 17 Oct (18), 10 Oct (25)
const FRIS = [25, 18, 11, 4]; // oldest first, as they'd happen

test('days in words', () => {
  assert.equal(daysText([0, 1, 2, 3, 4, 5, 6]), 'every day');
  assert.equal(daysText([0, 1, 2, 3, 4]), 'on weekdays');
  assert.equal(daysText([5, 6]), 'at weekends');
  assert.equal(daysText([4]), 'on Fridays');
  assert.equal(daysText([4, 5]), 'on Fridays and Saturdays');
  assert.equal(daysText([0, 2, 4]), 'on Mondays, Wednesdays and Fridays');
  assert.equal(evidenceText({ hits: 4, of: 4, unit: 'Fridays' }), 'on each of the last 4 Fridays');
  assert.equal(evidenceText({ hits: 3, of: 4, unit: 'Fridays' }), 'on 3 of the last 4 Fridays');
});

test('clusters: the same kind of change at about the same time', () => {
  const c = clusters([ev(at(4, '22:10')), ev(at(11, '22:25')), ev(at(18, '21:55')), ev(at(4, '07:00')), ev(at(4, '22:20'), 'on')]);
  assert.equal(c.length, 3);
  const late = c.find((x) => x.cls === 'off' && x.first > 600);
  assert.equal(late.events.length, 3);
});

test('a weekday pattern: 3 or 4 of the last 4 Fridays; not 2', () => {
  const since = NOW - 40 * DAY;
  const four = { events: FRIS.map((d) => ev(at(d, '22:15'))) };
  assert.deepEqual(daysFor(four, { now: NOW, tz: TZ, since }).days, [4]);
  assert.equal(daysFor(four, { now: NOW, tz: TZ, since }).hits, 4);
  const three = { events: [25, 11, 4].map((d) => ev(at(d, '22:15'))) };
  const d3 = daysFor(three, { now: NOW, tz: TZ, since });
  assert.deepEqual(d3.days, [4]);
  assert.equal(evidenceText(d3), 'on 3 of the last 4 Fridays');
  assert.equal(daysFor({ events: [4, 18].map((d) => ev(at(d, '22:15'))) }, { now: NOW, tz: TZ, since }), null);
  // only watching for two Fridays: not enough yet
  assert.equal(daysFor({ events: [4, 11].map((d) => ev(at(d, '22:15'))) }, { now: NOW, tz: TZ, since: NOW - 12 * DAY }), null);
});

test('most days, weekdays, weekend days', () => {
  const since = NOW - 40 * DAY;
  const daily = { events: [1, 2, 3, 4, 5, 7].map((d) => ev(at(d, '21:00'), 'up', 21)) };
  assert.deepEqual(daysFor(daily, { now: NOW, tz: TZ, since }).days, [0, 1, 2, 3, 4, 5, 6]);
  // Mon 3, Fri 31, Thu 30, Wed 29 Nov/Oct (1, 4, 5, 6 days ago); Tue 28 (7) missed
  const weekdays = { events: [1, 4, 5, 6].map((d) => ev(at(d, '07:00'), 'on', 60)) };
  const w = daysFor(weekdays, { now: NOW, tz: TZ, since });
  assert.deepEqual(w.days, [0, 1, 2, 3, 4]);
  assert.equal(w.unit, 'weekdays');
  // Sat 1, Sun 2, Sat 25, Sun 26 Oct (3, 2, 10, 9 days ago): 3 of 4
  const weekend = { events: [2, 3, 10].map((d) => ev(at(d, '09:00'), 'up', 21)) };
  assert.deepEqual(daysFor(weekend, { now: NOW, tz: TZ, since }).days, [5, 6]);
});

const same = (a, b) => Math.abs(a - b) < 0.25;
const pts = (...p) => p.map(([t, v]) => ({ min: Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), value: v }));

test('a day\'s new schedule: moved earlier, a scheduled change put right, added with an end', () => {
  // heating: 17:30 → 21°; turned up to 21° at 17:00 → start at 17:00 instead
  let p = planDay(pts(['06:30', 20], ['08:30', 16], ['17:30', 21], ['22:30', 15]), 15, { min: 17 * 60, value: 21 }, same);
  assert.equal(p.how, 'moved');
  assert.equal(hhmm(p.was), '17:30');
  assert.deepEqual(p.points.map((x) => [hhmm(x.min), x.value]), [['06:30', 20], ['08:30', 16], ['17:00', 21], ['22:30', 15]]);
  // turned down to 17° at 21:30 → added
  p = planDay(pts(['06:30', 20], ['17:30', 21], ['22:30', 15]), 15, { min: 21 * 60 + 30, value: 17 }, same);
  assert.equal(p.how, 'added');
  assert.deepEqual(p.points.map((x) => hhmm(x.min)), ['06:30', '17:30', '21:30', '22:30']);
  // the schedule goes to 18° at 17:00 and someone puts it to 20° at 17:10 → 17:00 becomes 20°
  p = planDay(pts(['06:30', 20], ['17:00', 18], ['22:30', 15]), 15, { min: 17 * 60 + 10, value: 20 }, same);
  assert.equal(p.how, 'changed');
  assert.equal(p.wasValue, 18);
  assert.deepEqual(p.points.map((x) => [hhmm(x.min), x.value]), [['06:30', 20], ['17:00', 20], ['22:30', 15]]);
  // a boost at 07:00 to 22° for half an hour → 07:00 22°, 07:30 back to 20°
  p = planDay(pts(['06:30', 20], ['08:30', 16]), 15, { min: 7 * 60, value: 22, endMin: 7 * 60 + 30 }, same);
  assert.deepEqual(p.points.map((x) => [hhmm(x.min), x.value]), [['06:30', 20], ['07:00', 22], ['07:30', 20], ['08:30', 16]]);
  // already what the schedule does
  assert.equal(planDay(pts(['06:30', 20]), 15, { min: 7 * 60, value: 20 }, same), null);
});

test('findPatterns: when, what and the end', () => {
  const evs = FRIS.map((d, i) => ({ ...ev(at(d, ['22:10', '22:20', '22:15', '22:12'][i]), 'down', [17, 17, 17.5, 17][i]), endMin: null }));
  const [f] = findPatterns(evs, { now: NOW, tz: TZ, since: NOW - 40 * DAY });
  assert.equal(hhmm(f.min), '22:15');
  assert.deepEqual(f.days, [4]);
  assert.deepEqual(f.values.sort(), [17, 17, 17, 17.5]);
  assert.equal(f.endMin, null);
});

// ---------- the watcher, with a heating-like stand-in ----------

function heatingLike(mode = 'suggest') {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const week = Object.fromEntries(DAYS.map((d) => [d, [{ time: '06:30', temp: 20 }, { time: '17:30', temp: 21 }, { time: '22:30', temp: 15 }]]));
  const room = { id: 'bed', name: 'Main Bedroom', mode };
  const notes = [];
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const a = {
    items: () => [room],
    dayPoints: (id, dow) => week[DAYS[dow]].map((p) => ({ min: toMin(p.time), value: p.temp, raw: p })),
    cls: (v, base) => (v >= base + 0.5 ? 'up' : v <= base - 0.5 ? 'down' : null),
    same,
    typical: (values) => Math.round([...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] * 2) / 2,
    words: ({ item, value, min, when, evidence, plan }) => ({ why: `${item.name} was turned to ${value}° ${evidence}.`, change: `Make it ${value}° from ${hhmm(min)} ${when}${plan.how === 'moved' ? ` instead of ${hhmm(plan.was)}` : ''}` }),
    write: (id, days, note) => { for (const [d, p] of Object.entries(days)) week[DAYS[d]] = p.map((x) => ({ time: hhmm(x.min), temp: x.value })); notes.push(note); },
    read: (id, days) => Object.fromEntries(days.map((d) => [d, JSON.parse(JSON.stringify(week[DAYS[d]]))])),
    writeRaw: (id, days, note) => { for (const [d, p] of Object.entries(days)) week[DAYS[d]] = p; notes.push(note); },
  };
  return { a, week, room, notes };
}

test('the watcher: suggests, applies, won\'t suggest it again, and undoes', () => {
  let now = NOW - 40 * DAY;
  const P = new Patterns({ tz: () => TZ, now: () => now, log: {} });
  const { a, week, notes } = heatingLike();
  P.register('heating', a);
  // turned up to 21° at about 17:00 on the last four Fridays (the schedule has 20° until 17:30)
  for (const d of FRIS) {
    now = at(d, '17:02');
    P.record('heating', { item: 'bed', at: now, value: 21, base: 20, until: at(d, '17:30') });
  }
  // a fiddle that was put back within five minutes doesn't count
  now = at(1, '12:00');
  P.record('heating', { item: 'bed', at: now, value: 25, base: 20, until: now + H });
  P.ended('heating', 'bed', now + 4 * M);
  now = NOW;
  P.run();
  const v = P.view('heating');
  assert.equal(v.suggestions.length, 1, JSON.stringify(v));
  const s = v.suggestions[0];
  assert.equal(s.change, 'Make it 21° from 17:00 on Fridays instead of 17:30');
  assert.equal(s.why, 'Main Bedroom was turned to 21° on each of the last 4 Fridays.');
  P.act('heating', s.id, 'apply');
  assert.deepEqual(week.fri.map((p) => `${p.time} ${p.temp}`), ['06:30 20', '17:00 21', '22:30 15']);
  assert.deepEqual(week.thu.map((p) => p.time), ['06:30', '17:30', '22:30'], 'other days left alone');
  assert.match(notes[0], /^Main Bedroom: schedule changed from a suggestion: make it 21° from 17:00 on Fridays instead of 17:30, as Main Bedroom was turned to 21° on each of the last 4 Fridays\.$/);
  P.run();
  assert.equal(P.view('heating').suggestions.length, 0, 'done: not suggested again');
  assert.equal(P.view('heating').applied.length, 1);
  P.undo('heating', s.id);
  assert.deepEqual(week.fri.map((p) => p.time), ['06:30', '17:30', '22:30']);
  P.run();
  assert.equal(P.view('heating').suggestions.length, 0, 'undone: not suggested again for a while');
});

test('the watcher: "Not now", "Don\'t suggest again", changing automatically, and several presses as one change', () => {
  let now = NOW - 40 * DAY;
  const P = new Patterns({ tz: () => TZ, now: () => now, log: {} });
  const h = heatingLike();
  P.register('heating', h.a);
  for (const d of FRIS) {
    // + pressed three times within a minute: one change, to 21.5°
    for (const [i, t] of [21, 21.5, 22].entries()) { now = at(d, '21:00') + i * 20000; P.record('heating', { item: 'bed', at: now, value: t === 22 ? 21.5 : t, base: 21, until: at(d, '22:30') }); }
  }
  now = NOW;
  P.run();
  let [s] = P.view('heating').suggestions;
  assert.equal(s.value, 21.5);
  assert.equal(P.data.parts.heating.events.length, 4, 'three presses are one change');
  P.act('heating', s.id, 'later');
  P.run();
  assert.equal(P.view('heating').suggestions.length, 0, 'not now');
  // a week on, it's back: still 3 of the last 4 Fridays (the latest one missed)
  now = NOW + 8 * DAY;
  P.run();
  assert.equal(P.view('heating').suggestions.length, 1, 'back after a week');
  assert.match(P.view('heating').suggestions[0].why, /on 3 of the last 4 Fridays/);
  // automatic: changed straight away, with an Undo
  now = NOW - 40 * DAY;
  const P2 = new Patterns({ tz: () => TZ, now: () => now, log: {} });
  const h2 = heatingLike('auto');
  P2.register('heating', h2.a);
  for (const d of FRIS) { now = at(d, '21:00'); P2.record('heating', { item: 'bed', at: now, value: 21.5, base: 21, until: at(d, '22:30') }); }
  now = NOW;
  P2.run();
  assert.equal(P2.view('heating').suggestions.length, 0);
  assert.equal(P2.view('heating').applied[0].auto, true);
  assert.deepEqual(h2.week.fri.map((p) => `${p.time} ${p.temp}`), ['06:30 20', '17:30 21', '21:00 21.5', '22:30 15']);
  assert.match(h2.notes[0], /schedule changed automatically/);
  // and "Don't suggest again"
  now = NOW - 40 * DAY;
  const P3 = new Patterns({ tz: () => TZ, now: () => now, log: {} });
  const h3 = heatingLike();
  P3.register('heating', h3.a);
  for (const d of FRIS) { now = at(d, '21:00'); P3.record('heating', { item: 'bed', at: now, value: 21.5, base: 21, until: at(d, '22:30') }); }
  now = NOW;
  P3.run();
  [s] = P3.view('heating').suggestions;
  P3.act('heating', s.id, 'never');
  // eight weeks on, still Fridays
  for (const d of FRIS) { now = at(d - 56, '21:00'); P3.record('heating', { item: 'bed', at: now, value: 21.5, base: 21, until: at(d - 56, '22:30') }); }
  now = NOW + 56 * DAY;
  P3.run();
  assert.equal(P3.view('heating').suggestions.length, 0, 'never again');
});

test('a room set to off isn\'t looked at', () => {
  let now = NOW - 40 * DAY;
  const P = new Patterns({ tz: () => TZ, now: () => now, log: {} });
  const h = heatingLike('off');
  P.register('heating', h.a);
  for (const d of FRIS) { now = at(d, '21:00'); P.record('heating', { item: 'bed', at: now, value: 18, base: 21, until: at(d, '22:30') }); }
  now = NOW;
  P.run();
  assert.equal(P.view('heating').suggestions.length, 0);
});

