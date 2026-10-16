// Give the running app the week it would have recorded alongside the mock's simulated week:
// when each room called for heat (calls.json) and the daily log (daily.json), then restart it.
// Run after seeding: sh dev/run.sh && node dev/seed.js && node dev/week.js
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DATA = path.join(HERE, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sim = await (await fetch('http://localhost:8124/sim-log')).json();
const heating = JSON.parse(fs.readFileSync(path.join(DATA, 'heating.json'), 'utf8'));
const idOf = Object.fromEntries(heating.zones.map((z) => [z.name, z.id]));

// stop the app, so it doesn't write its own logs over these
const pidFile = path.join(HERE, 'logs', 'server.pid');
try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* not running */ }
await sleep(1500);

const zones = {};
for (const [name, list] of Object.entries(sim.calls)) if (idOf[name]) zones[idOf[name]] = list.map(([a, b]) => [a, b, 'schedule', null]);
const started = Math.min(...Object.values(sim.calls).flat().map(([a]) => a));
fs.writeFileSync(path.join(DATA, 'calls.json'), JSON.stringify({ zones, seen: Date.now(), started }));
const days = {};
for (const [k, d] of Object.entries(sim.days)) {
  days[k] = { boilerMin: d.boilerMin, outSum: d.outSum, outN: d.outN, rooms: Object.fromEntries(Object.entries(d.rooms).filter(([n]) => idOf[n]).map(([n, r]) => [idOf[n], r])) };
}
fs.writeFileSync(path.join(DATA, 'daily.json'), JSON.stringify({ days }));
// and how fast each room warms up, as the app would have learned it
heating.runtime ||= {};
heating.runtime.warm = { ...(heating.runtime.warm || {}), ...Object.fromEntries(Object.entries(sim.warm || {}).filter(([n]) => idOf[n]).map(([n, w]) => [idOf[n], w])) };
fs.writeFileSync(path.join(DATA, 'heating.json'), JSON.stringify(heating, null, 2));

// start it again, as dev/run.sh does
const media = path.join(DATA, 'media');
const log = fs.openSync(path.join(HERE, 'logs', 'server.log'), 'a');
const app = spawn('node', [path.join(HERE, '../server/src/index.js')], {
  cwd: path.join(HERE, '..'), detached: true, stdio: ['ignore', log, log],
  env: { ...process.env, MEDIA_DIR: media, HA_MEDIA_DIR: media, HA_URL: 'http://localhost:8123', HA_TOKEN: 'dev', DATA_DIR: 'dev/data', PORT: '8099' },
});
fs.writeFileSync(pidFile, String(app.pid));
app.unref();
for (let i = 0; i < 40; i++) { try { await fetch('http://localhost:8099/api/house'); break; } catch { await sleep(250); } }
await sleep(1500);
console.log(`a week given to the app: ${Object.values(zones).map((l) => l.length).join(' and ')} heat-ups, ${Object.keys(days).length} days`);
