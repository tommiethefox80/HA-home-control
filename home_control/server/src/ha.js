// Home Assistant WebSocket client using Node's built-in WebSocket (Node 22+). No dependencies.
// One connection is shared by the heating and lighting parts of the app. Event subscriptions are
// made once per connection however many parts ask for them, so each change arrives once.
import { EventEmitter } from 'node:events';

const BACKOFF = [1000, 2000, 5000, 10000, 15000];
const CONNECT_TIMEOUT_MS = 15000; // an attempt that hasn't finished logging in by then is abandoned
const PING_EVERY_MS = 30000;      // check a quiet connection is really still there
const PING_TIMEOUT_MS = 10000;

/** Plain-English reason for a failed connection. */
function friendly(msg) {
  if (!msg) return 'Home Assistant isn\'t answering. It may be restarting.';
  if (/non-101|network error|closed before|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return 'Home Assistant isn\'t answering. It may be restarting.';
  return msg;
}

export class HAClient extends EventEmitter {
  constructor({ url, token, log = console }) {
    super();
    this.url = url;
    this.token = token;
    this.log = log;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.attempt = 0;
    this.stopped = false;
    this.lastError = null;
    this.gen = 0;        // which socket is current; events from older sockets are ignored
    this.dropped = 0;
    this.subs = new Map(); // event type -> subscription promise, for the current connection
    this.streams = new Map(); // message id -> handler, for subscriptions with their own messages (mqtt/subscribe)
  }

  start() { if (!this.started) { this.started = true; this._connect(); } }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  _connect() {
    if (this.stopped) return;
    const gen = ++this.gen;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.lastError = friendly(err.message);
      this._drop(gen);
      return;
    }
    this.ws = ws;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (gen === this.gen && !this.connected) {
        this.lastError = 'Home Assistant didn\'t answer in time. It may be restarting.';
        this._drop(gen);
      }
    }, CONNECT_TIMEOUT_MS);
    ws.addEventListener('message', (ev) => { if (gen === this.gen) this._onMessage(ev.data); });
    // Node's WebSocket only fires "error" (no "close") when an attempt fails, so treat either as the end.
    ws.addEventListener('close', () => this._drop(gen));
    ws.addEventListener('error', (ev) => {
      if (gen === this.gen && this.dropped !== gen) this.lastError = friendly(ev?.message);
      this._drop(gen);
    });
  }

  /** The current socket is finished, however it ended: tidy up once and try again. */
  _drop(gen) {
    if (gen !== this.gen || this.dropped === gen) return;
    this.dropped = gen;
    clearTimeout(this.connectTimer);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    const was = this.connected;
    this.connected = false;
    this.subs.clear();
    this.streams.clear();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Connection to Home Assistant closed'));
    }
    this.pending.clear();
    if (was) {
      this.log.warn?.('Lost connection to Home Assistant, reconnecting');
      this.emit('disconnected');
    }
    this._retry();
  }

  _retry() {
    if (this.stopped) return;
    const wait = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), wait);
  }

  _startPings(gen) {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (gen !== this.gen || !this.connected) return;
      this.send('ping', {}, PING_TIMEOUT_MS).catch(() => {
        if (gen !== this.gen) return;
        this.lastError = 'Home Assistant stopped answering. Reconnecting.';
        this._drop(gen);
      });
    }, PING_EVERY_MS);
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list) this._handle(m);
  }

  _handle(m) {
    switch (m.type) {
      case 'auth_required':
        this.ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        return;
      case 'auth_ok':
        this.connected = true;
        this.attempt = 0;
        this.lastError = null;
        clearTimeout(this.connectTimer);
        this._startPings(this.gen);
        this.log.info?.(`Connected to Home Assistant ${m.ha_version || ''}`.trim());
        this.emit('ready');
        return;
      case 'auth_invalid':
        this.lastError = 'Home Assistant refused the app\'s access token. Restart the app; if it keeps happening, reinstall it.';
        this.log.error?.(this.lastError);
        this._drop(this.gen);
        return;
      case 'event':
        if (this.streams.has(m.id)) { try { this.streams.get(m.id)(m.event); } catch (err) { this.log.warn?.(`Subscription handler: ${err.message}`); } return; }
        if (m.event?.event_type === 'state_changed') this.emit('state_changed', m.event.data, m.event.context);
        else if (m.event?.event_type) this.emit('event', m.event.event_type, m.event.data || {}, m.event.context || {});
        return;
      case 'pong':
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.type === 'pong' || m.success) p.resolve(m.result);
        else p.reject(Object.assign(new Error(m.error?.message || 'Home Assistant returned an error'), { code: m.error?.code }));
        return;
      }
      default:
    }
  }

  /** Send a command and wait for its result. */
  send(type, data = {}, timeoutMs = 20000) {
    if (!this.connected) return Promise.reject(new Error('Not connected to Home Assistant'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Home Assistant didn't answer "${type}" in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type, ...data }));
    });
  }

  getConfig() { return this.send('get_config'); }
  getStates() { return this.send('get_states'); }
  subscribeStateChanged() { return this.subscribeEvent('state_changed'); }
  subscribeEvent(type) {
    if (!this.subs.has(type)) {
      const p = this.send('subscribe_events', { event_type: type });
      p.catch(() => this.subs.delete(type));
      this.subs.set(type, p);
    }
    return this.subs.get(type);
  }

  /** A subscription whose messages come back under its own id (e.g. mqtt/subscribe); for this connection only. */
  subscribeMessage(type, data, onEvent) {
    if (!this.connected) return Promise.reject(new Error('Not connected to Home Assistant'));
    const id = this.nextId; // the id send() is about to use
    this.streams.set(id, onEvent);
    return this.send(type, data).catch((err) => { this.streams.delete(id); throw err; });
  }

  callService(domain, service, serviceData = {}, target = undefined) {
    return this.send('call_service', { domain, service, service_data: serviceData, ...(target ? { target } : {}) }, 30000);
  }

  async registries() {
    const safe = (p) => p.catch((err) => { this.log.warn?.(`Registry lookup refused: ${err.message}`); return null; });
    const [entities, devices, areas] = await Promise.all([
      safe(this.send('config/entity_registry/list')),
      safe(this.send('config/device_registry/list')),
      safe(this.send('config/area_registry/list')),
    ]);
    return { entities, devices, areas };
  }

  history(startIso, endIso, entityIds) {
    return this.send('history/history_during_period', {
      start_time: startIso,
      end_time: endIso,
      entity_ids: entityIds,
      minimal_response: false,
      no_attributes: false,
      significant_changes_only: false,
    }, 45000);
  }
}
