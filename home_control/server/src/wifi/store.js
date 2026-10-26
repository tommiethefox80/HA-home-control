// Wi-Fi: the schedules and choices made here, and Activity (wifi.json in /data).
// Everything else (access points, networks, who's connected) is read live from Home Assistant.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A schedule: nothing, off between two times (back on after), or on only between two times.
export const MODES = ['none', 'off_between', 'on_between'];
export const NO_SCHEDULE = { mode: 'none', from: '22:00', to: '07:00' };

const DEFAULT_SETTINGS = {
  leds: { mode: 'none', from: '22:00', to: '07:00', devices: null }, // devices: null = every one with a light
  // the devices connected, listed on each access point and network in the app, and on the dashboard card
  clients: { aps: true, networks: true, card: false },
};

function defaults() {
  return {
    version: 1,
    settings: structuredClone(DEFAULT_SETTINGS),
    networks: {},  // network id -> { schedule, away }
    devices: {},   // device MAC -> { kind, poe, schedule, away }
    ports: {},     // PoE port entity -> { away, label }: other ports switched off while away
    away: { on: false, since: null, off: {} }, // what Away switched off, to put back afterwards
    awayPending: {}, // put back after Away, but unavailable then: done when it's back
    applied: {},   // schedule key -> the scheduled change last made, so each is made once
    events: [],
  };
}

export class Store {
  constructor(dir, log = console) {
    this.file = join(dir, 'wifi.json');
    this.log = log;
    this.timer = null;
    this.data = defaults();
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        const base = defaults();
        this.data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}), leds: { ...base.settings.leds, ...(raw.settings?.leds || {}) },
          clients: { ...base.settings.clients, ...(raw.settings?.clients || {}) } } };
      }
    } catch (err) {
      log.error?.(`Couldn't read the Wi-Fi settings, starting fresh: ${err.message}`);
      try { renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* ignore */ }
    }
  }

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
    } catch (err) { this.log.error?.(`Couldn't save the Wi-Fi settings: ${err.message}`); }
  }
}
