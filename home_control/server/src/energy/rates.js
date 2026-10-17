// Electricity prices: reading Octopus's half-hourly rates, banding them (cheap, standard, peak),
// and finding the cheapest times to run something. All prices here are in pence per kWh, VAT included.
//
// Octopus (the Octopus Energy integration) gives each day's rates as a list on an event entity:
// [{ start, end, value_inc_vat (pounds), is_capped, is_intelligent_adjusted }]. Agile changes every
// half hour; Go and Intelligent Octopus Go have a cheap night (and, with Intelligent, extra cheap
// slots while the car charges); Flux and Cosy have three rates; fixed tariffs one.

const SLOT = 30 * 60000;
const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
const r1 = (x) => Math.round(x * 10) / 10;

/** Rates from one or more Octopus lists, merged, in order: [{ start, end, p, adjusted }]. */
export function parseRates(...lists) {
  const by = new Map();
  for (const list of lists) {
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || typeof r !== 'object') continue;
      const start = toMs(r.start); const end = toMs(r.end);
      const v = Number(r.value_inc_vat ?? r.value);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(v)) continue;
      by.set(start, { start, end, p: Math.round(v * 100 * 100) / 100, adjusted: !!r.is_intelligent_adjusted });
    }
  }
  return [...by.values()].sort((a, b) => a.start - b.start);
}

export function rateAt(rates, t) {
  return rates.find((r) => r.start <= t && t < r.end) || null;
}

/** When the price next changes after t (from the run of equal prices it's in): { at, p } or null. */
export function nextChange(rates, t) {
  const i = rates.findIndex((r) => r.start <= t && t < r.end);
  if (i < 0) return null;
  const p = rates[i].p;
  for (let j = i + 1; j < rates.length; j++) {
    if (rates[j].start !== rates[j - 1].end) return { at: rates[j - 1].end, p: null }; // a gap: not known
    if (rates[j].p !== p) return { at: rates[j].start, p: rates[j].p };
  }
  return { at: rates[rates.length - 1].end, p: null };
}

/** The time up to which rates are known without a gap, from t. */
export function knownUntil(rates, t) {
  let i = rates.findIndex((r) => r.start <= t && t < r.end);
  if (i < 0) return t;
  let end = rates[i].end;
  while (i + 1 < rates.length && rates[i + 1].start === end) { i++; end = rates[i].end; }
  return end;
}

const pct = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * Where cheap ends and peak begins, from the rates known (or set by hand: { cheap, peak } in p).
 * Two rates (Go): the lower is cheap, the other standard. Three to five (Flux, Cosy): the lowest
 * cheap, the highest peak. More (Agile): the cheapest quarter cheap, the dearest seventh peak.
 * One rate: no bands.
 */
export function bandLimits(rates, fixed = null) {
  if (fixed && Number.isFinite(fixed.cheap) && Number.isFinite(fixed.peak)) return { cheap: fixed.cheap, peak: fixed.peak, kind: 'fixed' };
  const ps = [...new Set(rates.map((r) => r.p))].sort((a, b) => a - b);
  if (ps.length <= 1) return { cheap: null, peak: null, kind: 'flat' };
  if (ps.length === 2) return { cheap: ps[0], peak: null, kind: 'two' };
  if (ps.length <= 5) return { cheap: ps[0], peak: ps[ps.length - 1], kind: 'few' };
  const all = rates.map((r) => r.p).sort((a, b) => a - b);
  return { cheap: r1(pct(all, 0.25)), peak: r1(pct(all, 6 / 7)), kind: 'varies' };
}

/** 'free' (paid to use, or nothing), 'cheap', 'standard' or 'peak'. */
export function bandOf(p, limits) {
  if (p == null) return null;
  if (p <= 0) return 'free';
  if (limits?.cheap != null && p <= limits.cheap) return 'cheap';
  if (limits?.peak != null && p >= limits.peak) return 'peak';
  return 'standard';
}

/** Average price, by time, over [from, to) (null if any of it isn't known). */
export function averageOver(rates, from, to) {
  let sum = 0; let t = from;
  for (const r of rates) {
    if (r.end <= t) continue;
    if (r.start > t) return null; // a gap
    const e = Math.min(r.end, to);
    sum += r.p * (e - t);
    t = e;
    if (t >= to) break;
  }
  return t >= to && to > from ? sum / (to - from) : null;
}

/**
 * The cheapest time to run something for `minutes` between `from` and `to`, from what's known.
 *   together: one unbroken run (a dishwasher); otherwise the cheapest half hours, which may be apart
 *   (a car, a hot water tank). Runs start on the half hour, or at `from` if that's sooner.
 *   maxP: only half hours at or below this price (together: the whole run's average).
 * Returns { start, end, avg, slots: [[start, end]…] } or null if it doesn't fit.
 */
export function cheapest(rates, { from, to, minutes, together = true, maxP = null }) {
  const need = minutes * 60000;
  if (!(need > 0) || to - from < need) return null;
  if (together) {
    const starts = new Set([from]);
    for (const r of rates) if (r.start > from && r.start + need <= to) starts.add(r.start);
    const options = [];
    for (const s of [...starts].sort((a, b) => a - b)) {
      const e = s + need;
      if (e > to) continue;
      const avg = averageOver(rates, s, e);
      if (avg != null) options.push({ start: s, end: e, avg });
    }
    if (!options.length) return null;
    // the cheapest; of ones within a tenth of a penny of it, the soonest (not hours later to save nothing)
    const low = Math.min(...options.map((o) => o.avg));
    const best = options.find((o) => o.avg <= low + 0.1);
    if (maxP != null && best.avg > maxP) return null;
    return { ...best, avg: r1(best.avg), slots: [[best.start, best.end]] };
  }
  // the cheapest half hours: each slot counted from `from` if it's already begun
  const slots = [];
  for (const r of rates) {
    const s = Math.max(r.start, from); const e = Math.min(r.end, to);
    if (e - s < 60000) continue;
    if (maxP != null && r.p > maxP) continue;
    slots.push({ start: s, end: e, p: r.p });
  }
  slots.sort((a, b) => a.p - b.p || a.start - b.start);
  const picked = []; let got = 0;
  for (const s of slots) {
    if (got >= need) break;
    const take = Math.min(s.end - s.start, need - got);
    picked.push({ start: s.start, end: s.start + take, p: s.p });
    got += take;
  }
  if (got < need) return null;
  picked.sort((a, b) => a.start - b.start);
  const runs = [];
  for (const s of picked) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.start) last[1] = s.end; else runs.push([s.start, s.end]);
  }
  const avg = picked.reduce((a, s) => a + s.p * (s.end - s.start), 0) / need;
  return { start: runs[0][0], end: runs[runs.length - 1][1], avg: r1(avg), slots: runs };
}

/** The tariff's everyday name, from its Octopus tariff code (E-1R-AGILE-24-10-01-C → Agile Octopus). */
export function tariffName(code) {
  const c = String(code || '').toUpperCase();
  if (!c) return null;
  if (c.includes('INTELLI')) return 'Intelligent Octopus Go';
  if (c.includes('AGILE')) return 'Agile Octopus';
  if (c.includes('FLUX')) return 'Octopus Flux';
  if (c.includes('COSY')) return 'Cosy Octopus';
  if (c.includes('SILVER') || c.includes('TRACKER')) return 'Octopus Tracker';
  if (/(^|-)GO(-|$)/.test(c) || c.includes('-GO-')) return 'Octopus Go';
  if (c.includes('VAR')) return 'Flexible Octopus';
  if (c.includes('FIX') || c.includes('LOYAL')) return 'Octopus Fixed';
  return null;
}

export { SLOT };
