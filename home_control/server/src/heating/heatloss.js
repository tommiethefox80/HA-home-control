// Heat-loss alerts: is a room losing heat faster than it usually does?
//
// Each time the room figures are worked out (roomstats.js, every half hour), each room's heat-loss
// rate for each day (the median of that day's stretches with no heat) is kept here, for 60 days.
// A room's usual rate is the median of its days from two days ago back to 30 days ago (at least
// four of them); its recent rate is from today and yesterday (at least two stretches). If the
// recent rate is the set share faster than usual (40% to start with), that's worth a look: a
// window or trickle vent left open, or a new draught. Told once, then not again for three days.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayKey = (t, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

export class HeatLossWatch {
  constructor(dataDir = null) {
    this.file = dataDir ? path.join(dataDir, 'heatloss.json') : null;
    this.days = {};     // zoneId -> { 'YYYY-MM-DD': { k, n } }
    this.alerted = {};  // zoneId -> when it was last told
    this.state = {};    // zoneId -> { percent, elevated, recentK, usualK, recentN, usualDays }
    if (this.file) {
      try {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.days = d.days || {};
        this.alerted = d.alerted || {};
        this.state = d.state || {};
      } catch { /* none yet */ }
    }
  }

  /** Each room's rate for each day, from the latest room figures (rooms[].daily: [{ day, k, n }]). */
  update(stats, now = Date.now()) {
    const cutoff = new Date(now - 60 * DAY).toISOString().slice(0, 10);
    for (const r of stats?.rooms || []) {
      const d = (this.days[r.id] ||= {});
      for (const x of r.daily || []) if (x.k != null && x.n > 0) d[x.day] = { k: x.k, n: x.n };
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
      const usual = Object.entries(d).filter(([k]) => k < yesterday && k >= oldest).map(([, x]) => x.k);
      const was = this.state[id];
      if (recentN < 2 || usual.length < 4) { this.state[id] = { elevated: false, recentN, usualDays: usual.length }; continue; }
      const recentK = recent.reduce((a, x) => a + x.k * x.n, 0) / recentN;
      const usualK = median(usual);
      const pct = Math.round((recentK / usualK - 1) * 100);
      const elevated = pct >= percent;
      this.state[id] = { elevated, percent: pct, recentK: Math.round(recentK * 10000) / 10000, usualK: Math.round(usualK * 10000) / 10000, recentN, usualDays: usual.length };
      if (elevated && (!this.alerted[id] || now - this.alerted[id] > 3 * DAY)) { this.alerted[id] = now; alerts.push({ id, percent: pct }); }
      if (!elevated && was?.elevated) normal.push(id);
    }
    this.save();
    return { alerts, normal };
  }

  /** Rooms losing heat faster than usual now: [{ id, percent }]. */
  elevated() {
    return Object.entries(this.state).filter(([, s]) => s.elevated).map(([id, s]) => ({ id, percent: s.percent }));
  }

  view(id) { return this.state[id] || null; }

  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ days: this.days, alerted: this.alerted, state: this.state }));
      fs.renameSync(tmp, this.file);
    } catch { /* tried again next time */ }
  }
}
