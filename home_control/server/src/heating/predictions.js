// How good the predictions of when each room next heats are, and keeping them honest.
//
// When a room's next heat is about an hour away, and again when it's about 15 minutes away, that
// prediction is kept. When the room really starts heating, each kept prediction is scored: how many
// minutes early or late it was. A prediction whose time passes by two hours without the room
// heating counts as one that didn't happen (it stayed warmer than expected); a room that starts
// heating with nothing predicted an hour before counts as one that wasn't foreseen.
//
// Predictions of a room cooling also correct how fast that room is taken to lose heat: from where
// it was, the outside temperature and when it really fell to its start point, the rate it really
// cooled at is worked out, and the median of the last dozen, as a share of the measured rate, is
// applied from then on (within half to twice). Starts someone asked for (a boost, a hold), or that
// began early with another room, aren't a fair test and are left out.
import fs from 'node:fs';
import path from 'node:path';

const M = 60000;
const H = 3600000;
const DAY = 86400000;
const HORIZONS = [
  { id: 'h60', from: 52, to: 68 },
  { id: 'm15', from: 11, to: 19 },
];
const ASKED = ['boost', 'hold', 'manual', 'snooze', 'window', 'off'];
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export class PredictionLog {
  constructor(dataDir = null) {
    this.file = dataDir ? path.join(dataDir, 'predictions.json') : null;
    this.entries = [];   // { zone, h, madeAt, predicted, actual, error, reason }
    this.pending = [];   // predictions waiting to be scored
    this.ratios = {};    // zoneId -> [really cooled at / measured rate]
    this.keepDays = () => 60;
    this.timer = null;
    this.seen = {};      // zoneId -> { first, last }: when predictions for it began, and the latest (not kept)
    if (this.file) {
      try {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.entries = Array.isArray(d.entries) ? d.entries : [];
        this.pending = Array.isArray(d.pending) ? d.pending : [];
        this.ratios = d.ratios && typeof d.ratios === 'object' ? d.ratios : {};
      } catch { /* none yet */ }
    }
  }

  /** The latest prediction for a room: kept when it's about an hour, or about 15 minutes, away. */
  note(zoneId, now, next, { current = null, outside = null } = {}) {
    const seen = (this.seen[zoneId] ||= { first: now, last: now });
    if (now - seen.last > 15 * M) seen.first = now; // a gap (heating, or not predicting): watching afresh
    seen.last = now;
    const at = next?.exact ?? next?.at;
    if (!at) return;
    const ahead = at - now;
    for (const h of HORIZONS) {
      if (ahead < h.from * M || ahead > h.to * M) continue;
      if (this.pending.some((p) => p.zone === zoneId && p.h === h.id)) continue;
      this.pending.push({
        zone: zoneId, h: h.id, madeAt: now, at, reason: next.reason, temp: current, threshold: next.threshold ?? null,
        k: next.k ?? null, scale: this.scaleFor(zoneId), out: outside, settleUntil: next.settleUntil || 0,
      });
      this.save();
    }
  }

  /** A room has started heating. forced: it began early with another room; source: what its target was following. */
  started(zoneId, now, { forced = false, source = null } = {}) {
    const mine = this.pending.filter((p) => p.zone === zoneId && p.madeAt < now);
    this.pending = this.pending.filter((p) => !mine.includes(p));
    if (forced || ASKED.includes(source)) { if (mine.length) this.save(); return; }
    // watched for the last hour and more, with nothing predicted for about now: not foreseen
    const seen = this.seen[zoneId];
    if (!mine.some((p) => p.h === 'h60') && seen && now - seen.first > 70 * M && now - seen.last < 10 * M) {
      this.#push({ zone: zoneId, h: 'h60', madeAt: null, at: null, reason: null }, now, now);
    }
    for (const p of mine) {
      if (Math.abs(now - p.at) > 3 * H) { this.#push(p, null, now); continue; } // a different heat-up: that one didn't happen
      this.#push(p, now, now);
      if (p.h === 'h60' && p.reason === 'cooling') this.#calibrate(p, now);
    }
    this.save();
  }

  /** Predictions two hours past their time with no heat: the room stayed warmer than expected. */
  sweep(now, views = []) {
    const due = this.pending.filter((p) => now - p.at > 2 * H);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => !due.includes(p));
    for (const p of due) {
      const v = views.find((x) => x.id === p.zone);
      // its plans changed (a boost, a snooze, Away, turned off): not the prediction's fault
      if (!v || !v.enabled || [...ASKED, 'away'].includes(v.source)) continue;
      this.#push(p, null, now);
    }
    this.save();
  }

  #push(p, actual, now) {
    this.entries.push({
      zone: p.zone, h: p.h, madeAt: p.madeAt, predicted: p.at, actual, reason: p.reason,
      error: actual != null && p.at != null ? Math.round((actual - p.at) / M) : null,
    });
    const cutoff = now - this.keepDays() * DAY;
    while (this.entries.length && (this.entries[0].actual ?? this.entries[0].predicted ?? 0) < cutoff) this.entries.shift();
    if (this.entries.length > 5000) this.entries.splice(0, this.entries.length - 5000);
  }

  // From an hour-ahead prediction of a room cooling and when it really started: the rate it really cooled at
  #calibrate(p, actual) {
    if (p.k == null || p.out == null || p.temp == null || p.threshold == null) return;
    const hours = (actual - Math.max(p.madeAt, p.settleUntil || 0)) / H;
    const a = p.temp - p.out;
    const b = p.threshold - p.out;
    if (hours < 0.25 || a <= 1 || b <= 0.5 || a <= b) return;
    const ratio = (Math.log(a / b) / hours) / (p.k / (p.scale || 1)); // against the measured rate, before any correction
    if (!(ratio > 0.2 && ratio < 5)) return;
    const list = (this.ratios[p.zone] ||= []);
    list.push(Math.round(ratio * 1000) / 1000);
    if (list.length > 12) list.splice(0, list.length - 12);
  }

  /** The correction to a room's measured heat-loss rate (1: none yet). */
  scaleFor(zoneId) {
    const r = this.ratios[zoneId] || [];
    if (r.length < 3) return 1;
    return Math.min(2, Math.max(0.5, median(r)));
  }

  /** For Insights: how close each room's predictions have been, over the last `days`. */
  summary(zones, { days = 30, now = Date.now() } = {}) {
    const since = now - days * DAY;
    const recent = this.entries.filter((e) => (e.actual ?? e.predicted ?? 0) >= since);
    const score = (list) => {
      const scored = list.filter((e) => e.error != null);
      const errs = scored.map((e) => e.error);
      return {
        samples: scored.length,
        typical: errs.length ? Math.round(median(errs.map(Math.abs))) : null,   // minutes, either way
        bias: errs.length >= 3 ? Math.round(median(errs)) : null,              // + : it started later than predicted
        within15: errs.length ? Math.round((errs.filter((x) => Math.abs(x) <= 15).length / errs.length) * 100) : null,
        didntHappen: list.filter((e) => e.predicted != null && e.actual == null).length,
        notForeseen: list.filter((e) => e.predicted == null && e.actual != null).length,
      };
    };
    const rooms = zones.map((z) => {
      const mine = recent.filter((e) => e.zone === z.id);
      const scale = this.scaleFor(z.id);
      return { id: z.id, name: z.name, h60: score(mine.filter((e) => e.h === 'h60')), m15: score(mine.filter((e) => e.h === 'm15')), scale: Math.round(scale * 100) / 100, corrections: (this.ratios[z.id] || []).length };
    });
    const name = (id) => zones.find((z) => z.id === id)?.name || id;
    const latest = recent.filter((e) => e.h === 'h60').slice(-12).reverse()
      .map((e) => ({ room: name(e.zone), predicted: e.predicted, actual: e.actual, error: e.error, reason: e.reason }));
    return { days, all: { h60: score(recent.filter((e) => e.h === 'h60')), m15: score(recent.filter((e) => e.h === 'm15')) }, rooms, latest, pending: this.pending.length };
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 5000);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries, pending: this.pending, ratios: this.ratios }));
      fs.renameSync(tmp, this.file);
    } catch { /* tried again next time */ }
  }
}
