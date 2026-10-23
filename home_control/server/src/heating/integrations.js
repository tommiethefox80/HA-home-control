// Is the integration behind the heating's devices working in Home Assistant? Hive, say: when it
// fails to set up (as when Hive changed its login page in October 2026), needs signing in again,
// keeps retrying, is turned off, or is loaded but every one of its devices has gone unavailable,
// Home Control can't see or change the radiators or the boiler, and they stay as they were. This
// watches for that and says so: Needs attention (with a button to the integration in Home
// Assistant), a Home Assistant notification, and a phone alert if one's chosen; then again when
// it's working.
//
// Each device's integration comes from Home Assistant's entity registry (its config entry), and the
// entry's state and any sign-in-again flow from config_entries/get and config_entries/flow/progress.
const UNAVAILABLE = new Set(['unavailable', 'unknown']);
// minutes a problem must last before it's told: a failure or a sign-in is at once (two checks);
// retrying and "not loaded" happen briefly as Home Assistant starts; devices drop out for a while
export const GRACE = { failed: 1, signin: 1, disabled: 1, retrying: 10, not_loaded: 10, unavailable: 15 };
const FAILED = new Set(['setup_error', 'migration_error', 'failed_unload']);

const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

export class IntegrationWatch {
  /**
   * engine: the heating engine (ha, store, s, rt, zones, views); send(payload) to Home Assistant;
   * tell({ kind: 'broken'|'fixed', rec, text }) when one breaks or is working again.
   */
  constructor({ engine, now = () => Date.now(), scale = 1 }) {
    this.engine = engine;
    this.now = now;
    this.scale = scale;
    this.names = new Map(); // domain -> its name ("Hive")
    this.entries = null;    // the last config entries read (null: not allowed, or not read yet)
  }

  get rt() { return (this.engine.rt.integrations ||= {}); }
  // each device's name while it's there: a turned-off integration's devices go from Home Assistant
  get known() { return (this.engine.rt.deviceNames ||= {}); }

  /** Every device heating relies on: radiators, room thermometers and the boiler control. */
  devices() {
    const e = this.engine;
    const out = [];
    for (const z of e.zones.filter((x) => x.enabled)) {
      for (const id of z.trvs || []) out.push(id);
      if (z.sensor) out.push(z.sensor);
    }
    if (e.s.boiler?.entity) out.push(e.s.boiler.entity);
    return [...new Set(out)];
  }

  async #name(domain) {
    if (this.names.has(domain)) return this.names.get(domain);
    let name = null;
    try { name = (await this.engine.ha.send({ type: 'manifest/get', integration: domain }))?.name || null; } catch { /* older, or not allowed */ }
    name ||= domain.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    this.names.set(domain, name);
    return name;
  }

  /** Look now. Returns the problems found (whether or not they've lasted long enough to tell yet). */
  async check() {
    const e = this.engine;
    const ha = e.ha;
    if (!ha.connected) return [];
    let entries = null; let flows = [];
    try { entries = await ha.send({ type: 'config_entries/get' }); } catch { entries = null; }
    try { flows = (await ha.send({ type: 'config_entries/flow/progress' })) || []; } catch { flows = []; }
    this.entries = entries;
    const byEntry = new Map(Array.isArray(entries) ? entries.map((x) => [x.entry_id, x]) : []);

    // the devices, by the integration they belong to
    const groups = new Map();
    for (const id of this.devices()) {
      const nm = ha.get(id)?.attributes?.friendly_name;
      if (nm && this.known[id] !== nm) { this.known[id] = nm; this.engine.store.save(); }
      const reg = ha.entityInfo?.(id) || null;
      const entry = reg?.entry ? byEntry.get(reg.entry) || null : null;
      const domain = entry?.domain || reg?.platform || null;
      if (!domain) continue; // not in the registry: nothing to say which integration it is
      const key = entry?.entry_id || `platform:${domain}`;
      if (!groups.has(key)) groups.set(key, { key, domain, entry, ids: [] });
      groups.get(key).ids.push(id);
    }

    const now = this.now();
    const found = [];
    for (const g of groups.values()) {
      const en = g.entry;
      let kind = null; let reason = null;
      if (en) {
        if (flows.some((f) => f.handler === en.domain && f.context?.source === 'reauth' && (!f.context.entry_id || f.context.entry_id === en.entry_id))) kind = 'signin';
        else if (FAILED.has(en.state)) { kind = 'failed'; reason = en.reason || null; }
        else if (en.state === 'setup_retry') { kind = 'retrying'; reason = en.reason || null; }
        else if (en.state === 'not_loaded') kind = en.disabled_by ? 'disabled' : 'not_loaded';
      }
      const off = g.ids.filter((id) => { const st = ha.get(id); return !st || UNAVAILABLE.has(st.state); });
      if (!kind && off.length === g.ids.length && (!en || en.state === 'loaded')) kind = 'unavailable';
      if (kind) found.push({ ...g, kind, reason, name: await this.#name(g.domain) });
    }

    // remember when each started; tell once it's lasted long enough, and again when it's over
    const seen = new Set();
    for (const f of found) {
      seen.add(f.key);
      let rec = this.rt[f.key];
      if (!rec) rec = this.rt[f.key] = { since: now, alerted: false };
      Object.assign(rec, { kind: f.kind, reason: f.reason, domain: f.domain, name: f.name, title: f.entry?.title || null, ids: f.ids });
      if (!rec.alerted && now - rec.since >= GRACE[f.kind] * 60000 * this.scale) {
        rec.alerted = true;
        rec.alertedAt = now;
        this.engine.store.save();
        this.engine.integrationAlert?.({ kind: 'broken', rec, text: this.text(rec) });
      }
    }
    for (const [key, rec] of Object.entries(this.rt)) {
      if (seen.has(key)) continue;
      delete this.rt[key];
      this.engine.store.save();
      if (rec.alerted) this.engine.integrationAlert?.({ kind: 'fixed', rec, text: this.fixedText(rec) });
    }
    return found;
  }

  /** The problems that have lasted long enough to tell (for Needs attention). */
  problems() {
    return Object.entries(this.rt).filter(([, r]) => r.alerted).map(([key, r]) => ({ key, ...r, text: this.text(r) }));
  }

  /** Is this device in an integration that isn't working (so its own "offline" notice is noise)? */
  covers(entityId) {
    return Object.values(this.rt).some((r) => r.alerted && (r.ids || []).includes(entityId));
  }

  #devicesText(rec) {
    const e = this.engine;
    const names = (rec.ids || []).filter((id) => id !== e.s.boiler?.entity && !id.startsWith('sensor.'))
      .map((id) => e.ha.get(id)?.attributes?.friendly_name || this.known[id] || id);
    const boiler = (rec.ids || []).includes(e.s.boiler?.entity);
    const parts = [...(names.length > 3 ? [`${names.length} radiators`] : names), ...(boiler ? ['the boiler'] : [])];
    return parts.length ? list(parts) : 'its devices';
  }

  #since(rec) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.engine.ha.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(rec.since));
  }

  /** What's wrong, what it means and what to do, in a sentence or three. */
  text(rec) {
    const n = rec.name;
    const what = this.#devicesText(rec);
    const meanwhile = rec.domain === 'hive'
      ? ` Until then they stay as they were: in the Hive app, put the thermostat and radiators back on Schedule so Hive heats the house meanwhile.`
      : ' Until then they stay as they were.';
    const where = `Settings → Devices & services → ${n}`;
    switch (rec.kind) {
      case 'signin':
        return `${n} needs signing in again in Home Assistant (${where}), so Home Control can't change ${what}.${meanwhile}`;
      case 'failed':
        return `${n} isn't working in Home Assistant: it failed to set up${rec.reason ? ` (${rec.reason})` : ''}, since ${this.#since(rec)}. Home Control can't change ${what} until it's fixed: try Reload on ${n} (${where}), and look at its log for why.${meanwhile}`;
      case 'retrying':
        return `${n} can't connect in Home Assistant and has been retrying since ${this.#since(rec)}${rec.reason ? ` (${rec.reason})` : ''}. ${n}'s servers or the internet may be down. Home Control can't change ${what} until it's back.${meanwhile}`;
      case 'disabled':
        return `${n} is turned off in Home Assistant, so Home Control can't change ${what}. Turn it back on in ${where}.`;
      case 'not_loaded':
        return `${n} isn't running in Home Assistant (since ${this.#since(rec)}), so Home Control can't change ${what}. Try Reload in ${where}.`;
      default:
        return `Every ${n} device Home Control uses has been unavailable in Home Assistant since ${this.#since(rec)} (${what}). ${n}'s servers or its hub may be down${rec.domain === 'hive' ? ': check the Hive app' : ''}.${meanwhile}`;
    }
  }

  fixedText(rec) {
    return `${rec.name} is working again in Home Assistant, so Home Control is looking after ${this.#devicesText(rec)} again.`;
  }
}
