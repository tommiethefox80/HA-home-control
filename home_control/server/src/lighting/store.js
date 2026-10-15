// JSON persistence in /data with atomic writes and debounced saves.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SETTINGS = {
  sunEntity: 'auto',            // 'auto' or an entity id
  graceSeconds: 20,             // don't resend or judge a device for this long after a command
  detectManual: true,           // treat outside changes as a hold until the next scheduled change
  defaultTransition: 2,         // seconds
  awayOffTime: '23:00',         // when lived-in groups switch off in Away
  awayBrightness: 70,
  dashboardPath: '/',
  stepSize: 10,                 // brightness step for the -/+ buttons
  autoAway: false,              // switch to Away when everyone has left, back when someone is home
  autoAwayPeople: 'auto',       // 'auto' (every person) or a list of person entity ids
  autoAwayDelay: 10,            // minutes everyone must be out before Away starts
  morningTime: '05:00',         // "until the morning" holds end at the first scheduled change after this
};

function defaults() {
  return {
    version: 1,
    mode: 'schedule',               // 'schedule' | 'away' | 'off'
    groups: [],                     // [{ id, name, devices: [entity_id], motion, lux, livedIn, onBrightness, season }]
    scenes: [],                     // [{ id, name, until: 'next'|'morning', groups: { [groupId]: { action, brightness, kelvin, minutes } } }]
    schedules: {},                  // { [groupId]: week }
    overrides: {},                  // { [groupId]: override }
    settings: { ...DEFAULT_SETTINGS },
    targets: {},                    // { [groupId]: [{ at, level }] } the app's own targets for the chart
    activity: [],                   // ring buffer of { at, text, group? }
  };
}

export class Store {
  constructor(dir, log = console) {
    this.dir = dir;
    this.file = join(dir, 'lighting.json');
    this.log = log;
    this.timer = null;
    this.data = defaults();
    this.load();
  }

  load() {
    try {
      mkdirSync(this.dir, { recursive: true });
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        const base = defaults();
        this.data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
      }
    } catch (err) {
      this.log.error?.(`Couldn't read saved data, starting fresh: ${err.message}`);
      try { renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch { /* ignore */ }
      this.data = defaults();
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
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error?.(`Couldn't save data: ${err.message}`);
    }
  }
}
