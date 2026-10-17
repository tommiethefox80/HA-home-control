// Following renames in Home Assistant.
//
// A new name (friendly name) is read live, so it shows straight away. A new entity ID is harder:
// everything here refers to devices by entity ID, and when that changes the old one simply stops
// existing. So for every entity ID something here uses, its permanent registry ID is kept (and,
// in case the integration was removed and added again, its integration and unique ID), with the
// last name it was seen with. Then:
//   - when Home Assistant says an entity ID changed (while connected), it's followed at once;
//   - when Home Control starts, reconnects or the registry changes, each entity ID in use is looked
//     up: if its permanent ID now belongs to another entity ID, that's followed too. This catches a
//     rename made while Home Control was off or updating.
//   - a device that's gone for good shows the last name it had, rather than a bare entity ID.
import fs from 'node:fs';
import path from 'node:path';

export class EntityMemory {
  constructor(dataDir = null) {
    this.file = dataDir ? path.join(dataDir, 'entity-ids.json') : null;
    this.known = {}; // entity_id -> { rid, uid, name }
    if (this.file) {
      try { this.known = JSON.parse(fs.readFileSync(this.file, 'utf8')).known || {}; } catch { /* none yet */ }
    }
  }

  /** The last name an entity was seen with (null if never seen). */
  lastName(id) { return this.known[id]?.name || null; }

  /**
   * From the entity IDs in use and the registry: which have moved to a new entity ID ([{ from, to }]).
   * Remembers each one that's there, and forgets ones no longer in use.
   */
  reconcile(used, registry, names = new Map()) {
    const moves = [];
    if (!Array.isArray(registry)) return moves; // registry not readable: change nothing
    const byId = new Map(registry.map((e) => [e.entity_id, e]));
    const byRid = new Map(registry.filter((e) => e.id).map((e) => [e.id, e]));
    const uidOf = (e) => (e.platform && e.unique_id != null ? `${e.platform}:${e.unique_id}` : null);
    const byUid = new Map(registry.filter(uidOf).map((e) => [uidOf(e), e]));
    const usedSet = new Set(used);
    for (const id of usedSet) {
      const rec = this.known[id];
      const here = byId.get(id);
      let moved = null;
      if (rec?.rid && byRid.has(rec.rid) && byRid.get(rec.rid).entity_id !== id) moved = byRid.get(rec.rid);
      else if (!here && rec?.uid && byUid.has(rec.uid)) moved = byUid.get(rec.uid);
      // the new ID mustn't be one that's in use for something else already
      if (moved && !usedSet.has(moved.entity_id)) {
        moves.push({ from: id, to: moved.entity_id });
        continue;
      }
      if (here) this.known[id] = { rid: here.id || null, uid: uidOf(here), name: names.get(id) || here.name || here.original_name || rec?.name || null };
      else if (!rec) this.known[id] = { rid: null, uid: null, name: null }; // not in Home Assistant: nothing to go on, but don't keep asking
    }
    for (const m of moves) {
      const e = byId.get(m.to);
      this.known[m.to] = { rid: e?.id || null, uid: e ? uidOf(e) : null, name: names.get(m.to) || e?.name || e?.original_name || this.known[m.from]?.name || null };
    }
    const keep = new Set([...usedSet, ...moves.map((m) => m.to)]);
    for (const m of moves) keep.delete(m.from);
    for (const id of Object.keys(this.known)) if (!keep.has(id)) delete this.known[id];
    this.save();
    return moves;
  }

  /** An entity ID changed while connected: it's the same registry entry, so its record moves with it. */
  moved(from, to) {
    if (!this.known[from]) return;
    this.known[to] = { ...this.known[from] };
    delete this.known[from];
    this.save();
  }

  /** Whether any of these entity IDs has no record yet. */
  missing(ids) { return ids.some((id) => !this.known[id]); }

  /** A name seen live (so a device that later disappears keeps it). */
  seen(id, name) {
    const rec = this.known[id];
    if (!rec || !name || rec.name === name) return;
    rec.name = name;
    this.saveSoon();
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 5000);
    this.timer.unref?.();
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ known: this.known }));
      fs.renameSync(tmp, this.file);
    } catch { /* tried again next time */ }
  }
}

/**
 * Watch for renames and pass them to each part (part.renameEntity(from, to) → true if it used it).
 * Each part says which entity IDs it uses (part.entityIds()), and is given lastName(id) to fall back on.
 */
export function watchRenames(client, parts, { dataDir = null, log = console } = {}) {
  const memory = new EntityMemory(dataDir);
  const lastName = (id) => memory.lastName(id);
  const live = () => {
    const list = parts().filter(Boolean);
    for (const p of list) if (!p.lastName) p.lastName = lastName;
    return list;
  };
  live();

  const move = (from, to) => {
    for (const part of live()) {
      try { part.renameEntity?.(from, to); } catch (err) { log.warn?.(`Following the rename of ${from} to ${to} failed: ${err.message}`); }
    }
  };

  // each entity's name, kept from the states Home Assistant sends anyway (read in full once per connection)
  const names = new Map();
  const inUse = () => [...new Set(live().flatMap((p) => { try { return p.entityIds?.() || []; } catch { return []; } }))].filter((id) => typeof id === 'string' && id.includes('.'));
  let busy = null; let again = false; let timer = null; let connected = false; let readable = true; let haveNames = false;
  const check = async () => {
    if (busy) { again = true; return busy; }
    busy = (async () => {
      try {
        const used = inUse();
        if (!used.length) return;
        if (!haveNames) {
          const states = await client.getStates().catch(() => null);
          if (states) { for (const s of states) if (s.attributes?.friendly_name) names.set(s.entity_id, s.attributes.friendly_name); haveNames = true; }
        }
        const entities = await client.send('config/entity_registry/list').catch(() => null);
        readable = Array.isArray(entities); // without admin rights the registry can't be read: nothing to go on
        if (!readable) return;
        for (const m of memory.reconcile(used, entities, names)) {
          log.info?.(`${m.from} is now ${m.to} in Home Assistant: following it`);
          move(m.from, m.to);
        }
      } catch (err) {
        log.warn?.(`Couldn't check for renamed entities: ${err.message}`);
      }
    })();
    await busy;
    busy = null;
    if (again) { again = false; soon(1000); }
  };
  const soon = (ms = 3000) => { clearTimeout(timer); timer = setTimeout(check, ms); timer.unref?.(); };

  client.on('ready', () => {
    connected = true; readable = true; haveNames = false;
    client.subscribeEvent('entity_registry_updated').catch(() => {});
    soon(5000); // once each part has read Home Assistant
  });
  client.on('disconnected', () => { connected = false; clearTimeout(timer); });
  client.on('event', (type, data) => {
    if (type !== 'entity_registry_updated') return;
    const from = data?.old_entity_id; const to = data?.entity_id;
    if (data?.action === 'update' && from && to && from !== to) { memory.moved(from, to); move(from, to); }
    soon(); // and look again: this also catches an integration removed and added back
  });
  client.on('state_changed', (data) => {
    const n = data?.new_state?.attributes?.friendly_name;
    if (!data?.entity_id) return;
    if (n) { names.set(data.entity_id, n); memory.seen(data.entity_id, n); }
  });
  // something newly in use (a light added to a group, a new room): note its permanent ID now
  const fresh = setInterval(() => { if (connected && readable && !busy && memory.missing(inUse())) soon(0); }, 15000); fresh.unref?.();
  // and now and then, in case an event was missed
  const t = setInterval(() => { if (connected) soon(0); }, 60 * 60000); t.unref?.();
  return { memory, check };
}
