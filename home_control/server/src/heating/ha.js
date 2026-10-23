// The heating engine's view of Home Assistant, on top of the app's one shared connection.
// It keeps exactly the interface the heating engine was written against (states, get, send,
// callService, 'state' and 'status' events, child-lock and companion lookups), so the heating
// logic itself is unchanged. Reconnecting is handled by the shared connection.
import { EventEmitter } from 'node:events';

export class HaClient extends EventEmitter {
  constructor({ client, log }) {
    super();
    this.client = client;
    this.log = log || console.log;
    this.states = new Map();
    this.config = null;
    this.connected = false;
    this.registry = null;
    client.on('ready', () => this.#onReady().catch((e) => this.log(`HA init failed: ${e.message}`)));
    client.on('disconnected', () => {
      if (this.connected) this.log('Lost connection to Home Assistant');
      this.connected = false;
      this.emit('status', false);
    });
    client.on('state_changed', (data) => {
      const { entity_id, new_state, old_state } = data || {};
      if (!entity_id) return;
      if (new_state) this.states.set(entity_id, new_state);
      else this.states.delete(entity_id);
      this.emit('state', entity_id, new_state, old_state);
    });
    // other Home Assistant events (a button pressed on a phone alert)
    client.on('event', (type, data, context) => this.emit('event', type, data, context));
  }

  start() { this.client.start(); }

  async #onReady() {
    this.config = await this.client.getConfig();
    const states = await this.client.getStates();
    this.states = new Map(states.map((s) => [s.entity_id, s]));
    await this.client.subscribeStateChanged();
    // buttons on phone alerts (the Home Assistant app's actionable notifications)
    await this.client.subscribeEvent('mobile_app_notification_action').catch(() => {});
    this.connected = true;
    this.refreshRegistry();
    clearInterval(this.regTimer);
    this.regTimer = setInterval(() => this.refreshRegistry(), 10 * 60000);
    this.log(`Heating connected to Home Assistant ${this.config.version || ''} (${states.length} entities)`);
    this.emit('status', true);
  }

  // entity -> device mapping, used to find a TRV's child-lock entity; and each entity's integration
  // (config entry and platform), to say when one isn't working (integrations.js)
  async refreshRegistry() {
    try {
      const list = await this.client.send('config/entity_registry/list');
      this.registry = new Map(list.map((e) => [e.entity_id, e.device_id]));
      this.entities = new Map(list.map((e) => [e.entity_id, { entry: e.config_entry_id || null, platform: e.platform || null }]));
    } catch { this.registry = null; this.entities = null; /* not permitted: fall back to name matching */ }
  }

  /** An entity's integration: { entry, platform }, or null if the registry couldn't be read. */
  entityInfo(entityId) { return this.entities?.get(entityId) || null; }

  // The child-lock switch/lock that belongs to a climate entity, if any.
  childLockFor(climateId) {
    const isLock = (id) => /^(switch|lock)\./.test(id) && /child_?lock/i.test(id);
    const dev = this.registry?.get(climateId);
    if (dev) {
      for (const [id, d] of this.registry) if (d === dev && isLock(id) && this.states.has(id)) return id;
    }
    const base = climateId.split('.')[1];
    for (const id of this.states.keys()) if (isLock(id) && id.split('.')[1].startsWith(base)) return id;
    return null;
  }

  // Another entity on the same device as `entityId` that matches `test(id, state)`.
  companionFor(entityId, test) {
    const dev = this.registry?.get(entityId);
    if (dev) {
      for (const [id, d] of this.registry) if (d === dev && id !== entityId && this.states.has(id) && test(id, this.states.get(id))) return id;
    }
    const base = entityId.split('.')[1];
    for (const [id, st] of this.states) if (id !== entityId && id.split('.')[1].startsWith(base) && test(id, st)) return id;
    return null;
  }

  // Same shape as before: send({ type, ...data })
  send(payload, timeoutMs = 20000) {
    const { type, ...data } = payload;
    if (!this.client.connected) return Promise.reject(new Error('not connected'));
    return this.client.send(type, data, timeoutMs);
  }

  callService(domain, service, data) {
    return this.client.callService(domain, service, data);
  }

  get(entityId) { return this.states.get(entityId); }

  get timeZone() { return this.config?.time_zone || process.env.TZ || 'Europe/London'; }
}
