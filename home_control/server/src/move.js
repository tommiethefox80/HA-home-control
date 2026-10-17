// Moving in from another Home Control (the copy installed by hand as a local app).
//
// Home Assistant can't hand one app another app's files, but it can back an app up, and this app
// can read the backup folder. So the page in Home Assistant asks for a backup of the old app, then
// asks this app to read that backup and stage the old app's data. The page then stops the old app
// and restarts this one; on the way up, the staged files are put in place before anything loads
// them, so this app starts exactly where the old one stopped: rooms, schedules, groups, scenes,
// settings, Activity and history.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// everything Home Control keeps in its data folder
export const DATA_FILES = ['heating.json', 'activity.json', 'daily.json', 'targets.json', 'calls.json', 'predictions.json', 'heatloss.json', 'lighting.json', 'house.json', 'cameras.json', 'wifi.json', 'energy.json', 'entity-ids.json'];
const STAGE = 'move-in';
const MAX_INNER = 512 * 1024 * 1024;

// ---------- reading tar files (Home Assistant backups are plain tars with a .tar.gz per app) ----------

const str = (buf, from, len) => { const s = buf.subarray(from, from + len); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
function octal(buf, from, len) {
  if (buf[from] & 0x80) { // base-256, for very large sizes
    let n = 0;
    for (let i = from + 1; i < from + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = str(buf, from, len).trim();
  return s ? parseInt(s, 8) : 0;
}
function paxRecords(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString('utf8'), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}
const clean = (name) => name.replace(/^(\.\/)+/, '').replace(/^\/+/, '');

/**
 * Walks a tar. read(pos, len) returns a Buffer. visit({ name, type, size, offset }) may return
 * 'stop' to end early. Long names (pax and GNU) are handled.
 */
export function walkTar(read, total, visit) {
  let pos = 0;
  let longName = null;
  let pax = null;
  while (pos + 512 <= total) {
    const h = read(pos, 512);
    if (h.length < 512 || h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const dataAt = pos + 512;
    const next = dataAt + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const rec = paxRecords(read(dataAt, size));
      if (type === 'x') pax = rec;
    } else if (type === 'L') {
      longName = str(read(dataAt, size), 0, size);
    } else if (type === 'K') {
      // long link name: not needed
    } else {
      const prefix = str(h, 345, 155);
      let name = str(h, 0, 100);
      if (prefix && str(h, 257, 5) === 'ustar') name = `${prefix}/${name}`;
      if (longName) name = longName;
      if (pax?.path) name = pax.path;
      const realSize = pax?.size ? Number(pax.size) : size;
      longName = null; pax = null;
      if (visit({ name: clean(name), type, size: realSize, offset: dataAt }) === 'stop') return;
      pos = dataAt + Math.ceil(realSize / 512) * 512;
      continue;
    }
    pos = next;
  }
}

function fileReader(file) {
  const fd = fs.openSync(file, 'r');
  const total = fs.fstatSync(fd).size;
  const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); };
  return { read, total, close: () => fs.closeSync(fd) };
}
const bufferReader = (buf) => ({ read: (pos, len) => buf.subarray(pos, pos + len), total: buf.length, close() {} });

/** backup.json from a backup file, or null if it isn't one. */
export function backupInfo(file) {
  let r;
  try { r = fileReader(file); } catch { return null; }
  let info = null;
  try {
    walkTar(r.read, r.total, (e) => {
      if (e.name === 'backup.json') { try { info = JSON.parse(r.read(e.offset, e.size).toString('utf8')); } catch { /* not ours */ } return 'stop'; }
      return undefined;
    });
  } catch { info = null; } finally { r.close(); }
  return info;
}

/** The backup file with this slug: /backup/<slug>.tar, or whichever recent backup says so. */
export function findBackup(dir, slug) {
  const direct = path.join(dir, `${slug}.tar`);
  if (fs.existsSync(direct) && backupInfo(direct)?.slug === slug) return direct;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.tar')).map((f) => path.join(dir, f))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 30).map((x) => x.f);
  } catch { return null; }
  return files.find((f) => backupInfo(f)?.slug === slug) || null;
}

/** The data files of one app in a backup: { files: { name: Buffer }, info, app }. */
export function readAppFromBackup(file, appSlug) {
  const info = backupInfo(file);
  if (!info) throw new Error('That backup couldn\'t be read');
  if (info.protected) throw new Error('That backup has a password, so it can\'t be read here');
  const app = (info.addons || info.apps || []).find((a) => a.slug === appSlug);
  if (!app) throw new Error(`That backup doesn't include ${appSlug}`);
  const r = fileReader(file);
  let inner = null;
  try {
    walkTar(r.read, r.total, (e) => {
      if (e.name === `${appSlug}.tar.gz` || e.name === `${appSlug}.tar`) {
        if (e.size > MAX_INNER) throw new Error('The app\'s part of the backup is too big');
        inner = r.read(e.offset, e.size);
        return 'stop';
      }
      return undefined;
    });
  } finally { r.close(); }
  if (!inner) throw new Error(`Couldn't find ${appSlug} inside the backup`);
  if (inner[0] === 0x1f && inner[1] === 0x8b) inner = zlib.gunzipSync(inner);
  const files = {};
  const b = bufferReader(inner);
  walkTar(b.read, b.total, (e) => {
    if (!['0', '\0', '7'].includes(e.type)) return;
    const m = e.name.match(/^data\/([^/]+)$/);
    if (m && DATA_FILES.includes(m[1])) files[m[1]] = Buffer.from(b.read(e.offset, e.size));
  });
  return { files, info, app };
}

// ---------- staging, and putting the staged files in place at start-up ----------

function summarise(files) {
  const parse = (n) => { try { return files[n] ? JSON.parse(files[n].toString('utf8')) : null; } catch { throw new Error(`${n} in the backup is damaged`); } };
  const heat = parse('heating.json');
  const light = parse('lighting.json');
  const act = parse('activity.json');
  for (const n of Object.keys(files)) parse(n); // every file must be readable
  if (!heat && !light) throw new Error('The backup has no heating or lighting in it');
  return {
    rooms: heat?.zones?.length || 0,
    boiler: !!heat?.settings?.boiler?.entity,
    groups: light?.groups?.length || 0,
    scenes: light?.scenes?.length || 0,
    activity: (act?.entries?.length || 0) + (light?.activity?.length || 0),
  };
}

export function stageMove(dataDir, { files, from, fromVersion, backup, backupName }) {
  const summary = summarise(files);
  const dir = path.join(dataDir, STAGE);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
  const meta = { from, fromVersion, backup, backupName, files: Object.keys(files), summary, stagedAt: Date.now() };
  fs.writeFileSync(path.join(dir, 'ready.json.tmp'), JSON.stringify(meta));
  fs.renameSync(path.join(dir, 'ready.json.tmp'), path.join(dir, 'ready.json')); // last: the files are complete
  return meta;
}

export function cancelStaged(dataDir) {
  fs.rmSync(path.join(dataDir, STAGE), { recursive: true, force: true });
}
export function isStaged(dataDir) {
  return fs.existsSync(path.join(dataDir, STAGE, 'ready.json'));
}

/** Called before anything loads the data folder. Returns the move record if one was applied. */
export function applyStagedMove(dataDir, log) {
  const dir = path.join(dataDir, STAGE);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8')); } catch {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); // half-staged: never use it
    return null;
  }
  for (const name of DATA_FILES) {
    const target = path.join(dataDir, name);
    if (meta.files.includes(name)) fs.renameSync(path.join(dir, name), target);
    else fs.rmSync(target, { force: true }); // this app's own (empty) start, not the old app's
  }
  const record = { ...meta, movedAt: Date.now(), links: null, dismissed: false };
  fs.writeFileSync(path.join(dataDir, 'moved.json'), JSON.stringify(record, null, 1));
  fs.rmSync(dir, { recursive: true, force: true });
  log.info?.(`Moved in from ${meta.from}${meta.fromVersion ? ` ${meta.fromVersion}` : ''}: ${meta.summary.rooms} rooms, ${meta.summary.groups} lighting groups, ${meta.summary.scenes} scenes`);
  return record;
}

// ---------- the page's requests ----------

export function createMove({ dataDir, backupDir, log, isEmpty, panel, slug, card }) {
  const movedFile = path.join(dataDir, 'moved.json');
  const readMoved = () => { try { return JSON.parse(fs.readFileSync(movedFile, 'utf8')); } catch { return null; } };
  const writeMoved = (m) => fs.writeFileSync(movedFile, JSON.stringify(m, null, 1));

  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Bad request')); } });
    req.on('error', reject);
  });

  function status() {
    return { empty: isEmpty(), staged: isStaged(dataDir), moved: readMoved(), panel: panel(), slug: slug(), card: card?.status ?? null };
  }

  async function handle(req, res, p) {
    if (!p.startsWith('/api/move') && p !== '/api/card') return false;
    try {
      if (p === '/api/card' && req.method === 'GET') return send(res, 200, card?.status ?? null), true;
      if (p === '/api/move' && req.method === 'GET') return send(res, 200, status()), true;
      if (p === '/api/move' && req.method === 'POST') {
        const body = await readBody(req);
        const from = String(body.from || '');
        const backup = String(body.backup || '');
        if (!/^[\w-]+$/.test(from) || !/^[\w-]+$/.test(backup)) return send(res, 400, { error: 'Which app and which backup?' }), true;
        if (!isEmpty()) return send(res, 409, { error: 'This app already has rooms or lights set up, so nothing was brought across.' }), true;
        const file = findBackup(backupDir, backup);
        if (!file) return send(res, 404, { error: 'The backup of the old app isn\'t in the backup folder. If your backups are kept on a network drive, set "Backup location" back to this device for a moment.' }), true;
        const got = readAppFromBackup(file, from);
        const meta = stageMove(dataDir, { files: got.files, from, fromVersion: got.app.version, backup, backupName: got.info.name });
        log.info?.(`Ready to move in from ${from} ${got.app.version || ''}: ${meta.files.join(', ')}`);
        return send(res, 200, { ok: true, ...meta }), true;
      }
      if (p === '/api/move' && req.method === 'DELETE') { cancelStaged(dataDir); return send(res, 200, { ok: true }), true; }
      if (p === '/api/move/links' && req.method === 'POST') {
        const body = await readBody(req);
        const m = readMoved();
        if (m) writeMoved({ ...m, links: { changed: Number(body.changed) || 0, dashboards: (body.dashboards || []).map(String).slice(0, 50), skipped: (body.skipped || []).map(String).slice(0, 50), at: Date.now() } });
        return send(res, 200, { ok: true }), true;
      }
      if (p === '/api/move/dismiss' && req.method === 'POST') {
        const m = readMoved();
        if (m) writeMoved({ ...m, dismissed: true });
        return send(res, 200, { ok: true }), true;
      }
      return send(res, 404, { error: 'Unknown request' }), true;
    } catch (err) {
      log.warn?.(`Moving in: ${err.message}`);
      return send(res, 400, { error: err.message }), true;
    }
  }

  return { handle, status, readMoved };
}
