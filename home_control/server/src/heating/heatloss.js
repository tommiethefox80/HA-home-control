// Heat-loss alerts: is a room losing heat faster than it usually does?
//
// Each time the room figures are worked out (roomstats.js, every half hour), each room's heat-loss
// rate for each day (the median of that day's stretches with no heat, at least 5° above outside) is
// kept here, for 60 days, with how windy and how cold it was. A room's usual rate is the median of
// its earlier days (at least four of them) that were about as cold and as windy; its recent rate is
// from today and yesterday, and if that's the set share faster than usual (40% to start with), with
// each of the two days at least half that on its own, it's worth a look: a window or trickle vent left open, or a new draught. Told once,
// then not again for three days.
//
// The weather mustn't set it off:
//   - the recent rate is taken as the lowest it could be if the outside reading were 2° out (a
//     weather service's temperature often is, at your walls), so a mild spell, when the room is only
//     a few degrees above outside, can't make it look leakier than it is;
//   - wind really does make a room lose heat faster, so windy days are compared with the room's own
//     windy days: the usual days with about the same wind (or windier), and if it hasn't had at least
//     four as windy, it isn't compared at all;
//   - a cold spell makes a room *look* leakier with nothing wrong (1.16.2): k is measured from the
//     air, and on cold days the walls and furniture sit cooler under the heated air, so once the
//     radiators go off the air falls into them faster, and colder days mean more heating, so the
//     stretches with no heat come sooner after it. A room's k in mid-November can read a quarter
//     higher than in mid-October, and two-thirds higher in a cold snap, for the same room. So recent
//     days are only compared with the room's days that were as cold (or colder), over 60 days; until
//     it's had four, it isn't compared (the first cold spell of the winter builds its usual).
//
// A notice can be dismissed: it stays hidden until the room is back to its usual, and comes back
// only if it starts losing heat faster again after that.
//
// Away (or the heating off), and the two days after, aren't the house's usual (modelog.js): those
// times are left out of the room figures, and days from before they were left out are dropped.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const VERSION = 2; // 2: days kept with kLow and wind (1.11.2); older days are dropped and rebuilt
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r4 = (x) => Math.round(x * 10000) / 10000;
const dayKey = (t, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

export const COLD_SLACK = 1.5; // usual days up to this much milder still count as "as cold"
export const COLD_NEAR = 3;    // and those within this of the recent outside temperature are preferred

/**
 * Which usual days to compare recent days with, given how cold it's been outside (°, or null).
 * Days as cold or colder (colder days read as losing heat faster, so it's the fair way round), the
 * nearest first. Returns { pool, matched (picked by temperature), cold (no days as cold to compare with) }.
 */
export function asCold(usual, out) {
  if (out == null) return { pool: usual, matched: false, cold: false };
  const fair = usual.filter((x) => x.out != null && x.out <= out + COLD_SLACK);
  if (fair.length < 4) return { pool: [], matched: true, cold: true };
  const near = [...fair].sort((a, b) => Math.abs(a.out - out) - Math.abs(b.out - out));
  const within = near.filter((x) => Math.abs(x.out - out) <= COLD_NEAR);
  return { pool: within.length >= 4 ? within : near.slice(0, Math.max(4, Math.min(near.length, 8))), matched: true, cold: false };
}

/**
 * Which usual days to compare recent days with, given how windy it's been (km/h, or null).
 * Returns { pool, matched (picked by wind), windy (too windy to compare with anything) }.
 */
export function likeForLike(usual, wind) {
  if (wind == null) return { pool: usual, matched: false, windy: false };
  const known = usual.filter((x) => x.wind != null);
  if (known.length < 4) return { pool: usual, matched: false, windy: false }; // too little wind history: as before
  const tol = Math.max(8, wind * 0.35);
  // days about as windy, or windier: comparing with calmer days would blame the wind on the room
  const fair = known.filter((x) => x.wind >= wind - tol);
  if (fair.length < 4) return { pool: [], matched: true, windy: true };
  const near = [...fair].sort((a, b) => Math.abs(a.wind - wind) - Math.abs(b.wind - wind));
  const within = near.filter((x) => Math.abs(x.wind - wind) <= tol);
  return { pool: within.length >= 4 ? within : near.slice(0, 4), matched: true, windy: false };
}

export class HeatLossWatch {
  constructor(dataDir = null) {
    this.file = dataDir ? path.join(dataDir, 'heatloss.json') : null;
    this.days = {};      // zoneId -> { 'YYYY-MM-DD': { k, kLow, n, wind, out } } (out: outside, from 1.16.2)
    this.alerted = {};   // zoneId -> when it was last told
    this.state = {};     // zoneId -> { elevated, percent, recentK, recentKLow, usualK, recentN, usualDays, wind, windMatched, tooWindy }
    this.dismissed = {}; // zoneId -> when its notice was dismissed (until it's back to normal)
    if (this.file) {
      try {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.alerted = d.alerted || {};
        if (d.v === VERSION) {
          this.days = d.days || {};
          this.state = d.state || {};
          this.dismissed = d.dismissed || {};
        }
      } catch { /* none yet */ }
    }
  }

  /**
   * Each room's rate for each day, from the latest room figures (rooms[].daily: [{ day, k, kLow, n, wind }]).
   * `skip`: days that weren't all the house's usual (Away, and the two days after). The latest
   * figures already leave those times out, so such a day keeps only what they have for it (its
   * usual part), and is dropped otherwise, including from before they were left out.
   */
  update(stats, now = Date.now(), { skip = null } = {}) {
    const cutoff = new Date(now - 60 * DAY).toISOString().slice(0, 10);
    for (const r of stats?.rooms || []) {
      const d = (this.days[r.id] ||= {});
      const fresh = new Set();
      for (const x of r.daily || []) if (x.k != null && x.n > 0) { d[x.day] = { k: x.k, kLow: x.kLow ?? x.k, n: x.n, wind: x.wind ?? null, out: x.out ?? null }; fresh.add(x.day); }
      for (const k of Object.keys(d)) if (k < cutoff || (skip?.has(k) && !fresh.has(k))) delete d[k];
    }
    this.save();
  }

  /**
   * Work out each room's state. Returns { alerts: [{ id, percent }] newly worth telling,
   * normal: [ids] back to their usual, colder: [ids] no longer flagged because it's colder than any
   * day they've had to compare with }.
   */
  check(zoneIds, { percent = 40, now = Date.now(), tz = 'UTC', skip = null } = {}) {
    const today = dayKey(now, tz);
    const yesterday = dayKey(now - DAY, tz);
    const oldest = dayKey(now - 60 * DAY, tz);
    const alerts = [];
    const normal = [];
    const colder = [];
    for (const id of zoneIds) {
      const d = this.days[id] || {};
      const recent = [today, yesterday].map((k) => d[k]).filter(Boolean);
      const recentN = recent.reduce((a, x) => a + x.n, 0);
      const usual = Object.entries(d).filter(([k]) => k < yesterday && k >= oldest).map(([, x]) => x);
      const was = this.state[id];
      // both days, so one odd day (a door left open for an hour, a reading that jumped) isn't enough
      if (recent.length < 2 || recentN < 2 || usual.length < 4) {
        // (after Away, the last two days are left out: say so)
        const settling = !!(skip?.has(today) || skip?.has(yesterday));
        this.state[id] = { elevated: false, recentN, usualDays: usual.length, ...(settling ? { settling } : {}) };
        continue; // too little to go on (not 'back to normal', so a dismissal stands)
      }
      const wavg = (list, f) => { const w = list.filter((x) => f(x) != null); const n = w.reduce((a, x) => a + x.n, 0); return n ? w.reduce((a, x) => a + f(x) * x.n, 0) / n : null; };
      const recentK = wavg(recent, (x) => x.k);
      const recentKLow = wavg(recent, (x) => x.kLow ?? x.k);
      const wind = wavg(recent, (x) => x.wind);
      const out = wavg(recent, (x) => x.out);
      const cold = asCold(usual, out);
      const like = cold.cold ? { pool: [], matched: false, windy: false } : likeForLike(cold.pool, wind);
      const usualK = like.pool.length ? median(like.pool.map((x) => x.k)) : null;
      // at least this much faster over the two days, even if the outside reading was 2° out, and
      // each day at least half that on its own (so one odd day isn't enough)
      const pct = usualK ? Math.round((recentKLow / usualK - 1) * 100) : null;
      const each = usualK ? Math.min(...recent.map((x) => Math.round(((x.kLow ?? x.k) / usualK - 1) * 100))) : null;
      const elevated = !cold.cold && !like.windy && pct != null && pct >= percent && each >= percent / 2;
      this.state[id] = {
        elevated, percent: pct, recentK: r4(recentK), recentKLow: r4(recentKLow), usualK: usualK != null ? r4(usualK) : null,
        recentN, usualDays: cold.cold || like.windy ? usual.length : like.pool.length, wind: wind != null ? Math.round(wind) : null,
        windMatched: like.matched, tooWindy: like.windy,
        outside: out != null ? Math.round(out * 10) / 10 : null, coldMatched: cold.matched, newCold: cold.cold,
      };
      if (!elevated) delete this.dismissed[id];
      if (elevated && !this.dismissed[id] && (!this.alerted[id] || now - this.alerted[id] > 3 * DAY)) { this.alerted[id] = now; alerts.push({ id, percent: pct }); }
      // (not compared, because it's colder than any day it's had: no "back to its usual" either)
      if (!elevated && was?.elevated && !cold.cold) normal.push(id);
      if (!elevated && was?.elevated && cold.cold) colder.push(id);
    }
    this.save();
    return { alerts, normal, colder };
  }

  /** Rooms losing heat faster than usual now: [{ id, percent, dismissed, windMatched }]. */
  elevated() {
    return Object.entries(this.state).filter(([, s]) => s.elevated)
      .map(([id, s]) => ({ id, percent: s.percent, dismissed: !!this.dismissed[id], windMatched: !!s.windMatched, coldMatched: !!s.coldMatched, outside: s.outside ?? null }));
  }

  /** Hide a room's notice until it's back to normal. */
  dismiss(id, now = Date.now()) {
    if (!this.state[id]?.elevated) return false;
    this.dismissed[id] = now;
    this.save();
    return true;
  }

  view(id) { return this.state[id] ? { ...this.state[id], dismissed: !!this.dismissed[id] } : null; }

  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, days: this.days, alerted: this.alerted, state: this.state, dismissed: this.dismissed }));
      fs.renameSync(tmp, this.file);
    } catch { /* tried again next time */ }
  }
}
