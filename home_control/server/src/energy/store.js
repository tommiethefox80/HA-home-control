// Energy: the choices made here, the plans for running things at the cheapest times, and Activity
// (energy.json in /data). Prices, usage and the car are read live from Home Assistant.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SETTINGS = {
  meter: null,       // which Octopus electricity meter (serial_mpan), if there's more than one; null: the first
  gasMeter: null,
  bands: { mode: 'auto', cheap: 15, peak: 30 }, // 'auto' (from the day's prices) or 'fixed' (pence)
  alerts: {
    notify: [],      // phones (notify services)
    cheapBelow: null, // tell the phones when the price falls to this (pence) or below; null: don't
    tomorrow: false,  // tell the phones tomorrow's cheapest times when its prices come in
    plans: false,     // tell the phones when a plan switches something on
  },
  card: { chart: true, ev: true, plans: true },
};

function defaults() {
  return {
    version: 1,
    settings: structuredClone(DEFAULT_SETTINGS),
    plans: [],   // [{ id, name, entity, minutes, by, together, repeat, maxP, enabled, run, done }]
    told: {},    // what the phones have been told, so each is told once
    events: [],
  };
}

export class Store {
  constructor(dir, log = console) {
    this.file = join(dir, 'energy.json');
    this.log = log;
    this.timer = null;
    this.data = defaults();
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        const base = defaults();
        const s = raw.settings || {};
        this.data = {
          ...base, ...raw,
          settings: {
            ...base.settings, ...s,
            bands: { ...base.settings.bands, ...(s.bands || {}) },
            alerts: { ...base.settings.alerts, ...(s.alerts || {}) },
            card: { ...base.settings.card, ...(s.card || {}) },
          },
          plans: Array.isArray(raw.plans) ? raw.plans : [],
          told: raw.told || {},
          events: Array.isArray(raw.events) ? raw.events : [],
        };
      }
    } catch (err) {
      log.error?.(`Couldn't read the energy settings, starting fresh: ${err.message}`);
      try { renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* ignore */ }
    }
  }

  newId() { return Math.random().toString(36).slice(2, 10); }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 1));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) { this.log.error?.(`Couldn't save the energy settings: ${err.message}`); }
  }
}
