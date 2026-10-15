// JSON persistence in the add-on's /data folder (survives restarts and updates,
// and is included in HA backups).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULTS = () => ({
  version: 1,
  settings: {
    boiler: {
      entity: '',          // e.g. climate.heating (Hive) or a switch.*
      onTemp: 30,          // Hive thermostat setpoint used to force the boiler on
      offTemp: 7,          // setpoint used to let it go off (keeps frost protection)
      minOnMinutes: 5,
      minOffMinutes: 3,
    },
    hysteresis: 0.3,       // room must fall this far below target before calling
    stopEarly: 0,          // stop calling this far below target (let radiators coast up)
    frostTemp: 7,
    awayTemp: 12,
    houseBoostTemp: 22,         // Boost button: default temperature
    houseBoostMinutes: 30,      // Boost button: default length
    respectManualChanges: true, // a knob turned on a TRV holds until the next schedule change
    takeOverTrvMode: true,      // put TRVs into manual 'heat' mode so their own schedules don't fight
    commandGraceSeconds: 180,   // Hive is cloud-polled; wait this long before re-sending a command
    dashboardPath: '/',         // where the Dashboard button in the header goes
    costEntity: '',             // gas cost-today sensor; empty = find one automatically
    outsideEntity: '',          // weather.* or temperature sensor; empty = find one automatically
    notify: {                   // phone alerts, sent with HA's notify services
      on: { enabled: false, service: '' },
      off: { enabled: false, service: '' },
      window: { enabled: false, service: '' },
    },
    retention: { activityDays: 30, detailDays: 7, dailyDays: 400 },     // how long the add-on keeps its own history
    cards: { spark: true, fires: true },                                 // room cards: today's mini graph, times fired today
    preheat: { enabled: true, maxMinutes: 120 },                         // warm by the scheduled time
    window: { enabled: true, drop: 1, minutes: 10, pauseMinutes: 20 },   // open window detection
    presence: { enabled: false, people: [], delayMinutes: 15, nearMiles: 2 }, // away automatically
  },
  zones: [],
  runtime: {
    mode: 'auto',          // auto | away | off
    awayUntil: null,
    overrides: {},         // zoneId -> { temp, until, kind, by, group?, prev? }
    houseBoost: null,      // { temp, until, zones, started } while a house boost runs
    boiler: { on: false, lastSwitch: 0 },
  },
});

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'heating.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = DEFAULTS();
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const d = DEFAULTS();
      this.data = {
        ...d, ...loaded,
        settings: { ...d.settings, ...loaded.settings, boiler: { ...d.settings.boiler, ...loaded.settings?.boiler } },
        runtime: { ...d.runtime, ...loaded.runtime },
      };
    } catch { /* first run */ }
    this.timer = null;

    // The Activity log lives in its own file, written a few seconds after a change, so keeping
    // weeks of it doesn't make every settings save rewrite a big file. Older versions kept it
    // inside heating.json; it's moved across on first start.
    this.logFile = path.join(dir, 'activity.json');
    this.logTimer = null;
    let entries = null;
    try { entries = JSON.parse(fs.readFileSync(this.logFile, 'utf8')).entries; } catch { /* none yet */ }
    const migrating = !Array.isArray(entries);
    this.log = migrating ? (Array.isArray(this.data.log) ? this.data.log : []) : entries;
    delete this.data.log;
    if (migrating && this.log.length) { this.flushLog(); this.flush(); }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  addLog(msg) {
    this.log.unshift({ at: Date.now(), msg });
    this.pruneLog();
    clearTimeout(this.logTimer);
    this.logTimer = setTimeout(() => this.flushLog(), 3000);
  }

  // newest first; drop entries older than Settings → History allows (and never more than 50,000)
  pruneLog(now = Date.now()) {
    const cutoff = now - (this.data.settings.retention?.activityDays ?? 30) * 86400000;
    let n = this.log.length;
    while (n && this.log[n - 1].at < cutoff) n--;
    this.log.length = Math.min(n, 50000);
  }

  logBefore(before, limit = 100) {
    const i = this.log.findIndex((e) => e.at < before);
    return i < 0 ? [] : this.log.slice(i, i + limit);
  }

  flushLog() {
    clearTimeout(this.logTimer);
    try {
      const tmp = `${this.logFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.log }));
      fs.renameSync(tmp, this.logFile);
    } catch { /* ignore */ }
  }

  newId() { return randomUUID().slice(0, 8); }
}
