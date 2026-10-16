// Cameras: what's been added, how each one alerts and records, and its Activity (cameras.json in /data).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const WHEN = ['always', 'away', 'times', 'away_or_times', 'never'];

export const DEFAULT_SETTINGS = {
  notify: [],              // phones (notify services) told about movement and cameras going offline
  picture: true,           // attach a picture from the camera to movement alerts
  offlineMinutes: 5,       // tell the phones when a camera has been offline this long (0: don't)
  keepDays: 14,            // recordings and pictures older than this are deleted
};

export function defaultCamera(entity, name) {
  return {
    id: null,
    entity,
    name,
    movement: null,                                            // sensor ids that count; null: every movement sensor on the camera
    alerts: { on: true, when: 'away', from: '23:00', to: '06:30', cooldownMinutes: 2 },
    record: { when: 'always', from: '23:00', to: '06:30', seconds: 30 },
    offline: true,                                             // alert when it goes offline
    card: [],                                                  // controls shown on the dashboard card
  };
}

function defaults() {
  return { version: 1, cameras: [], settings: { ...DEFAULT_SETTINGS }, events: [] };
}

export class Store {
  constructor(dir, log = console) {
    this.dir = dir;
    this.file = join(dir, 'cameras.json');
    this.log = log;
    this.timer = null;
    this.data = defaults();
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        const base = defaults();
        this.data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
      }
    } catch (err) {
      log.error?.(`Couldn't read the camera settings, starting fresh: ${err.message}`);
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
    } catch (err) { this.log.error?.(`Couldn't save the camera settings: ${err.message}`); }
  }
}
