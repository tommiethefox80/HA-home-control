// Energy: what electricity and gas cost now and today, the cheapest times ahead, the car's charging,
// and plans that switch a socket on at the cheapest time (a dishwasher, a washing machine).
//
// Prices, the car and today's costs come from the Octopus Energy integration (BottlecapDave's), found
// by its entity IDs:
//   sensor.octopus_energy_electricity_<serial>_<mpan>_current_rate          the price now (£/kWh)
//   event.octopus_energy_electricity_<serial>_<mpan>_{previous,current,next}_day_rates  each half hour's
//   binary_sensor.octopus_energy_electricity_<serial>_<mpan>_off_peak
//   sensor.octopus_energy_electricity_<serial>_<mpan>_{current,previous}_accumulative_{cost,consumption}
//                                         today's (with a Home Mini) and the last full day's (smart meter)
//   sensor.octopus_energy_electricity_<serial>_<mpan>_current_demand         watts now (Home Mini)
//   sensor.octopus_energy_gas_<serial>_<mprn>_…                               the same for gas
//   …_intelligent_{dispatching,state,state_of_charge,bump_charge,smart_charge,charge_target,target_time}
//                                                                           Intelligent Octopus: the car
// Usage and cost history come from Home Assistant's Energy dashboard (its settings and long-term
// statistics), so they work with any supplier; so does the price now, from the dashboard's price entity.
import { EventEmitter } from 'node:events';
import { zonedParts, zonedToUtc, addDays, dateKey, localDate } from '../lighting/schedule.js';
import { parseRates, rateAt, nextChange, knownUntil, bandLimits, bandOf, averageOver, cheapest, tariffName } from './rates.js';

export class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const TS = Number(process.env.HC_TIME_SCALE) || 1;
const MAX_EVENTS = 400;
const H = 3600000;
const DAY = 86400000;
const BAD = new Set(['unavailable', 'unknown', '', null, undefined]);
const num = (v) => { if (BAD.has(v)) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const OCTO = /^(sensor|event|binary_sensor|switch|number|select|time)\.octopus_energy_/;
const SWITCHABLE = ['switch', 'light', 'input_boolean', 'fan'];

const EV_STATES = {
  SMART_CONTROL_IN_PROGRESS: 'Smart charging',
  BOOSTING: 'Bump charging',
  SMART_CONTROL_CAPABLE: 'Ready to smart charge',
  SMART_CONTROL_OFF: 'Smart charging off',
  SMART_CONTROL_NOT_AVAILABLE: 'Smart charging not available',
  LOST_CONNECTION: 'Octopus has lost touch with the car or charger',
  AUTHENTICATION_PENDING: 'Waiting to be linked to Octopus',
  AUTHENTICATION_FAILED: 'Linking to Octopus failed',
  TEST_CHARGE_IN_PROGRESS: 'Test charge running',
  TEST_CHARGE_FAILED: 'Test charge failed',
  SETUP_COMPLETE: 'Set up',
  RETIRED: 'No longer linked',
};

export class Engine extends EventEmitter {
  constructor({ ha, store, log, notifyTargets = async () => [] }) {
    super();
    this.ha = ha;
    this.store = store;
    this.data = store.data;
    this.log = log;
    this.notifyTargets = notifyTargets;
    this.states = new Map();
    this.tz = 'UTC';
    this.currency = 'GBP';
    this.ready = false;
    this.disabled = false;
    this.prefs = null;      // Home Assistant's Energy dashboard settings
    this.info = null;       // its cost sensors
    this.meta = new Map();  // statistic id -> unit
    this.usage = null;      // today's and yesterday's use from the Energy dashboard
    this.historyCache = null;
    this.rateCache = { sig: null, rates: [] };
  }

  start() {
    this.ha.on('ready', () => this._onReady().catch((err) => this.log.warn?.(`Energy: ${err.message}`)));
    this.ha.on('state_changed', (d) => this._onState(d));
    this.ha.on('disconnected', () => { this.ready = false; this.changed(); });
    this.timer = setInterval(() => this.tick(), Math.max(200, 20000 * TS));
    this.usageTimer = setInterval(() => { if (this.ready && !this.disabled) this.refreshUsage().then(() => this.changed()).catch(() => {}); }, 5 * 60000);
  }

  stop() { clearInterval(this.timer); clearInterval(this.usageTimer); clearInterval(this.prefsTimer); this.store.flush(); }

  changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = null; this.emit('change'); }, 150);
  }

  async _onReady() {
    const [config, states] = await Promise.all([this.ha.getConfig(), this.ha.getStates()]);
    this.tz = config?.time_zone || 'UTC';
    this.currency = config?.currency || 'GBP';
    this.states = new Map(states.map((s) => [s.entity_id, s]));
    await this.ha.subscribeStateChanged();
    this.ready = true;
    await this.loadPrefs();
    await this.refreshUsage().catch(() => {});
    this.tick();
    this.changed();
    clearInterval(this.prefsTimer);
    this.prefsTimer = setInterval(() => this.loadPrefs().then(() => this.changed()).catch(() => {}), 30 * 60000);
  }

  _onState(d) {
    if (!d?.entity_id) return;
    if (d.new_state) this.states.set(d.entity_id, d.new_state); else this.states.delete(d.entity_id);
    if (!this.ready) return;
    const id = d.entity_id;
    // the Octopus integration just added (or reloaded): its sensors may be in the Energy dashboard too
    if (OCTO.test(id) && !d.old_state && d.new_state) {
      clearTimeout(this.prefsSoon);
      this.prefsSoon = setTimeout(() => this.loadPrefs().then(() => this.refreshUsage()).then(() => this.changed()).catch(() => {}), 5000);
    }
    if (OCTO.test(id) || this.watching().has(id)) {
      if (/_intelligent_dispatching$/.test(id)) this._dispatchNote(d);
      this.changed();
    }
  }

  /** Entities besides Octopus's whose changes matter here (worked out again when plans or the Energy dashboard change). */
  watching() {
    if (this._watch) return this._watch;
    const s = new Set(this.data.plans.map((p) => p.entity));
    const src = this.sources();
    if (src.priceEntity) s.add(src.priceEntity);
    if (src.power) s.add(src.power);
    this._watch = s;
    return s;
  }

  // ---------- Home Assistant's Energy dashboard ----------

  async loadPrefs() {
    try { this.prefs = await this.ha.send('energy/get_prefs'); } catch { this.prefs = null; } // not set up yet
    try { this.info = await this.ha.send('energy/info'); } catch { this.info = null; }
    const ids = this.statIds();
    if (ids.length) {
      try {
        const meta = await this.ha.send('recorder/get_statistics_metadata', { statistic_ids: ids });
        this.meta = new Map((meta || []).map((m) => [m.statistic_id, m.statistics_unit_of_measurement || m.display_unit_of_measurement || null]));
      } catch { /* units unknown: kWh assumed */ }
    }
    this.historyCache = null;
    this._watch = null;
  }

  /** What the Energy dashboard measures: grid electricity in, gas, and each device. */
  sources() {
    const out = { elec: [], gas: [], devices: [], priceEntity: null, priceNumber: null, gasPriceEntity: null, power: null };
    const costOf = (src, stat) => src.stat_cost || this.info?.cost_sensors?.[stat] || null;
    for (const s of this.prefs?.energy_sources || []) {
      if (s.type === 'grid') {
        for (const f of s.flow_from || []) {
          out.elec.push({ stat: f.stat_energy_from, cost: costOf(f, f.stat_energy_from) });
          if (!out.priceEntity && f.entity_energy_price) out.priceEntity = f.entity_energy_price;
          if (out.priceNumber == null && f.number_energy_price != null) out.priceNumber = Number(f.number_energy_price);
        }
        for (const p of s.power || []) if (!out.power && p.stat_rate) out.power = p.stat_rate;
      } else if (s.type === 'gas') {
        out.gas.push({ stat: s.stat_energy_from, cost: costOf(s, s.stat_energy_from) });
        if (!out.gasPriceEntity && s.entity_energy_price) out.gasPriceEntity = s.entity_energy_price;
      }
    }
    for (const d of this.prefs?.device_consumption || []) {
      if (d.stat_consumption && !d.included_in_stat) out.devices.push({ stat: d.stat_consumption, name: d.name || null });
    }
    return out;
  }

  statIds() {
    const s = this.sources();
    return [...new Set([...s.elec.flatMap((x) => [x.stat, x.cost]), ...s.gas.flatMap((x) => [x.stat, x.cost]), ...s.devices.map((d) => d.stat)].filter(Boolean))];
  }

  async stats(ids, from, to, period) {
    if (!ids.length) return {};
    return this.ha.send('recorder/statistics_during_period', {
      start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString(),
      statistic_ids: ids, period, types: ['change'], units: { energy: 'kWh' },
    }, 30000);
  }

  /** Today's use, hour by hour, and yesterday's, from the Energy dashboard's statistics. */
  async refreshUsage() {
    const src = this.sources();
    const ids = this.statIds().filter((id) => !src.devices.some((d) => d.stat === id));
    if (!ids.length) { this.usage = null; return; }
    const today = this.dayStart(Date.now());
    const yday = this.dayStart(today - 12 * H);
    const res = await this.stats(ids, yday, Date.now() + H, 'hour');
    const sumAt = (stats, from, to) => {
      const by = new Map();
      for (const id of stats) for (const row of res?.[id] || []) {
        if (row.start < from || row.start >= to || row.change == null) continue;
        by.set(row.start, (by.get(row.start) || 0) + row.change);
      }
      return by;
    };
    const total = (m) => (m.size ? [...m.values()].reduce((a, b) => a + b, 0) : null);
    const ek = src.elec.map((x) => x.stat); const ec = src.elec.map((x) => x.cost).filter(Boolean);
    const gk = src.gas.map((x) => x.stat); const gc = src.gas.map((x) => x.cost).filter(Boolean);
    const now = Date.now();
    const hours = (kStats, cStats) => {
      const k = sumAt(kStats, today, now + H); const c = sumAt(cStats, today, now + H);
      return [...k.keys()].sort((a, b) => a - b).map((s) => ({ s, e: s + H, kwh: r2(k.get(s)), cost: c.has(s) ? r2(c.get(s)) : null }));
    };
    this.usage = {
      at: now,
      elec: { hourly: hours(ek, ec), today: { kwh: total(sumAt(ek, today, now + H)), cost: ec.length ? total(sumAt(ec, today, now + H)) : null }, yesterday: { kwh: total(sumAt(ek, yday, today)), cost: ec.length ? total(sumAt(ec, yday, today)) : null } },
      gas: gk.length ? { unit: this.meta.get(gk[0]) || 'kWh', hourly: hours(gk, gc), today: { kwh: total(sumAt(gk, today, now + H)), cost: gc.length ? total(sumAt(gc, today, now + H)) : null }, yesterday: { kwh: total(sumAt(gk, yday, today)), cost: gc.length ? total(sumAt(gc, yday, today)) : null } } : null,
    };
  }

  /** Each day's use and cost, and what used the most, over the last `days` days. */
  async history(days = 30) {
    days = Math.min(400, Math.max(7, Math.round(Number(days) || 30)));
    if (this.historyCache && this.historyCache.days === days && Date.now() - this.historyCache.at < 15 * 60000) return this.historyCache.data;
    if (!this.ready) throw new UserError('Not connected to Home Assistant yet', 503);
    const src = this.sources();
    const ids = this.statIds();
    const today = this.dayStart(Date.now());
    let from = today;
    for (let i = 0; i < days - 1; i++) from = this.dayStart(from - 12 * H);
    const res = ids.length ? await this.stats(ids, from, Date.now() + H, 'day') : {};
    const byDay = new Map();
    const add = (stats, key) => {
      for (const id of stats) for (const row of res?.[id] || []) {
        if (row.change == null) continue;
        const d = dateKey(localDate(row.start + 2 * H, this.tz)); // a day's row starts at local midnight
        const o = byDay.get(d) || { day: d };
        o[key] = (o[key] || 0) + row.change;
        byDay.set(d, o);
      }
    };
    add(src.elec.map((x) => x.stat), 'elecKwh');
    add(src.elec.map((x) => x.cost).filter(Boolean), 'elecCost');
    add(src.gas.map((x) => x.stat), 'gasKwh');
    add(src.gas.map((x) => x.cost).filter(Boolean), 'gasCost');
    const list = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => ({ day: d.day, elecKwh: r2(d.elecKwh ?? null), elecCost: r2(d.elecCost ?? null), gasKwh: r2(d.gasKwh ?? null), gasCost: r2(d.gasCost ?? null) }));
    const devices = src.devices.map((d) => {
      const kwh = (res?.[d.stat] || []).reduce((a, r) => a + (r.change || 0), 0);
      const st = this.states.get(d.stat);
      const name = d.name || String(st?.attributes?.friendly_name || d.stat).replace(/\s+(energy|consumption)$/i, '');
      return { stat: d.stat, name, kwh: r2(kwh) };
    }).filter((d) => d.kwh > 0).sort((a, b) => b.kwh - a.kwh);
    const totalElec = list.reduce((a, d) => a + (d.elecKwh || 0), 0);
    const data = {
      days, from, list, devices: devices.slice(0, 12), totalElec: r1(totalElec),
      gasUnit: src.gas.length ? (this.meta.get(src.gas[0].stat) || 'kWh') : null,
      dashboard: !!src.elec.length, costs: src.elec.some((x) => x.cost), gasCosts: src.gas.some((x) => x.cost),
      currency: this.currency, timeZone: this.tz,
    };
    this.historyCache = { at: Date.now(), days, data };
    return data;
  }

  // ---------- Octopus ----------

  st(id) { return id ? this.states.get(id) : null; }
  attr(id, key) { return this.st(id)?.attributes?.[key]; }

  /** The Octopus meters there are: { elec: [{ key, tariff }], gas: [...], export: [...] }. */
  meters() {
    const elec = []; const gas = []; const exp = [];
    for (const id of this.states.keys()) {
      let m = /^sensor\.octopus_energy_electricity_(.+)_current_rate$/.exec(id);
      if (m) {
        const isExport = m[1].endsWith('_export') || this.attr(id, 'is_export') === true;
        (isExport ? exp : elec).push({ key: m[1].replace(/_export$/, ''), rate: id, tariff: this.attr(id, 'tariff') || null });
        continue;
      }
      m = /^sensor\.octopus_energy_gas_(.+)_current_rate$/.exec(id);
      if (m) gas.push({ key: m[1], rate: id, tariff: this.attr(id, 'tariff') || null });
    }
    const byKey = (a, b) => a.key.localeCompare(b.key);
    return { elec: elec.sort(byKey), gas: gas.sort(byKey), export: exp.sort(byKey) };
  }

  elecMeter() {
    const m = this.meters().elec;
    return m.find((x) => x.key === this.data.settings.meter) || m[0] || null;
  }

  gasMeter() {
    const m = this.meters().gas;
    return m.find((x) => x.key === this.data.settings.gasMeter) || m[0] || null;
  }

  ids(kind, key) {
    const b = `octopus_energy_${kind}_${key}`;
    return {
      rate: `sensor.${b}_current_rate`, next: `sensor.${b}_next_rate`,
      today: `event.${b}_current_day_rates`, tomorrow: `event.${b}_next_day_rates`, yesterday: `event.${b}_previous_day_rates`,
      offPeak: `binary_sensor.${b}_off_peak`,
      costToday: `sensor.${b}_current_accumulative_cost`, costPrev: `sensor.${b}_previous_accumulative_cost`,
      useToday: kind === 'gas' ? `sensor.${b}_current_accumulative_consumption_kwh` : `sensor.${b}_current_accumulative_consumption`,
      usePrev: kind === 'gas' ? `sensor.${b}_previous_accumulative_consumption_kwh` : `sensor.${b}_previous_accumulative_consumption`,
      demand: `sensor.${b}_current_demand`,
    };
  }

  /** Every half hour's price known, from yesterday to as far ahead as Octopus has published. */
  rates() {
    const m = this.elecMeter();
    if (!m) return [];
    const e = this.ids('electricity', m.key);
    const sig = [e.yesterday, e.today, e.tomorrow].map((id) => this.st(id)?.last_updated || '').join('|');
    if (this.rateCache.sig === `${m.key}|${sig}`) return this.rateCache.rates;
    const rates = parseRates(this.attr(e.yesterday, 'rates'), this.attr(e.today, 'rates'), this.attr(e.tomorrow, 'rates'));
    this.rateCache = { sig: `${m.key}|${sig}`, rates };
    return rates;
  }

  limits(rates, from = Date.now()) {
    const b = this.data.settings.bands;
    if (b.mode === 'fixed') return bandLimits([], { cheap: Number(b.cheap), peak: Number(b.peak) });
    // today's and what's known ahead (not yesterday's), so the bands follow the prices now
    const today = this.dayStart(from);
    return bandLimits(rates.filter((r) => r.end > today));
  }

  /** The price now (pence per kWh), from Octopus or the Energy dashboard's price. */
  priceNow(rates, now = Date.now()) {
    const r = rateAt(rates, now);
    if (r) return r.p;
    const m = this.elecMeter();
    const p = m ? num(this.st(m.rate)?.state) : null;
    if (p != null) return r2(p * 100);
    const src = this.sources();
    const pe = num(this.st(src.priceEntity)?.state);
    if (pe != null) {
      const unit = String(this.attr(src.priceEntity, 'unit_of_measurement') || '');
      return r2(/p\b|pence/i.test(unit) && !/£|GBP/.test(unit) ? pe : pe * 100);
    }
    return src.priceNumber != null ? r2(src.priceNumber * 100) : null;
  }

  // ---------- the car (Intelligent Octopus) ----------

  evIds() {
    for (const id of this.states.keys()) {
      const m = /^binary_sensor\.octopus_energy_(.+)_intelligent_dispatching$/.exec(id);
      if (!m) continue;
      const b = `octopus_energy_${m[1]}_intelligent`;
      return {
        device: m[1], dispatching: id, state: `sensor.${b}_state`, soc: `sensor.${b}_state_of_charge`,
        bump: `switch.${b}_bump_charge`, smart: `switch.${b}_smart_charge`, target: `number.${b}_charge_target`,
        readySelect: `select.${b}_target_time`, readyTime: `time.${b}_target_time`, cap: `sensor.${b}_charge_cap_hours`,
      };
    }
    return null;
  }

  evView(now = Date.now()) {
    const e = this.evIds();
    if (!e) return null;
    const ok = (id) => { const s = this.st(id); return s && !BAD.has(s.state) ? s : null; };
    const d = this.st(e.dispatching);
    const a = d?.attributes || {};
    const span = (x) => ({ start: Date.parse(x.start), end: Date.parse(x.end) });
    const planned = (Array.isArray(a.planned_dispatches) ? a.planned_dispatches : []).map(span).filter((x) => x.end > now).sort((x, y) => x.start - y.start);
    const today = this.dayStart(now);
    const done = (Array.isArray(a.completed_dispatches) ? a.completed_dispatches : []).map((x) => ({ ...span(x), kwh: num(x.charge_in_kwh) })).filter((x) => x.end > today);
    const raw = ok(e.state)?.state || null;
    const target = ok(e.target);
    const sel = ok(e.readySelect); const tim = ok(e.readyTime);
    // the select's own value, or (for a time it doesn't offer, set in the Octopus app) its raw_value
    const opts = (sel?.attributes?.options || []).map((x) => String(x).slice(0, 5));
    const ready = tim ? String(tim.state).slice(0, 5) : sel ? (opts.includes(String(sel.state).slice(0, 5)) ? String(sel.state).slice(0, 5) : String(sel.attributes?.raw_value || sel.state).slice(0, 5)) : null;
    return {
      provider: a.provider || null,
      dispatching: d?.state === 'on',
      until: d?.state === 'on' ? Date.parse(a.current_end) || null : null,
      planned,
      chargedToday: r1(done.reduce((s, x) => s + (x.kwh || 0), 0)) || null,
      state: raw, stateText: raw ? (EV_STATES[raw] || raw.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())) : null,
      soc: num(ok(e.soc)?.state),
      bump: ok(e.bump) ? ok(e.bump).state === 'on' : null,
      bumpEntity: ok(e.bump) ? e.bump : null,
      smart: ok(e.smart) ? ok(e.smart).state === 'on' : null,
      target: target ? { value: num(target.state), min: num(target.attributes?.min) ?? 10, max: num(target.attributes?.max) ?? 100, step: num(target.attributes?.step) ?? 5 } : null,
      ready: ready ? { value: ready, options: tim ? null : (sel?.attributes?.options || []).map((o) => String(o).slice(0, 5)) } : null,
      battery: num(a.vehicle_battery_size_in_kwh), power: num(a.charge_point_power_in_kw),
    };
  }

  _dispatchNote(d) {
    const was = d.old_state?.state; const is = d.new_state?.state;
    if (was === is || !['on', 'off'].includes(is) || !['on', 'off'].includes(was)) return;
    if (is === 'on') {
      const end = Date.parse(d.new_state.attributes?.current_end);
      this.addEvent(`Car charging at the off-peak price (Octopus smart charge)${Number.isFinite(end) ? ` until ${this.clock(end)}` : ''}.`, 'ev');
    } else this.addEvent('Car stopped smart charging.', 'ev');
  }

  async evSet(what, value) {
    this._need();
    const e = this.evIds();
    if (!e) throw new UserError('No car found: this needs Intelligent Octopus in the Octopus Energy integration');
    const ok = (id) => { const s = this.st(id); if (!s || BAD.has(s.state)) throw new UserError('Octopus doesn\'t offer that for your car or charger'); return s; };
    if (what === 'bump' || what === 'smart') {
      const id = what === 'bump' ? e.bump : e.smart;
      ok(id);
      await this.ha.callService('switch', value ? 'turn_on' : 'turn_off', { entity_id: id });
      this.addEvent(what === 'bump' ? (value ? 'Bump charge started from here.' : 'Bump charge stopped from here.') : `Smart charging turned ${value ? 'on' : 'off'} from here.`, 'manual');
    } else if (what === 'target') {
      const s = ok(e.target);
      const v = Number(value);
      const min = num(s.attributes?.min) ?? 10; const max = num(s.attributes?.max) ?? 100;
      if (!Number.isFinite(v) || v < min || v > max) throw new UserError(`Choose between ${min}% and ${max}%`);
      await this.ha.callService('number', 'set_value', { entity_id: e.target, value: v });
      this.addEvent(`Car charge target set to ${v}% from here.`, 'manual');
    } else if (what === 'ready') {
      if (!validTime(value)) throw new UserError('Times look like 07:30');
      const tim = this.st(e.readyTime);
      if (tim && !BAD.has(tim.state)) await this.ha.callService('time', 'set_value', { entity_id: e.readyTime, time: `${value}:00` });
      else {
        const sel = ok(e.readySelect);
        const opt = (sel.attributes?.options || []).find((o) => String(o).slice(0, 5) === value);
        if (!opt) throw new UserError('Octopus offers ready-by times on the half hour, from 04:00 to 11:00');
        await this.ha.callService('select', 'select_option', { entity_id: e.readySelect, option: opt });
      }
      this.addEvent(`Car ready-by time set to ${value} from here.`, 'manual');
    } else throw new UserError('Unknown car setting');
    this.changed();
  }

  // ---------- what's shown ----------

  /** Today's (or yesterday's) cost and use: Octopus's own figures first, then the Energy dashboard's. */
  costs(kind, now = Date.now()) {
    const m = kind === 'gas' ? this.gasMeter() : this.elecMeter();
    const u = kind === 'gas' ? this.usage?.gas : this.usage?.elec;
    const ids = m ? this.ids(kind === 'gas' ? 'gas' : 'electricity', m.key) : {};
    const today = this.dayStart(now);
    const octo = (cost, use) => {
      const c = this.st(cost); const k = this.st(use);
      const val = c && !BAD.has(c.state) ? num(c.state) : null;
      const charges = c?.attributes?.charges;
      const first = Array.isArray(charges) && charges.length ? Date.parse(charges[0].start) : null;
      return val == null ? null : {
        cost: r2(val), kwh: r2(k && !BAD.has(k.state) ? num(k.state) : num(c.attributes?.total_consumption)),
        standing: r2(num(c.attributes?.standing_charge)), day: first ? dateKey(localDate(first, this.tz)) : null, src: 'octopus', charges,
      };
    };
    let t = octo(ids.costToday, ids.useToday);
    if (t && t.day && t.day !== dateKey(localDate(now, this.tz))) t = null; // not today's (yet)
    if (!t && u?.today?.kwh != null) {
      let cost = u.today.cost; let est = false;
      if (cost == null && kind !== 'gas') {
        // no cost from the Energy dashboard: the hours used times the price then (without the standing charge)
        const rates = this.rates();
        let sum = 0; let all = true;
        for (const h of u.hourly) { const p = averageOver(rates, h.s, Math.min(h.e, now)); if (p == null) { all = false; break; } sum += h.kwh * p / 100; }
        if (all && u.hourly.length) { cost = sum; est = true; }
      }
      t = { cost: r2(cost), kwh: r2(u.today.kwh), standing: null, day: dateKey(localDate(today, this.tz)), src: 'dashboard', est };
    }
    let y = octo(ids.costPrev, ids.usePrev);
    if (!y && u?.yesterday?.kwh != null) y = { cost: r2(u.yesterday.cost), kwh: r2(u.yesterday.kwh), standing: null, day: dateKey(localDate(today - 12 * H, this.tz)), src: 'dashboard' };
    if (t) delete t.charges;
    if (y) delete y.charges;
    return { today: t, last: y };
  }

  /** Use in each half hour (Octopus, with a Home Mini) or hour (Energy dashboard) today. */
  usageToday(now = Date.now()) {
    const m = this.elecMeter();
    if (m) {
      const ids = this.ids('electricity', m.key);
      const charges = this.attr(ids.costToday, 'charges') || this.attr(ids.useToday, 'charges');
      if (Array.isArray(charges) && charges.length) {
        const list = charges.map((c) => ({ s: Date.parse(c.start), e: Date.parse(c.end), kwh: r2(num(c.consumption)), cost: c.cost != null ? r2(num(c.cost)) : null }))
          .filter((c) => c.s >= this.dayStart(now) && c.kwh != null);
        if (list.length) return list;
      }
    }
    return this.usage?.elec?.hourly || [];
  }

  demandNow() {
    const m = this.elecMeter();
    if (m) {
      const id = this.ids('electricity', m.key).demand;
      const v = num(this.st(id)?.state);
      if (v != null) return { w: Math.round(/kw/i.test(this.attr(id, 'unit_of_measurement') || '') ? v * 1000 : v), src: 'octopus' };
    }
    const p = this.sources().power;
    const v = num(this.st(p)?.state);
    if (v != null) return { w: Math.round(/kw/i.test(this.attr(p, 'unit_of_measurement') || '') ? v * 1000 : v), src: 'dashboard' };
    return null;
  }

  snapshot(now = Date.now()) {
    const rates = this.rates();
    const limits = this.limits(rates, now);
    const m = this.elecMeter();
    const p = this.priceNow(rates, now);
    const nc = nextChange(rates, now);
    const known = knownUntil(rates, now);
    const today = this.dayStart(now);
    const ahead = known > now ? [60, 120, 180].map((minutes) => {
      const c = cheapest(rates, { from: now, to: known, minutes, together: true });
      return c ? { minutes, start: c.start, end: c.end, avg: c.avg } : null;
    }).filter(Boolean) : [];
    const offId = m ? this.ids('electricity', m.key).offPeak : null;
    const off = this.st(offId);
    const exp = this.meters().export[0];
    const gm = this.gasMeter();
    const gasP = gm ? num(this.st(gm.rate)?.state) : null;
    const src = this.sources();
    const tariffCode = m ? this.attr(m.rate, 'tariff') : null;
    return {
      connected: this.ha.connected !== false && this.ready,
      ready: this.ready,
      disabled: this.disabled,
      timeZone: this.tz,
      currency: this.currency,
      now: now,
      found: { octopus: !!m, prices: rates.length > 0 || p != null, dashboard: src.elec.length > 0, gas: !!gm || src.gas.length > 0, ev: !!this.evIds() },
      tariff: tariffCode ? { code: tariffCode, name: tariffName(tariffCode) } : null,
      price: p == null ? null : { p, band: bandOf(p, limits), next: nc && nc.at < known + 1 ? nc : null, adjusted: !!rateAt(rates, now)?.adjusted },
      limits,
      rates: rates.filter((r) => r.end > today).map((r) => ({ s: r.start, e: r.end, p: r.p, b: bandOf(r.p, limits), adj: r.adjusted || undefined })),
      known,
      cheapest: ahead,
      cheapRuns: this.cheapRuns(rates, limits, now),
      offPeak: off && !BAD.has(off.state) ? { on: off.state === 'on', start: Date.parse(off.attributes?.current_start) || null, end: Date.parse(off.attributes?.current_end) || null, nextStart: Date.parse(off.attributes?.next_start) || null, nextEnd: Date.parse(off.attributes?.next_end) || null } : null,
      exportP: exp ? r2(num(this.st(exp.rate)?.state) * 100) : null,
      elec: { ...this.costs('elec', now), demand: this.demandNow(), use: this.usageToday(now) },
      gas: (gm || src.gas.length) ? { p: gasP != null ? r2(gasP * 100) : null, ...this.costs('gas', now), unit: this.usage?.gas?.unit || 'kWh' } : null,
      ev: this.evView(now),
      plans: this.data.plans.map((pl) => this.planView(pl, now)),
      events: this.data.events.slice(-5).reverse(),
      settings: { card: this.data.settings.card, bands: this.data.settings.bands },
    };
  }

  /** The cheap stretches from now on (off-peak, and any extra cheap slots while the car charges). */
  cheapRuns(rates, limits, now = Date.now()) {
    const out = [];
    for (const r of rates) {
      if (r.end <= now) continue;
      const b = bandOf(r.p, limits);
      if (b !== 'cheap' && b !== 'free') continue;
      const last = out[out.length - 1];
      if (last && last.end === r.start) { last.end = r.end; last.sum += r.p * (r.end - r.start); last.adj &&= r.adjusted; }
      else out.push({ start: r.start, end: r.end, sum: r.p * (r.end - r.start), adj: r.adjusted });
    }
    return out.slice(0, 6).map((x) => ({ start: x.start, end: x.end, avg: r1(x.sum / (x.end - x.start)), extra: !!x.adj }));
  }

  // ---------- plans: run something at the cheapest time ----------

  planView(pl, now = Date.now()) {
    const st = this.st(pl.entity);
    return {
      id: pl.id, name: pl.name, entity: pl.entity, entityName: st?.attributes?.friendly_name || this.lastName?.(pl.entity) || pl.entity,
      on: st ? st.state === 'on' : null, available: !!st && !BAD.has(st.state),
      minutes: pl.minutes, by: pl.by, together: pl.together, repeat: pl.repeat, maxP: pl.maxP, enabled: pl.enabled,
      next: pl.run ? { start: pl.run.start, end: pl.run.end, avg: pl.run.avg, slots: pl.run.slots, running: true, provisional: false }
        : pl.next ? { ...pl.next, running: false } : null,
      last: pl.last || null,
    };
  }

  /** The time a plan must be done by, after `ms`, that hasn't been done or skipped. */
  deadline(pl, ms) {
    const [h, m] = pl.by.split(':').map(Number);
    let d = localDate(ms, this.tz);
    for (let i = 0; i < 3; i++) {
      const at = zonedToUtc(d.year, d.month, d.day, h * 60 + m, this.tz);
      if (at > ms && !pl.done?.[dateKey(d)]) {
        // too late to fit today's: it's tomorrow's
        if (at - ms >= pl.minutes * 60000) return { at, key: dateKey(d) };
      }
      d = addDays(d, 1);
    }
    return null;
  }

  /** Where each plan's next run is, and switching things on and off at its times. */
  runPlans(now = Date.now()) {
    const rates = this.rates();
    let dirty = false;
    for (const pl of this.data.plans) {
      if (pl.run) { if (this._runStep(pl, now)) dirty = true; continue; }
      if (!pl.enabled) { if (pl.next) { pl.next = null; dirty = true; } continue; }
      const dl = this.deadline(pl, now);
      if (!dl) continue;
      const need = pl.minutes * 60000;
      const from = Math.max(now, dl.at - DAY);
      const covered = knownUntil(rates, now) >= dl.at;
      let choice = rates.length ? cheapest(rates, { from, to: dl.at, minutes: pl.minutes, together: pl.together, maxP: pl.maxP }) : null;
      if (!rates.length) choice = { start: dl.at - need, end: dl.at, avg: null, slots: [[dl.at - need, dl.at]] }; // no prices: as late as it can
      const average = rates.length ? averageOver(rates, from, Math.min(dl.at, knownUntil(rates, now))) : null;
      const next = choice ? { key: dl.key, by: dl.at, start: choice.start, end: choice.end, avg: choice.avg, slots: choice.slots, provisional: !covered && rates.length > 0, average: r1(average) } : null;
      if (JSON.stringify(next) !== JSON.stringify(pl.next)) { pl.next = next; dirty = true; }
      if (!choice) {
        // nothing at or under its price limit before the deadline, now all the prices are known
        if (covered && pl.maxP != null) {
          pl.done = { ...(pl.done || {}), [dl.key]: 'skipped' };
          pl.last = { at: now, text: `Not run: no time at ${pl.maxP}p or less before ${pl.by}` };
          this.addEvent(`${pl.name}: not run today, as there's no time at ${pl.maxP}p or less before ${pl.by}.`, 'plan');
          dirty = true;
        }
        continue;
      }
      // start: once all the prices up to the deadline are known (or it can't wait any longer for them)
      const mustGo = dl.at - now <= need + 2 * H;
      if (choice.start <= now + 1000 && (covered || mustGo || !rates.length)) {
        pl.run = { key: dl.key, start: choice.start, end: choice.end, avg: choice.avg, slots: choice.slots, by: dl.at, on: false, ours: false, began: now };
        pl.next = null;
        this._runStep(pl, now);
        dirty = true;
      }
    }
    if (dirty) { this.store.save(); this.changed(); }
  }

  /** A plan's run: on at the start of each of its times, off at the end. Returns whether anything changed. */
  _runStep(pl, now) {
    const run = pl.run;
    const inSlot = run.slots.find(([s, e]) => s <= now && now < e);
    const st = this.st(pl.entity);
    const avail = st && !BAD.has(st.state);
    const domain = pl.entity.split('.')[0];
    if (inSlot && !run.on) {
      if (!avail) return false; // when it's back
      run.on = true;
      if (st.state !== 'on') {
        run.ours = true;
        this.ha.callService(domain, 'turn_on', { entity_id: pl.entity }).catch((err) => { this.log.warn?.(`Energy plan ${pl.name}: ${err.message}`); run.on = false; run.ours = false; });
      }
      if (!run.told) {
        run.told = true;
        const words = this.planWords(pl, run);
        this.addEvent(`${pl.name}: ${this.friendly(pl.entity)} on, ${words}.`, 'plan');
        if (this.data.settings.alerts.plans) this.notify(pl.name, `${this.friendly(pl.entity)} on now: ${words}.`).catch(() => {});
      }
      return true;
    }
    let changed = false;
    if (!inSlot && run.on) {
      run.on = false;
      if (run.ours && avail && st.state === 'on') this.ha.callService(domain, 'turn_off', { entity_id: pl.entity }).catch((err) => this.log.warn?.(`Energy plan ${pl.name}: ${err.message}`));
      run.ours = false;
      changed = true;
    }
    if (now >= run.end) {
      pl.done = { ...(pl.done || {}), [run.key]: 'ran' };
      // keep the last fortnight's
      const keys = Object.keys(pl.done).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete pl.done[k];
      pl.last = { at: now, text: `Ran ${this.clock(run.start)}–${this.clock(run.end)}${run.avg != null ? ` at ${run.avg}p average` : ''}` };
      this.addEvent(`${pl.name}: done, ${this.friendly(pl.entity)} off (${this.clock(run.start)}–${this.clock(run.end)}).`, 'plan');
      pl.run = null;
      if (pl.repeat === 'once') pl.enabled = false;
      return true;
    }
    return changed;
  }

  planWords(pl, run) {
    const hrs = pl.minutes === 30 ? 'half hour' : pl.minutes === 60 ? 'hour' : `${pl.minutes / 60} hours`;
    const when = run.slots.length > 1 ? run.slots.map(([s, e]) => `${this.clock(s)}–${this.clock(e)}`).join(', ') : `${this.clock(run.start)}–${this.clock(run.end)}`;
    return `the cheapest ${hrs} before ${pl.by}, ${when}${run.avg != null ? ` at ${run.avg}p average` : ''}`;
  }

  cleanPlan(input, cur = {}) {
    const out = { ...cur };
    if ('name' in input) { out.name = String(input.name || '').trim().slice(0, 40); if (!out.name) throw new UserError('Give it a name, e.g. Dishwasher'); }
    if ('entity' in input) {
      const id = String(input.entity || '');
      if (!SWITCHABLE.includes(id.split('.')[0]) || !this.states.has(id)) throw new UserError('Choose a socket or switch Home Assistant has');
      out.entity = id;
    }
    if ('minutes' in input) {
      const v = Math.round(Number(input.minutes) / 30) * 30;
      if (!(v >= 30 && v <= 720)) throw new UserError('Run for between half an hour and 12 hours');
      out.minutes = v;
    }
    if ('by' in input) { if (!validTime(input.by)) throw new UserError('Done by: times look like 07:00'); out.by = input.by; }
    if ('together' in input) out.together = input.together !== false;
    if ('repeat' in input) { if (!['daily', 'once'].includes(input.repeat)) throw new UserError('Every day, or just once'); out.repeat = input.repeat; }
    if ('maxP' in input) {
      if (input.maxP === null || input.maxP === '') out.maxP = null;
      else { const v = Number(input.maxP); if (!Number.isFinite(v) || v < -100 || v > 200) throw new UserError('A price limit in pence, like 15'); out.maxP = Math.round(v * 10) / 10; }
    }
    if ('enabled' in input) out.enabled = input.enabled !== false;
    return out;
  }

  addPlan(input) {
    const pl = this.cleanPlan({ together: true, repeat: 'daily', maxP: null, enabled: true, ...input }, { id: this.store.newId(), done: {}, run: null, next: null, last: null });
    for (const k of ['name', 'entity', 'minutes', 'by']) if (pl[k] == null) throw new UserError('Choose what to switch, for how long and by when');
    this.data.plans.push(pl);
    this.addEvent(`Plan added: ${pl.name}, ${this.friendly(pl.entity)} for ${pl.minutes / 60} h at the cheapest time before ${pl.by}${pl.repeat === 'daily' ? ', every day' : ''}.`, 'manual');
    this._watch = null;
    this.store.save();
    this.runPlans();
    this.changed();
    return pl;
  }

  plan(id) {
    const pl = this.data.plans.find((p) => p.id === id);
    if (!pl) throw new UserError('No such plan', 404);
    return pl;
  }

  updatePlan(id, input) {
    const pl = this.plan(id);
    Object.assign(pl, this.cleanPlan(input, pl));
    if (pl.run && (('enabled' in input && !pl.enabled) || 'entity' in input)) this.stopRun(pl, 'changed');
    pl.next = null;
    this._watch = null;
    this.store.save();
    this.runPlans();
    this.changed();
    return pl;
  }

  stopRun(pl, why) {
    const run = pl.run;
    if (!run) return;
    if (run.on && run.ours) this.ha.callService(pl.entity.split('.')[0], 'turn_off', { entity_id: pl.entity }).catch(() => {});
    pl.done = { ...(pl.done || {}), [run.key]: 'stopped' };
    pl.run = null;
    this.addEvent(`${pl.name}: stopped ${why === 'changed' ? 'as the plan was changed' : 'from here'}${run.on && run.ours ? `, ${this.friendly(pl.entity)} off` : ''}.`, 'manual');
  }

  /** Skip the next run (or stop the one running). */
  skipPlan(id) {
    const pl = this.plan(id);
    if (pl.run) this.stopRun(pl, 'skip');
    else {
      // the run shown (or, if none's been worked out yet, the next one due)
      const dl = pl.next ? { key: pl.next.key, at: pl.next.by } : this.deadline(pl, Date.now());
      if (!dl) throw new UserError('Nothing to skip');
      pl.done = { ...(pl.done || {}), [dl.key]: 'skipped' };
      pl.next = null;
      this.addEvent(`${pl.name}: the run before ${pl.by} on ${this.dayName(dl.at)} skipped from here.`, 'manual');
    }
    this.store.save();
    this.runPlans();
    this.changed();
  }

  deletePlan(id) {
    const pl = this.plan(id);
    if (pl.run) this.stopRun(pl, 'skip');
    this.data.plans = this.data.plans.filter((p) => p !== pl);
    this._watch = null;
    this.store.data.plans = this.data.plans;
    this.addEvent(`Plan removed: ${pl.name}.`, 'manual');
    this.store.save();
    this.changed();
  }

  // ---------- phone alerts ----------

  async notify(title, message) {
    const svcs = this.data.settings.alerts.notify;
    if (!svcs.length) return 0;
    const results = await Promise.allSettled(svcs.map((s) => this.ha.callService('notify', s.replace(/^notify\./, ''), { title, message, data: { url: this.panel?.() ? `${this.panel()}?section=energy` : undefined, group: 'home-control-energy' } })));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) this.log.warn?.(`Energy alert: ${failed.length} phone(s) failed: ${failed[0].reason?.message}`);
    return results.length - failed.length;
  }

  async testAlert() {
    if (!this.data.settings.alerts.notify.length) throw new UserError('Choose a phone to alert first');
    const n = await this.notify('Home Control', 'Test alert. This is how energy alerts will look.');
    if (!n) throw new UserError('The phone alert didn\'t send: check the phone in Home Assistant');
    return n;
  }

  alerts(now = Date.now()) {
    const A = this.data.settings.alerts;
    if (!A.notify.length) return;
    const rates = this.rates();
    const told = this.data.told;
    // the price has fallen to the level asked for (once for each stretch of it)
    if (A.cheapBelow != null && rates.length) {
      const r = rateAt(rates, now);
      if (r && r.p <= A.cheapBelow) {
        let i = rates.indexOf(r); while (i > 0 && rates[i - 1].p <= A.cheapBelow && rates[i - 1].end === rates[i].start) i--;
        let j = rates.indexOf(r); while (j + 1 < rates.length && rates[j + 1].p <= A.cheapBelow && rates[j + 1].start === rates[j].end) j++;
        const key = String(rates[i].start);
        if (told.cheap !== key) {
          told.cheap = key;
          const avg = r1(averageOver(rates, now, rates[j].end));
          const msg = r.p <= 0 ? `You're being paid to use electricity until ${this.clock(rates[j].end)} (${avg}p on average).` : `Electricity is ${r.p}p now, ${avg}p on average until ${this.clock(rates[j].end)}.`;
          this.notify('Cheap electricity now', msg).catch(() => {});
          this.addEvent(`Phones told: ${msg}`, 'alert');
          this.store.save();
        }
      }
    }
    // tomorrow's prices have come in (for prices that change: Agile, Tracker)
    if (A.tomorrow && rates.length) {
      const tStart = this.dayStart(this.dayStart(now) + 36 * H); // tomorrow, local midnight
      const tEnd = this.dayStart(tStart + 36 * H);
      const tomorrow = rates.filter((r) => r.start >= tStart && r.start < tEnd);
      const key = dateKey(localDate(tStart + H, this.tz));
      if (tomorrow.length >= 40 && told.tomorrow !== key) {
        const lim = bandLimits(tomorrow);
        if (lim.kind === 'varies' || lim.kind === 'few') {
          told.tomorrow = key;
          const c = cheapest(tomorrow, { from: tStart, to: tEnd, minutes: 180, together: true });
          const top = [...tomorrow].sort((a, b) => b.p - a.p)[0];
          const msg = `Cheapest 3 hours ${this.clock(c.start)}–${this.clock(c.end)} at ${c.avg}p. Dearest ${this.clock(top.start)} at ${top.p}p.`;
          this.notify('Tomorrow\'s electricity prices', msg).catch(() => {});
          this.addEvent(`Tomorrow's prices are in. ${msg}`, 'alert');
          this.store.save();
        } else if (lim.kind === 'flat') {
          told.tomorrow = key;
          const msg = `${tomorrow[0].p}p all day${rateAt(rates, now) ? ` (${rateAt(rates, now).p}p today)` : ''}.`;
          this.notify('Tomorrow\'s electricity price', msg).catch(() => {});
          this.addEvent(`Tomorrow's price is in: ${msg}`, 'alert');
          this.store.save();
        }
      }
    }
  }

  // ---------- each minute or so ----------

  tick(now = Date.now()) {
    if (!this.ready || this.disabled) return;
    try { this.runPlans(now); } catch (err) { this.log.warn?.(`Energy plans: ${err.message}`); }
    try { this.alerts(now); } catch (err) { this.log.warn?.(`Energy alerts: ${err.message}`); }
    // the price changes on the half hour: keep the page's "now" moving
    const slot = Math.floor(now / (30 * 60000));
    if (slot !== this.lastSlot) { this.lastSlot = slot; this.changed(); }
  }

  _need() {
    if (!this.ready) throw new UserError('Not connected to Home Assistant right now', 503);
    if (this.disabled) throw new UserError('Energy is turned off in Home Control\'s settings', 409);
  }

  // ---------- settings ----------

  async settingsView() {
    const m = this.meters();
    const src = this.sources();
    const switches = [...this.states.values()]
      .filter((s) => SWITCHABLE.includes(s.entity_id.split('.')[0]) && !OCTO.test(s.entity_id))
      .map((s) => ({ entity: s.entity_id, name: s.attributes?.friendly_name || s.entity_id, socket: s.attributes?.device_class === 'outlet' || /plug|socket|outlet/i.test(`${s.entity_id} ${s.attributes?.friendly_name || ''}`) }))
      .sort((a, b) => (b.socket - a.socket) || a.name.localeCompare(b.name));
    return {
      settings: this.data.settings,
      meters: m.elec.map((x) => ({ key: x.key, tariff: tariffName(x.tariff) || x.tariff, code: x.tariff })),
      gasMeters: m.gas.map((x) => ({ key: x.key, tariff: x.tariff })),
      dashboard: {
        electricity: src.elec.map((x) => ({ stat: x.stat, name: this.st(x.stat)?.attributes?.friendly_name || x.stat, cost: !!x.cost })),
        gas: src.gas.map((x) => ({ stat: x.stat, name: this.st(x.stat)?.attributes?.friendly_name || x.stat, cost: !!x.cost })),
        devices: src.devices.length, price: src.priceEntity || (src.priceNumber != null ? `${r2(src.priceNumber * 100)}p` : null),
      },
      ev: !!this.evIds(),
      phones: await this.notifyTargets(),
      switches,
      plans: this.data.plans.map((p) => this.planView(p)),
    };
  }

  updateSettings(body) {
    const s = this.data.settings;
    if ('meter' in body) { if (body.meter != null && !this.meters().elec.some((x) => x.key === body.meter)) throw new UserError('Unknown meter'); s.meter = body.meter || null; this.rateCache.sig = null; }
    if ('gasMeter' in body) s.gasMeter = body.gasMeter || null;
    if (body.bands) {
      const b = { ...s.bands };
      if ('mode' in body.bands) { if (!['auto', 'fixed'].includes(body.bands.mode)) throw new UserError('Worked out, or set by hand'); b.mode = body.bands.mode; }
      for (const k of ['cheap', 'peak']) if (k in body.bands) { const v = Number(body.bands[k]); if (!Number.isFinite(v) || v < -50 || v > 200) throw new UserError('Prices in pence, like 15'); b[k] = Math.round(v * 10) / 10; }
      if (b.mode === 'fixed' && b.cheap >= b.peak) throw new UserError('Cheap has to be below peak');
      s.bands = b;
    }
    if (body.alerts) {
      const a = { ...s.alerts };
      if (Array.isArray(body.alerts.notify)) a.notify = [...new Set(body.alerts.notify.filter((x) => /^notify\.\w+$/.test(x)))];
      if ('cheapBelow' in body.alerts) {
        const v = body.alerts.cheapBelow;
        if (v === null || v === '') a.cheapBelow = null;
        else { const n = Number(v); if (!Number.isFinite(n) || n < -50 || n > 100) throw new UserError('A price in pence, like 5'); a.cheapBelow = Math.round(n * 10) / 10; }
      }
      for (const k of ['tomorrow', 'plans']) if (typeof body.alerts[k] === 'boolean') a[k] = body.alerts[k];
      s.alerts = a;
    }
    if (body.card) {
      const c = { ...s.card };
      for (const k of ['chart', 'ev', 'plans']) if (typeof body.card[k] === 'boolean') c[k] = body.card[k];
      s.card = c;
    }
    this.store.save();
    this.tick();
    this.changed();
  }

  // ---------- renames (renames.js) ----------

  entityIds() { return this.data.plans.map((p) => p.entity).filter(Boolean); }

  renameEntity(from, to) {
    const hit = this.data.plans.filter((p) => p.entity === from);
    if (!hit.length) return false;
    for (const p of hit) p.entity = to;
    this._watch = null;
    this.store.save();
    this.addEvent(`Home Assistant renamed ${from} to ${to}: ${hit.map((p) => p.name).join(', ')} ${hit.length === 1 ? 'follows' : 'follow'} it.`);
    this.changed();
    return true;
  }

  // ---------- Activity ----------

  addEvent(text, kind = 'note') {
    const ev = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), text, kind };
    this.data.events.push(ev);
    if (this.data.events.length > MAX_EVENTS) this.data.events.splice(0, this.data.events.length - MAX_EVENTS);
    this.log.info?.(`Energy: ${text}`);
    this.store.save();
    this.changed();
  }

  events({ before = Infinity, limit = 60 } = {}) {
    return this.data.events.filter((e) => e.at < before).slice(-limit).reverse();
  }

  // ---------- helpers ----------

  friendly(id) { return this.st(id)?.attributes?.friendly_name || this.lastName?.(id) || id; }

  /** Local midnight at the start of the day `ms` is in. */
  dayStart(ms) {
    const d = localDate(ms, this.tz);
    return zonedToUtc(d.year, d.month, d.day, 0, this.tz);
  }

  clock(ms) {
    const p = zonedParts(ms, this.tz);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  dayName(ms) {
    const today = dateKey(localDate(Date.now(), this.tz));
    const k = dateKey(localDate(ms, this.tz));
    if (k === today) return 'today';
    if (k === dateKey(localDate(Date.now() + DAY, this.tz))) return 'tomorrow';
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, weekday: 'long' }).format(new Date(ms));
  }
}
