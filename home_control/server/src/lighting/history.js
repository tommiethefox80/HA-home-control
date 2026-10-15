// "Last 24 hours" data for one group, built from Home Assistant history.
import { stateAt } from './schedule.js';

const BUCKET_MS = 5 * 60000;
const SPAN_MS = 24 * 3600000;
const CACHE_MS = 60000;

export class History {
  constructor({ ha, engine }) {
    this.ha = ha;
    this.engine = engine;
    this.cache = new Map();
  }

  async forGroup(groupId) {
    const hit = this.cache.get(groupId);
    const now = this.engine.now();
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = await this._build(groupId, now);
    this.cache.set(groupId, { at: now, value });
    return value;
  }

  async _build(groupId, now) {
    const g = this.engine.data.groups.find((x) => x.id === groupId);
    if (!g) throw Object.assign(new Error('That group no longer exists'), { status: 404 });
    const end = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const start = end - SPAN_MS;
    const ids = [...g.devices];
    if (g.motion?.entity) ids.push(g.motion.entity);
    let raw = {};
    if (ids.length) {
      raw = await this.ha.history(new Date(start).toISOString(), new Date(now).toISOString(), ids) || {};
    }

    // Expand compressed rows {s, a, lu}; attributes may only appear on some rows, so carry them forward.
    const series = {};
    for (const id of ids) {
      let attrs = {};
      series[id] = (raw[id] || []).map((r) => {
        if (r.a) attrs = { ...attrs, ...r.a };
        const t = r.lu != null ? r.lu * 1000 : Date.parse(r.last_updated || r.last_changed);
        return { t, s: r.s ?? r.state, a: attrs };
      }).filter((r) => Number.isFinite(r.t)).sort((x, y) => x.t - y.t);
    }

    const levelAt = (rows, t, dimmable) => {
      let row = null;
      for (const r of rows) { if (r.t <= t) row = r; else break; }
      if (!row || row.s === 'unavailable' || row.s === 'unknown') return null;
      if (row.s !== 'on') return 0;
      if (!dimmable) return 100;
      return row.a.brightness != null ? Math.round((row.a.brightness / 255) * 100) : 100;
    };

    const infos = g.devices.map((id) => this.engine.deviceInfo(id, g.name));
    const targets = this.engine.data.targets[g.id] || [];
    const sched = this.engine.data.schedules[g.id];
    const ctx = this.engine.ctx();

    const points = [];
    for (let t = start; t <= end; t += BUCKET_MS) {
      const vals = infos.map((i) => levelAt(series[i.id] || [], t, i.dimmable)).filter((v) => v != null);
      const actual = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
      let target;
      const rec = [...targets].reverse().find((x) => x.at <= t);
      if (rec) target = rec.level;
      else {
        const st = stateAt(sched, t, ctx);
        target = st ? (st.point.on ? st.point.brightness ?? 100 : 0) : null;
      }
      points.push({ t, actual, target });
    }

    const bands = [];
    if (g.motion?.entity) {
      let open = null;
      for (const r of series[g.motion.entity] || []) {
        if (r.s === 'on' && open == null) open = Math.max(r.t, start);
        else if (r.s !== 'on' && open != null) { bands.push({ from: open, to: r.t }); open = null; }
      }
      if (open != null) bands.push({ from: open, to: now });
    }

    return { start, end, points, bands, hasMotion: !!g.motion?.entity, motionName: g.motion ? this.engine.friendly(g.motion.entity) : null };
  }
}
