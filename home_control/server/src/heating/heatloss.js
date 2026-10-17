// Heat-loss alerts: is a room losing heat faster than it usually does?
//
// Each time the room figures are worked out (roomstats.js, every half hour), each room's heat-loss
// rate for each day (the median of that day's stretches with no heat, at least 5° above outside) is
// kept here, for 60 days, with how windy it was. A room's usual rate is the median of its days from
// two days ago back to 30 days ago (at least four of them); its recent rate is from today and
// yesterday (at least two stretches). If the recent rate is the set share faster than usual (40% to
// start with), that's worth a look: a window or trickle vent left open, or a new draught. Told once,
// then not again for three days.
//
// The weather mustn't set it off:
//   - the recent rate is taken as the lowest it could be if the outside reading were 2° out (a
//     weather service's temperature often is, at your walls), so a mild spell, when the room is only
//     a few degrees above outside, can't make it look leakier than it is;
//   - wind really does make a room lose heat faster, so windy days are compared with the room's own
//     windy days: the usual days with about the same wind (or windier), and if it hasn't had at least
//     four as windy, it isn't compared at all.
//
// A notice can be dismissed: it stays hidden until the room is back to its usual, and comes back
// only if it starts losing heat faster again after that.
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
    this.days = {};      // zoneId -> { 'YYYY-MM-DD': { k, kLow, n, wind } }
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

  /** Each room's rate for each day, from the latest room figures (rooms[].daily: [{ day, k, kLow, n, wind }]). */
  update(stats, now = Date.now()) {
    const cutoff = new Date(now - 60 * DAY).toISOString().slice(0, 10);
    for (const r of stats?.rooms || []) {
      const d = (this.days[r.id] ||= {});
      for (const x of r.daily || []) if (x.k != null && x.n > 0) d[x.day] = { k: x.k, kLow: x.kLow ?? x.k, n: x.n, wind: x.wind ?? null };
      for (const k of Object.keys(d)) if (k < cutoff) delete d[k];
    }
    this.save();
  }

  /**
   * Work out each room's state. Returns { alerts: [{ id, percent }] newly worth telling,
   * normal: [ids] back to their usual }.
   */
  check(zoneIds, { percent = 40, now = Date.now(), tz = 'UTC' } = {}) {
    const today = dayKey(now, tz);
    const yesterday = dayKey(now - DAY, tz);
    const oldest = dayKey(now - 30 * DAY, tz);
    const alerts = [];
    const normal = [];
    for (const id of zoneIds) {
      const d = this.days[id] || {};
      const recent = [today, yesterday].map((k) => d[k]).filter(Boolean);
      const recentN = recent.reduce((a, x) => a + x.n, 0);
      const usual = Object.entries(d).filter(([k]) => k < yesterday && k >= oldest).map(([, x]) => x);
      const was = this.state[id];
      if (recentN < 2 || usual.length < 4) {
        this.state[id] = { elevated: false, recentN, usualDays: usual.length };
        continue; // too little to go on (not 'back to normal', so a dismissal stands)
      }
      const avg = (f) => recent.reduce((a, x) => a + f(x) * x.n, 0) / recentN;
      const recentK = avg((x) => x.k);
      const recentKLow = avg((x) => x.kLow ?? x.k);
      const windy = recent.filter((x) => x.wind != null);
      const wind = windy.length ? windy.reduce((a, x) => a + x.wind * x.n, 0) / windy.reduce((a, x) => a + x.n, 0) : null;
      const like = likeForLike(usual, wind);
      const usualK = like.pool.length ? median(like.pool.map((x) => x.k)) : null;
      // at least this much faster, even if the outside reading was 2° out
      const pct = usualK ? Math.round((recentKLow / usualK - 1) * 100) : null;
      const elevated = !like.windy && pct != null && pct >= percent;
      this.state[id] = {
        elevated, percent: pct, recentK: r4(recentK), recentKLow: r4(recentKLow), usualK: usualK != null ? r4(usualK) : null,
        recentN, usualDays: like.windy ? usual.length : like.pool.length, wind: wind != null ? Math.round(wind) : null,
        windMatched: like.matched, tooWindy: like.windy,
      };
      if (!elevated) delete this.dismissed[id];
      if (elevated && !this.dismissed[id] && (!this.alerted[id] || now - this.alerted[id] > 3 * DAY)) { this.alerted[id] = now; alerts.push({ id, percent: pct }); }
      if (!elevated && was?.elevated) normal.push(id);
    }
    this.save();
    return { alerts, normal };
  }

  /** Rooms losing heat faster than usual now: [{ id, percent, dismissed, windMatched }]. */
  elevated() {
    return Object.entries(this.state).filter(([, s]) => s.elevated)
      .map(([id, s]) => ({ id, percent: s.percent, dismissed: !!this.dismissed[id], windMatched: !!s.windMatched }));
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
