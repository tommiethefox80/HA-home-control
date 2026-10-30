// Away (or the heating off), and the two days after, aren't the house's usual: a week on Away
// mustn't look like rooms losing heat three times faster than usual, during it or once back.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { recordMode, modeLogFromActivity, unusualSpans, daysTouched, RECOVER_MS } from '../../src/heating/modelog.js';
import { buildRoomStats } from '../../src/heating/roomstats.js';
import { HeatLossWatch } from '../../src/heating/heatloss.js';

const H = 3600000; const D = 24 * H;

test('the log: Away and off kept, back to Schedules closes them', () => {
  const t0 = Date.UTC(2026, 9, 20, 8);
  let l = recordMode([], 'auto', t0);
  assert.deepEqual(l, []);
  l = recordMode(l, 'away', t0 + H);
  l = recordMode(l, 'away', t0 + 2 * H); // no change
  l = recordMode(l, 'auto', t0 + 5 * D);
  l = recordMode(l, 'off', t0 + 6 * D);
  assert.deepEqual(l, [{ mode: 'away', from: t0 + H, to: t0 + 5 * D }, { mode: 'off', from: t0 + 6 * D, to: null }]);
  // older than 90 days: gone
  l = recordMode(l, 'auto', t0 + 100 * D);
  assert.deepEqual(l, [{ mode: 'off', from: t0 + 6 * D, to: t0 + 100 * D }]);
});

test('filled in from Activity, for before it was kept', () => {
  const t0 = Date.UTC(2026, 9, 24, 9);
  const notes = [ // newest first, as Activity keeps them
    { at: t0 + 6 * D, msg: 'Lounge: schedule updated' },
    { at: t0 + 5 * D, msg: 'Mode: Schedules' },
    { at: t0 + 4 * D, msg: 'Away mode ended, back to schedules' },
    { at: t0 + 2 * D, msg: 'Mode: Away until Mon 09:00' },
    { at: t0, msg: 'Mode: Away (automatic: everyone is out)' },
  ];
  assert.deepEqual(modeLogFromActivity(notes, { current: 'auto' }), [{ mode: 'away', from: t0, to: t0 + 4 * D }]);
  // on Away now, from before Activity goes back: from its oldest note
  assert.deepEqual(modeLogFromActivity([{ at: t0 + D, msg: 'x' }, { at: t0, msg: 'y' }], { current: 'away', now: t0 + 2 * D }), [{ mode: 'away', from: t0, to: null }]);
});

test('the times left out: Away or off, and the two days after, merged', () => {
  const t0 = Date.UTC(2026, 9, 24, 9);
  const l = [{ mode: 'away', from: t0, to: t0 + 4 * D }, { mode: 'off', from: t0 + 5 * D, to: t0 + 5 * D + H }];
  assert.deepEqual(unusualSpans(l, t0 - D, t0 + 10 * D), [[t0, t0 + 5 * D + H + RECOVER_MS]]);
  assert.deepEqual(unusualSpans(l, t0 + 8 * D, t0 + 10 * D), []);
  // still on Away: up to now (and after)
  assert.deepEqual(unusualSpans([{ mode: 'away', from: t0, to: null }], t0 - D, t0 + D, { now: t0 + D }), [[t0, t0 + D]]);
  assert.deepEqual([...daysTouched([[t0, t0 + 25 * H]], 'Europe/London')], ['2026-10-24', '2026-10-25']);
});

// A room that loses 3% of its gap to outside an hour, cooling each night; during Away it loses
// 12% (short bursts of heat into cold walls), and for the two days after, 9%.
function house({ awayFrom, awayTo }) {
  const now = Date.UTC(2026, 9, 30, 20);
  const from = now - 7 * D;
  const rows = []; const out = []; const boiler = [];
  const kAt = (t) => (t >= awayFrom && t < awayTo ? 0.12 : t >= awayTo && t < awayTo + RECOVER_MS ? 0.09 : 0.03);
  for (let t = from - D; t <= now; t += 5 * 60000) {
    const h = new Date(t).getUTCHours();
    // heated 17:00–22:00 each day to 20°, cooling the rest (no heat)
    const heating = h >= 17 && h < 22;
    rows.push({ t, heating });
  }
  let temp = 20;
  const room = [];
  for (const r of rows) {
    if (r.heating) temp = 20; else temp = 8 + (temp - 8) * Math.exp(-kAt(r.t) * (5 / 60));
    room.push({ s: String(Math.round(temp * 100) / 100), lu: r.t / 1000 });
    boiler.push({ s: 'heat', a: { hvac_action: r.heating ? 'heating' : 'idle' }, lu: r.t / 1000 });
  }
  out.push({ s: 'cloudy', a: { temperature: 8 }, lu: (from - D) / 1000 });
  const calls = rows.reduce((a, r, i) => {
    if (r.heating && !rows[i - 1]?.heating) a.push([r.t, null]);
    if (!r.heating && rows[i - 1]?.heating) a[a.length - 1][1] = r.t;
    return a;
  }, []).map(([a, b]) => [a, b ?? now]);
  const log = [{ mode: 'away', from: awayFrom, to: awayTo }];
  const engine = {
    ha: { timeZone: 'UTC', states: new Map(), get: () => null, send: async () => ({ 'sensor.room': room, 'weather.home': out, 'climate.boiler': boiler }) },
    s: { outsideEntity: 'weather.home', boiler: { entity: 'climate.boiler' } },
    zones: [{ id: 'bed', name: 'Bedroom', enabled: true, sensor: 'sensor.room', trvs: [] }],
    callLog: { started: from - D, keepDays: () => 7, intervals: () => calls },
    dailyLog: { days: {} },
    openRadiator: () => false,
    unusualSpans: (a, b) => unusualSpans(log, a, b, { now }),
  };
  return { engine, now, log };
}

test('a week on Away isn\'t counted as a room losing heat faster, during it or once back', async () => {
  const now0 = Date.UTC(2026, 9, 30, 20);
  // away Sat 24th 10:00 to Thu 29th 15:00: back yesterday afternoon
  const { engine, now, log } = house({ awayFrom: Date.UTC(2026, 9, 24, 10), awayTo: Date.UTC(2026, 9, 29, 15) });
  mock.timers.enable({ apis: ['Date'], now: now0 });
  try {
    // without leaving Away out, as before: the last two days look far faster than usual
    const before = await buildRoomStats({ ...engine, unusualSpans: () => [] }, { days: 7 });
    const days = Object.fromEntries(before.rooms[0].daily.map((d) => [d.day, d.k]));
    assert.ok(days['2026-10-26'] > 0.1, JSON.stringify(days));
    // with: only the usual days are there
    const stats = await buildRoomStats(engine, { days: 7 });
    const kept = stats.rooms[0].daily.map((d) => d.day);
    assert.deepEqual(kept, ['2026-10-23', '2026-10-24'], 'before Away (and the morning it started)');
    assert.ok(stats.rooms[0].daily.every((d) => Math.abs(d.k - 0.03) < 0.005), JSON.stringify(stats.rooms[0].daily));
    assert.ok(Math.abs(stats.rooms[0].loss.k - 0.03) < 0.005, 'the room\'s own figure isn\'t thrown either');
    assert.equal(stats.unusual.length, 1);

    // heat-loss alerts: days already kept from before (Away, at 0.12) are dropped, and the room isn't
    // compared until two days after coming back
    const w = new HeatLossWatch(null);
    for (let i = 3; i <= 30; i++) {
      const k = new Date(now - i * D).toISOString().slice(0, 10);
      (w.days.bed ||= {})[k] = { k: 0.03, kLow: 0.028, n: 3, wind: null };
    }
    for (const k of ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) w.days.bed[k] = { k: 0.12, kLow: 0.11, n: 3, wind: null };
    let r = w.check(['bed'], { now, tz: 'UTC' });
    assert.equal(w.state.bed.elevated, true, 'as it was: the notice Tom saw');
    const skip = daysTouched(unusualSpans(log, now - 60 * D, now, { now }), 'UTC');
    w.update(stats, now, { skip });
    assert.equal(w.days.bed['2026-10-27'], undefined);
    assert.equal(w.days.bed['2026-10-30'], undefined);
    assert.equal(w.days.bed['2026-10-20'].k, 0.03, 'usual days kept');
    r = w.check(['bed'], { now, tz: 'UTC', skip });
    assert.deepEqual(r.alerts, []);
    assert.equal(w.state.bed.elevated, false, 'the notice goes');
    assert.equal(w.state.bed.settling, true);
    assert.deepEqual(w.elevated(), []);
  } finally { mock.timers.reset(); }
});
