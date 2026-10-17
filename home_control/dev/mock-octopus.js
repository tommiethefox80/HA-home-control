// A stand-in for the Octopus Energy integration (BottlecapDave's), and Home Assistant's Energy
// dashboard and long-term statistics, for the mock Home Assistant. Off until POST /octopus { on: true }.
//
// Tariffs: 'iog' (Intelligent Octopus Go: 7p from 23:30 to 05:30, 26.5p otherwise, and the off-peak
// price whenever the car is charging), 'agile' (half-hourly, with a peak from 16:00 to 19:00 and a
// cheap night; tomorrow's prices only after 16:00 unless asked), 'flat'.
import { zonedParts, zonedToUtc, localDate, addDays } from '../server/src/lighting/schedule.js';

const SERIAL = '21L4123456';
const MPAN = '1012345678901';
const MPRN = '8765432109';
const EV = 'a1b2c3d4';
const E = `octopus_energy_electricity_${SERIAL.toLowerCase()}_${MPAN}`;
const G = `octopus_energy_gas_${SERIAL.toLowerCase()}_${MPRN}`;
const I = `octopus_energy_${EV}_intelligent`;
const SLOT = 30 * 60000;
const H = 3600000;
const STANDING = 0.5361; const GAS_STANDING = 0.3104; const GAS_RATE = 0.0598;
const CODES = { iog: 'E-1R-INTELLI-VAR-24-10-29-N', agile: 'E-1R-AGILE-24-10-01-N', flat: 'E-1R-VAR-22-11-01-N' };

export function createOctopus({ states, fireEvent, publicState, nowIso, TZ }) {
  const o = { on: false, tariff: 'iog', homeMini: true, gas: true, ev: true, dashboard: true, tomorrow: null, dispatches: [], completed: [] };
  const iso = (t) => new Date(t).toISOString();
  const dayStart = (t) => { const d = localDate(t, TZ); return zonedToUtc(d.year, d.month, d.day, 0, TZ); };
  const nextDay = (t) => { const d = addDays(localDate(t, TZ), 1); return zonedToUtc(d.year, d.month, d.day, 0, TZ); };
  const prevDay = (t) => { const d = addDays(localDate(t, TZ), -1); return zonedToUtc(d.year, d.month, d.day, 0, TZ); };
  const mins = (t) => zonedParts(t, TZ).minutes;
  const wiggle = (n) => ((Math.sin(n * 12.9898) * 43758.5453) % 1 + 1) % 1; // repeatable noise

  /** The car's charging, as planned by Octopus: an hour from the next half hour + 1h, and the night. */
  function planDispatches(now = Date.now()) {
    const n = Math.ceil(now / SLOT) * SLOT + 2 * SLOT;
    const d0 = localDate(now, TZ);
    const night = zonedToUtc(d0.year, d0.month, d0.day, 23 * 60 + 30, TZ);
    o.dispatches = [{ start: n, end: n + 2 * SLOT, source: 'smart-charge' }, { start: night, end: night + 8 * SLOT, source: 'smart-charge' }];
    const ds = dayStart(now);
    o.completed = [{ start: ds + 60 * 60000, end: ds + 4 * H, charge_in_kwh: 18.4, source: 'smart-charge', location: 'AT_HOME' }];
  }
  const inDispatch = (t) => o.ev && o.dispatches.some((d) => d.start <= t && t < d.end);
  const nightlyCharge = (t) => { const m = mins(t); return o.ev && m >= 60 && m < 240; }; // past days: the car charged 01:00–04:00

  function price(t) {
    const m = mins(t);
    if (o.tariff === 'flat') return 0.2462;
    if (o.tariff === 'iog') {
      const off = m >= 23 * 60 + 30 || m < 5 * 60 + 30;
      return off || inDispatch(t) ? 0.07 : 0.2650;
    }
    // Agile
    const k = Math.floor(t / SLOT);
    const base = m < 240 ? 10 : m < 420 ? 14 : m < 600 ? 23 : m < 780 ? 16 - (m - 600) / 60 : m < 840 ? -1.5 : m < 960 ? 18 : m < 1140 ? 34 : m < 1380 ? 24 - (m - 1140) / 60 : 14;
    return Math.round((base + (m >= 780 && m < 840 ? 0 : wiggle(k) * 3 - 1.5)) * 100) / 10000;
  }
  const adjusted = (t) => o.tariff === 'iog' && inDispatch(t) && !(mins(t) >= 23 * 60 + 30 || mins(t) < 5 * 60 + 30);

  function ratesFor(day) {
    const out = [];
    for (let t = day; t < nextDay(day); t += SLOT) out.push({ start: iso(t), end: iso(t + SLOT), value_inc_vat: price(t), is_capped: false, is_intelligent_adjusted: adjusted(t) });
    return out;
  }

  // electricity used each half hour (kWh)
  function use(t, now) {
    const m = mins(t);
    let k = 0.12 + wiggle(Math.floor(t / SLOT) + 7) * 0.05;
    if (m >= 420 && m < 510) k += 0.35;
    if (m >= 720 && m < 780) k += 0.25;
    if (m >= 1050 && m < 1200) k += 0.55;
    if (t < dayStart(now) ? nightlyCharge(t) : inDispatch(t) || o.completed.some((d) => d.start <= t && t < d.end)) k += 3.6;
    return Math.round(k * 1000) / 1000;
  }
  function gasUse(t) {
    const m = mins(t);
    let k = 0.05;
    if (m >= 330 && m < 480) k += 2.4;
    if (m >= 990 && m < 1290) k += 1.6;
    return Math.round((k + wiggle(Math.floor(t / SLOT) + 3) * 0.3) * 1000) / 1000;
  }
  function charges(from, to, now, kind) {
    const out = [];
    for (let t = from; t < to && t + SLOT <= now + SLOT; t += SLOT) {
      if (t >= now) break;
      const consumption = kind === 'gas' ? gasUse(t) : use(t, now);
      const rate = kind === 'gas' ? GAS_RATE : price(t);
      out.push({ start: iso(t), end: iso(t + SLOT), rate, consumption, cost: Math.round(consumption * rate * 100) / 100, cost_raw: consumption * rate });
    }
    return out;
  }

  function set(id, state, attributes) {
    const old = states.get(id);
    const ns = { entity_id: id, state: String(state), attributes, last_changed: old && old.state === String(state) ? old.last_changed : nowIso(), last_updated: nowIso(), context: { id: `o${Date.now()}`, parent_id: null, user_id: null } };
    if (old && JSON.stringify(old.attributes) === JSON.stringify(attributes) && old.state === ns.state) return;
    states.set(id, ns);
    fireEvent('state_changed', { entity_id: id, old_state: old ? publicState(old) : null, new_state: publicState(ns) });
  }
  function drop(id) {
    const old = states.get(id);
    if (!old) return;
    states.delete(id);
    fireEvent('state_changed', { entity_id: id, old_state: publicState(old), new_state: null });
  }
  const ours = () => [...states.keys()].filter((id) => id.includes('octopus_energy_') || /^sensor\.(dishwasher|ev_charger|kettle)_energy$/.test(id) || id === 'switch.dishwasher_plug');

  /** Every Octopus entity as it is now. */
  function refresh(now = Date.now()) {
    if (!o.on) { for (const id of ours()) drop(id); return; }
    const today = dayStart(now); const tomorrow = nextDay(now); const yday = prevDay(now);
    const showTomorrow = o.tomorrow ?? (o.tariff !== 'agile' || mins(now) >= 16 * 60);
    const meter = { mpan: MPAN, serial_number: SERIAL, is_export: false, is_smart_meter: true };
    const cur = Math.floor(now / SLOT) * SLOT;
    const todays = ratesFor(today);
    const day = todays.map((r) => r.value_inc_vat);
    set(`sensor.${E}_current_rate`, price(now), { ...meter, tariff: CODES[o.tariff], start: iso(cur), end: iso(cur + SLOT), is_capped: false, is_intelligent_adjusted: adjusted(now),
      current_day_min_rate: Math.min(...day), current_day_max_rate: Math.max(...day), current_day_average_rate: day.reduce((a, b) => a + b, 0) / day.length, price_cap: null,
      unit_of_measurement: 'GBP/kWh', device_class: 'monetary', friendly_name: `Electricity ${SERIAL} ${MPAN} Current Rate` });
    let n = cur + SLOT; while (n < cur + 2 * 86400000 && price(n) === price(now)) n += SLOT;
    set(`sensor.${E}_next_rate`, price(n), { ...meter, start: iso(n), end: iso(n + SLOT), unit_of_measurement: 'GBP/kWh', friendly_name: `Electricity ${SERIAL} ${MPAN} Next Rate` });
    const ev = (id, rates, name) => set(id, nowIso(), { rates, tariff_code: CODES[o.tariff], serial_number: SERIAL, mpan: MPAN, friendly_name: name, event_type: 'octopus_energy_electricity_rates' });
    ev(`event.${E}_previous_day_rates`, ratesFor(yday), 'Previous Day Rates');
    ev(`event.${E}_current_day_rates`, todays, 'Current Day Rates');
    ev(`event.${E}_next_day_rates`, showTomorrow ? ratesFor(tomorrow) : [], 'Next Day Rates');
    if (o.tariff !== 'agile') {
      const m = mins(now); const offNow = (m >= 23 * 60 + 30 || m < 5 * 60 + 30) || inDispatch(now);
      set(`binary_sensor.${E}_off_peak`, offNow ? 'on' : 'off', { friendly_name: 'Off Peak', current_start: offNow ? iso(cur) : null, current_end: offNow ? iso(cur + SLOT) : null });
    } else drop(`binary_sensor.${E}_off_peak`);
    // yesterday from the smart meter
    const yc = charges(yday, today, today, 'elec');
    const ySum = yc.reduce((a, c) => a + c.cost_raw, 0); const yKwh = yc.reduce((a, c) => a + c.consumption, 0);
    set(`sensor.${E}_previous_accumulative_cost`, Math.round((ySum + STANDING) * 100) / 100, { ...meter, tariff_code: CODES[o.tariff], standing_charge: STANDING, total_without_standing_charge: Math.round(ySum * 100) / 100, total: Math.round((ySum + STANDING) * 100) / 100, charges: yc, unit_of_measurement: 'GBP', device_class: 'monetary', friendly_name: 'Previous Accumulative Cost' });
    set(`sensor.${E}_previous_accumulative_consumption`, Math.round(yKwh * 1000) / 1000, { ...meter, total: yKwh, charges: yc.map(({ start, end, consumption }) => ({ start, end, consumption })), unit_of_measurement: 'kWh', device_class: 'energy', friendly_name: 'Previous Accumulative Consumption' });
    // today, from the Home Mini
    if (o.homeMini) {
      const c = charges(today, now, now, 'elec');
      const sum = c.reduce((a, x) => a + x.cost_raw, 0); const k = c.reduce((a, x) => a + x.consumption, 0);
      set(`sensor.${E}_current_accumulative_cost`, Math.round((sum + STANDING) * 100) / 100, { ...meter, tariff_code: CODES[o.tariff], standing_charge: STANDING, total_without_standing_charge: Math.round(sum * 100) / 100, total: Math.round((sum + STANDING) * 100) / 100, charges: c, unit_of_measurement: 'GBP', device_class: 'monetary', state_class: 'total', friendly_name: 'Current Accumulative Cost' });
      set(`sensor.${E}_current_accumulative_consumption`, Math.round(k * 1000) / 1000, { ...meter, total: k, charges: c.map(({ start, end, consumption }) => ({ start, end, consumption })), unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', friendly_name: 'Current Accumulative Consumption' });
      set(`sensor.${E}_current_demand`, Math.round(inDispatch(now) ? 7600 : 380 + wiggle(Math.floor(now / 60000)) * 400), { unit_of_measurement: 'W', device_class: 'power', friendly_name: 'Current Demand' });
    } else for (const s of ['current_accumulative_cost', 'current_accumulative_consumption', 'current_demand']) drop(`sensor.${E}_${s}`);
    // gas
    if (o.gas) {
      const gm = { mprn: MPRN, serial_number: SERIAL, is_smart_meter: true };
      set(`sensor.${G}_current_rate`, GAS_RATE, { ...gm, tariff: 'G-1R-VAR-22-11-01-N', start: iso(today), end: iso(tomorrow), is_capped: false, price_cap: null, unit_of_measurement: 'GBP/kWh', friendly_name: 'Gas Current Rate' });
      const gy = charges(yday, today, today, 'gas'); const gys = gy.reduce((a, c) => a + c.cost_raw, 0);
      set(`sensor.${G}_previous_accumulative_cost`, Math.round((gys + GAS_STANDING) * 100) / 100, { ...gm, standing_charge: GAS_STANDING, total: gys + GAS_STANDING, charges: gy, unit_of_measurement: 'GBP', device_class: 'monetary', friendly_name: 'Gas Previous Accumulative Cost' });
      if (o.homeMini) {
        const gc = charges(today, now, now, 'gas'); const gs = gc.reduce((a, c) => a + c.cost_raw, 0); const gk = gc.reduce((a, c) => a + c.consumption, 0);
        set(`sensor.${G}_current_accumulative_cost`, Math.round((gs + GAS_STANDING) * 100) / 100, { ...gm, tariff_code: 'G-1R-VAR-22-11-01-N', standing_charge: GAS_STANDING, total: gs + GAS_STANDING, charges: gc, unit_of_measurement: 'GBP', device_class: 'monetary', state_class: 'total', friendly_name: 'Gas Current Accumulative Cost' });
        set(`sensor.${G}_current_accumulative_consumption_kwh`, Math.round(gk * 1000) / 1000, { ...gm, charges: gc.map(({ start, end, consumption }) => ({ start, end, consumption })), unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', friendly_name: 'Gas Current Accumulative Consumption (kWh)' });
      }
    } else for (const id of ours().filter((x) => x.includes('octopus_energy_gas_'))) drop(id);
    // the car (Intelligent Octopus, through a Projekt EV charger)
    if (o.ev && o.tariff === 'iog') {
      const live = o.dispatches.find((d) => d.start <= now && now < d.end);
      const next = o.dispatches.find((d) => d.start > now);
      set(`binary_sensor.${I}_dispatching`, live ? 'on' : 'off', {
        planned_dispatches: o.dispatches.filter((d) => d.end > now).map((d) => ({ start: iso(d.start), end: iso(d.end), source: d.source })),
        completed_dispatches: o.completed.map((d) => ({ ...d, start: iso(d.start), end: iso(d.end) })),
        started_dispatches: live ? [{ start: iso(live.start), end: iso(live.end) }] : [],
        provider: 'PROJEKT', vehicle_battery_size_in_kwh: 64, charge_point_power_in_kw: 7.4,
        current_start: live ? iso(live.start) : null, current_end: live ? iso(live.end) : null,
        next_start: next ? iso(next.start) : null, next_end: next ? iso(next.end) : null, manually_refresh_dispatches: false, friendly_name: 'Intelligent Dispatching',
      });
      const bump = states.get(`switch.${I}_bump_charge`)?.state === 'on';
      set(`sensor.${I}_state`, bump ? 'BOOSTING' : live ? 'SMART_CONTROL_IN_PROGRESS' : 'SMART_CONTROL_CAPABLE', { friendly_name: 'Intelligent State' });
      set(`sensor.${I}_state_of_charge`, 'unknown', { unit_of_measurement: '%', friendly_name: 'State of Charge' });
      if (!states.has(`switch.${I}_bump_charge`)) set(`switch.${I}_bump_charge`, 'off', { friendly_name: 'Bump Charge' });
      if (!states.has(`switch.${I}_smart_charge`)) set(`switch.${I}_smart_charge`, 'on', { friendly_name: 'Smart Charge' });
      if (!states.has(`number.${I}_charge_target`)) set(`number.${I}_charge_target`, '80', { min: 10, max: 100, step: 5, unit_of_measurement: '%', friendly_name: 'Charge Target' });
      if (!states.has(`select.${I}_target_time`)) {
        const options = []; for (let mm = 240; mm <= 660; mm += 30) options.push(`${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`);
        set(`select.${I}_target_time`, '07:00', { options, raw_value: '07:00:00', friendly_name: 'Target Time' });
      }
    } else for (const id of ours().filter((x) => x.includes('_intelligent_'))) drop(id);
    // things the Energy dashboard measures by device, and a socket for a plan
    set('sensor.dishwasher_energy', '412.3', { unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', friendly_name: 'Dishwasher energy' });
    set('sensor.ev_charger_energy', '5120.4', { unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', friendly_name: 'Project EV charger energy' });
    set('sensor.kettle_energy', '88.1', { unit_of_measurement: 'kWh', device_class: 'energy', state_class: 'total_increasing', friendly_name: 'Kettle energy' });
    if (!states.has('switch.dishwasher_plug')) set('switch.dishwasher_plug', 'off', { friendly_name: 'Dishwasher plug', device_class: 'outlet' });
  }

  // ---------- Home Assistant's Energy dashboard and statistics ----------

  const ELEC = `sensor.${E}_current_accumulative_consumption`;
  const ELEC_COST = `sensor.${E}_current_accumulative_cost`;
  const GAS = `sensor.${G}_current_accumulative_consumption_kwh`;
  const GAS_COST = `sensor.${G}_current_accumulative_cost`;
  const DEVICES = { 'sensor.dishwasher_energy': 'dish', 'sensor.ev_charger_energy': 'ev', 'sensor.kettle_energy': 'kettle' };

  function prefs() {
    return {
      energy_sources: [
        { type: 'grid', flow_from: [{ stat_energy_from: ELEC, stat_cost: ELEC_COST, entity_energy_price: null, number_energy_price: null }], flow_to: [], cost_adjustment_day: 0 },
        ...(o.gas ? [{ type: 'gas', stat_energy_from: GAS, stat_cost: GAS_COST, entity_energy_price: null, number_energy_price: null }] : []),
      ],
      device_consumption: [{ stat_consumption: 'sensor.ev_charger_energy', name: 'Car charger' }, { stat_consumption: 'sensor.dishwasher_energy', name: null }, { stat_consumption: 'sensor.kettle_energy', name: null }],
    };
  }

  // what each statistic changed by in each half hour
  function slotValue(id, t, now) {
    if (id === ELEC) return use(t, now);
    if (id === ELEC_COST) return use(t, now) * price(t) + (mins(t) === 0 ? STANDING : 0);
    if (id === GAS) return gasUse(t);
    if (id === GAS_COST) return gasUse(t) * GAS_RATE + (mins(t) === 0 ? GAS_STANDING : 0);
    const dev = DEVICES[id];
    if (dev === 'ev') return (t < dayStart(now) ? nightlyCharge(t) : inDispatch(t) || o.completed.some((d) => d.start <= t && t < d.end)) ? 3.6 : 0;
    if (dev === 'dish') return localDate(t, TZ).day % 2 === 0 && mins(t) >= 120 && mins(t) < 210 ? 0.33 : 0;
    if (dev === 'kettle') return mins(t) >= 420 && mins(t) < 450 ? 0.11 : mins(t) >= 1020 && mins(t) < 1050 ? 0.09 : 0;
    return null;
  }

  function statistics(m) {
    const now = Date.now();
    const start = Date.parse(m.start_time); const end = Math.min(Date.parse(m.end_time || nowIso()), now);
    const out = {};
    for (const id of m.statistic_ids || []) {
      if (!o.on || slotValue(id, now, now) == null) continue;
      const rows = [];
      const periodEnd = (t) => (m.period === 'day' ? nextDay(t) : m.period === 'hour' ? t + H : t + 5 * 60000);
      let t = m.period === 'day' ? dayStart(start) : Math.floor(start / H) * H;
      while (t < end) {
        const e = periodEnd(t);
        let sum = 0;
        for (let s = t; s < e && s < now; s += SLOT) sum += slotValue(id, s, now);
        rows.push({ start: t, end: e, change: Math.round(sum * 1000) / 1000 });
        t = e;
      }
      out[id] = rows;
    }
    return out;
  }

  /** Answer the Energy dashboard and statistics commands (true if it was one of them). */
  function handle(m, reply) {
    if (m.type === 'energy/get_prefs') {
      if (!o.on || !o.dashboard) return reply(null, false, { code: 'not_found', message: 'No prefs' }), true;
      return reply(prefs()), true;
    }
    if (m.type === 'energy/info') return reply({ cost_sensors: {}, solar_forecast_domains: [] }), true;
    if (m.type === 'recorder/get_statistics_metadata') {
      return reply((m.statistic_ids || []).filter((id) => o.on).map((id) => ({ statistic_id: id, statistics_unit_of_measurement: /cost/.test(id) ? 'GBP' : 'kWh', unit_class: /cost/.test(id) ? null : 'energy', source: 'recorder' }))), true;
    }
    if (m.type === 'recorder/statistics_during_period') return reply(statistics(m)), true;
    return false;
  }

  /** POST /octopus: { on, tariff, homeMini, gas, ev, dashboard, tomorrow, dispatchNow } */
  function control(body) {
    for (const k of ['on', 'homeMini', 'gas', 'ev', 'dashboard']) if (typeof body[k] === 'boolean') o[k] = body[k];
    if (body.tariff) o.tariff = body.tariff;
    if ('tomorrow' in body) o.tomorrow = body.tomorrow;
    if (body.on || body.replan) planDispatches();
    // Octopus moves the car's next charge to now (the night's stays)
    if (body.dispatchNow) { const n = Math.floor(Date.now() / SLOT) * SLOT; o.dispatches = [{ start: n, end: n + 3 * SLOT, source: 'smart-charge' }, ...o.dispatches.filter((d) => d.end - d.start > 2 * H)]; }
    if (body.noDispatch) o.dispatches = [];
    refresh();
    return { ...o, ids: { rate: `sensor.${E}_current_rate`, cost: ELEC_COST, ev: `binary_sensor.${I}_dispatching`, bump: `switch.${I}_bump_charge` } };
  }

  /** A switch the integration owns (bump charge) changed: the state follows. */
  function afterCall() { setTimeout(() => refresh(), 300); }

  setInterval(() => { if (o.on) refresh(); }, 30000);
  return { refresh, handle, control, afterCall, state: o };
}
