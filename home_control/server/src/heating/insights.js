// Insights: daily cost, boiler hours, cost per cold degree, and a room league table.
// Combines Home Assistant's long-term statistics (so history is there from day one)
// with a small daily log the add-on keeps itself.
import fs from 'node:fs';
import path from 'node:path';
import { detectCostEntity, detectOutsideEntity } from './history.js';

const BASE = 15.5; // UK heating degree-day base temperature (°C)
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };

export function localDate(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// ---- the add-on's own daily log ----
export class DailyLog {
  constructor(dir) {
    this.file = path.join(dir, 'daily.json');
    this.days = {};
    try { this.days = JSON.parse(fs.readFileSync(this.file, 'utf8')).days || {}; } catch { /* new */ }
    this.last = null;
    this.timer = null;
    this.keepDays = () => 400; // set from Settings → History
  }

  sample(now, engine, views) {
    const dt = this.last ? Math.min(now - this.last, 2 * 60000) : 0;
    this.last = now;
    if (!dt) return;
    const tz = engine.ha.timeZone;
    const key = localDate(now, tz);
    const d = (this.days[key] ||= { boilerMin: 0, outSum: 0, outN: 0, rooms: {} });
    const mins = dt / 60000;
    if (engine.rt.boiler.on) d.boilerMin += mins;
    const out = engine.outsideNow();
    if (out != null) { d.outSum += out * mins; d.outN += mins; }
    for (const v of views) {
      if (!v.enabled) continue;
      const r = (d.rooms[v.id] ||= { callMin: 0, tempSum: 0, tempN: 0 });
      if (v.calling) r.callMin += mins;
      if (v.current != null) { r.tempSum += v.current * mins; r.tempN += mins; }
    }
    const costId = engine.s.costEntity || detectCostEntity(engine.ha);
    const c = costId ? num(engine.ha.get(costId)?.state) : null;
    if (c != null) d.cost = c;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 60000);
  }

  flush() {
    const keys = Object.keys(this.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - this.keepDays()))) delete this.days[k];
    try { fs.writeFileSync(this.file, JSON.stringify({ days: this.days })); } catch { /* ignore */ }
  }
}

// ---- Home Assistant long-term statistics (daily buckets) ----
async function dailyStats(ha, id, from, types) {
  try {
    const res = await ha.send({
      type: 'recorder/statistics_during_period',
      start_time: new Date(from).toISOString(),
      statistic_ids: [id], period: 'day', types,
    });
    return (res?.[id] || []).map((r) => ({ start: typeof r.start === 'number' ? r.start : Date.parse(r.start), ...r }));
  } catch { return []; }
}

// Daily mean of an entity from short-term history (covers the last ~10 days for weather entities).
async function dailyMeanFromHistory(ha, id, from, tz) {
  try {
    const res = await ha.send({
      type: 'history/history_during_period', start_time: new Date(from).toISOString(), entity_ids: [id],
      minimal_response: false, no_attributes: false, significant_changes_only: false,
    });
    const rows = res?.[id] || [];
    const acc = {};
    let attrs = {};
    for (const r of rows) {
      if (r.a) attrs = r.a;
      const v = id.startsWith('weather.') ? num((r.a || attrs)?.temperature) : num(r.s);
      if (v == null) continue;
      const k = localDate((r.lu ?? r.lc) * 1000, tz);
      (acc[k] ||= []).push(v);
    }
    return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  } catch { return {}; }
}

// Boiler minutes per day from short-term history of the boiler entity.
async function boilerMinutesFromHistory(ha, id, from, tz) {
  try {
    const res = await ha.send({
      type: 'history/history_during_period', start_time: new Date(from).toISOString(), entity_ids: [id],
      minimal_response: false, no_attributes: false, significant_changes_only: false,
    });
    const rows = res?.[id] || [];
    const firing = (r, a) => (id.startsWith('climate.') ? (r.a || a)?.hvac_action === 'heating' : r.s === 'on');
    const out = {};
    let attrs = {};
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].a) attrs = rows[i].a;
      if (!firing(rows[i], attrs)) continue;
      const a = (rows[i].lu ?? rows[i].lc) * 1000;
      const b = i + 1 < rows.length ? (rows[i + 1].lu ?? rows[i + 1].lc) * 1000 : Date.now();
      // split across midnight by sampling each minute block (cheap enough for 10 days)
      for (let t = a; t < b; t += 60000) {
        const k = localDate(t, tz);
        out[k] = (out[k] || 0) + Math.min(1, (b - t) / 60000);
      }
    }
    return out;
  } catch { return {}; }
}

export async function buildInsights(engine, { days = 30 } = {}) {
  const ha = engine.ha;
  const tz = ha.timeZone;
  const now = Date.now();
  const from = now - days * 86400000;
  const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(localDate(now - i * 86400000, tz));
  const today = keys[keys.length - 1];
  const log = engine.dailyLog?.days || {};

  const costId = engine.s.costEntity || detectCostEntity(ha);
  const outId = engine.s.outsideEntity || detectOutsideEntity(ha);
  const unit = costId ? ha.get(costId)?.attributes?.unit_of_measurement || 'GBP' : null;

  // cost per day: statistics first ('change' handles daily resets), then the add-on's log
  const cost = {};
  if (costId) {
    for (const r of await dailyStats(ha, costId, from, ['change', 'max'])) {
      const k = localDate(r.start + 3600000, tz); // +1h guards against DST-edge bucket starts
      const v = num(r.change) != null && num(r.change) > 0 ? num(r.change) : num(r.max);
      if (v != null) cost[k] = v;
    }
    for (const k of keys) if (cost[k] == null && log[k]?.cost != null) cost[k] = log[k].cost;
    const cur = num(ha.get(costId)?.state);
    if (cur != null) cost[today] = cur;
  }

  // outside mean per day: statistics (sensors), history (weather, ~10 days), then the add-on's log
  const outside = {};
  if (outId) {
    if (outId.startsWith('sensor.')) {
      for (const r of await dailyStats(ha, outId, from, ['mean'])) {
        const v = num(r.mean);
        if (v != null) outside[localDate(r.start + 3600000, tz)] = v;
      }
    }
    const missing = keys.filter((k) => outside[k] == null);
    if (missing.length) {
      const hist = await dailyMeanFromHistory(ha, outId, Math.max(from, now - 10 * 86400000), tz);
      for (const k of missing) if (hist[k] != null) outside[k] = hist[k];
    }
    for (const k of keys) if (outside[k] == null && log[k]?.outN > 30) outside[k] = log[k].outSum / log[k].outN;
  }

  // boiler minutes per day: the add-on's log, else the boiler's own history (~10 days)
  const boiler = {};
  const b = engine.s.boiler.entity;
  const fromHist = b ? await boilerMinutesFromHistory(ha, b, Math.max(from, now - 10 * 86400000), tz) : {};
  for (const k of keys) {
    const a = log[k]?.boilerMin, h = fromHist[k];
    if (a != null || h != null) boiler[k] = Math.max(a || 0, h || 0); // whichever saw more of the day
  }

  const daysOut = keys.map((k) => {
    const o = outside[k] != null ? Math.round(outside[k] * 10) / 10 : null;
    const dd = o != null ? Math.max(0, Math.round((BASE - o) * 10) / 10) : null;
    const c = cost[k] != null ? Math.round(cost[k] * 100) / 100 : null;
    return {
      date: k, partial: k === today, cost: c, outside: o, degreeDays: dd,
      costPerDD: c != null && dd != null && dd >= 1 ? Math.round((c / dd) * 1000) / 1000 : null,
      boilerHours: boiler[k] != null ? Math.round((boiler[k] / 60) * 10) / 10 : null,
    };
  });

  // week vs week (last 7 days including today, and the 7 before)
  const sum = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b2) => a + b2, 0) : null; };
  const week = (a) => {
    const c = sum(a, (d) => d.cost); const dd = sum(a, (d) => d.degreeDays); const bh = sum(a, (d) => d.boilerHours);
    // cost per cold degree only over days that have both figures, so gaps can't skew it
    const both = a.filter((d) => d.cost != null && d.degreeDays != null);
    const bc = sum(both, (d) => d.cost); const bdd = sum(both, (d) => d.degreeDays);
    return { cost: c != null ? Math.round(c * 100) / 100 : null, degreeDays: dd != null ? Math.round(dd * 10) / 10 : null,
      costPerDD: bc != null && bdd >= 1 ? Math.round((bc / bdd) * 1000) / 1000 : null, costPerDDDays: both.length,
      boilerHours: bh != null ? Math.round(bh * 10) / 10 : null, boilerDays: a.filter((d) => d.boilerHours != null).length,
      days: a.length };
  };
  // compare whole days only: the 7 days before today, and the 7 before those
  const thisWeek = week(daysOut.slice(-8, -1));
  const lastWeek = week(daysOut.slice(-15, -8));

  // room league table
  const last7 = keys.slice(-7);
  const trackedDays = last7.filter((k) => log[k] && Object.keys(log[k].rooms || {}).length).length;
  const rooms = engine.zones.filter((z) => z.enabled).map((z) => {
    const w = engine.rt.warm?.[z.id];
    const L = engine.rt.learn?.[z.id];
    const hist = L?.history || [];
    const overs = hist.map((h) => h.err).filter((e) => e != null);
    const callMin = last7.reduce((a, k) => a + (log[k]?.rooms?.[z.id]?.callMin || 0), 0);
    const tempN = last7.reduce((a, k) => a + (log[k]?.rooms?.[z.id]?.tempN || 0), 0);
    const tempSum = last7.reduce((a, k) => a + (log[k]?.rooms?.[z.id]?.tempSum || 0), 0);
    // an always-open radiator also gets heat whenever the boiler runs for other rooms
    const open = engine.openRadiator(z);
    const othersMin = open ? last7.reduce((a, k) => a + Math.max(0, (log[k]?.boilerMin || 0) - (log[k]?.rooms?.[z.id]?.callMin || 0)), 0) : null;
    return {
      id: z.id, name: z.name,
      warmRate: w?.rate ?? null, warmSamples: w?.samples || 0,
      overshoot: overs.length ? Math.round((overs.reduce((a, b2) => a + b2, 0) / overs.length) * 100) / 100 : null,
      stopsEarly: L?.margin ?? null,
      heatingHours: Math.round((callMin / 60) * 10) / 10,
      open, othersHours: othersMin != null ? Math.round((othersMin / 60) * 10) / 10 : null,
      avgTemp: tempN > 60 ? Math.round((tempSum / tempN) * 10) / 10 : null,
    };
  });

  const firstOutside = daysOut.find((d) => d.outside != null)?.date || null;
  return { unit, base: BASE, days: daysOut, thisWeek, lastWeek, rooms, trackedDays, firstOutside, sources: { cost: costId, outside: outId } };
}
