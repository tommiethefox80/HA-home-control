// Wi-Fi: access points, networks and who's connected, from Home Assistant's UniFi Network
// integration, with schedules: the access points' lights off at night, a network on only at set
// times, an access point switched off through the PoE port it's plugged into.
//
// Everything is read from Home Assistant's registries and states, matched by the unique IDs the
// UniFi Network integration gives its entities:
//   wlan-<id> (switch), wlan_clients-<id> (sensor), qr_code-<id> (image)          a network
//   led-<mac> (light), device_restart-<mac> (button), device_state-<mac>,
//   device_uptime-<mac>, device_clients-<mac>, device_temperature-<mac>,
//   device_uplink_mac-<mac> (sensors), device_update-<mac> (update), <mac> (tracker) a UniFi device
//   poe-<mac>_<port> (switch)                                                       a PoE port
//   <site>-<mac> (device_tracker), block-<mac> (switch)                              a client
// Devices seen by any other router integration (device_tracker, source_type router) are listed too.
import { EventEmitter } from 'node:events';
import { zonedParts } from '../lighting/schedule.js';
import { MODES, NO_SCHEDULE } from './store.js';

export class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const TS = Number(process.env.HC_TIME_SCALE) || 1; // tests run minutes as fractions of a second
const MAC = '([0-9a-f]{2}(?::[0-9a-f]{2}){5})';
const RE = {
  wlan: /^wlan-(.+)$/,
  wlanClients: /^wlan_clients-(.+)$/,
  qr: /^qr_code-(.+)$/,
  led: new RegExp(`^led-${MAC}$`),
  restart: new RegExp(`^device_restart-${MAC}$`),
  state: new RegExp(`^device_state-${MAC}$`),
  uptime: new RegExp(`^device_uptime-${MAC}$`),
  clients: new RegExp(`^device_clients-${MAC}$`),
  temp: new RegExp(`^device_temperature-${MAC}$`),
  update: new RegExp(`^device_update-${MAC}$`),
  uplink: new RegExp(`^device_uplink_mac-${MAC}$`),
  poe: new RegExp(`^poe-${MAC}_(\\d+)$`),
  tracker: new RegExp(`^${MAC}$`),
  client: new RegExp(`^.+-${MAC}$`),
  block: new RegExp(`^block-${MAC}$`),
};
const MAX_EVENTS = 400;
const BANDS = { ng: '2.4 GHz', na: '5 GHz', '6e': '6 GHz' };

// UniFi's model codes, as Home Assistant shows them, in the names on the box
const MODELS = {
  U7PG2: 'AC Pro', U7LT: 'AC Lite', U7LR: 'AC LR', U7NHD: 'nanoHD', UFLHD: 'Flex HD', UHDIW: 'In-Wall HD',
  U7MSH: 'AC Mesh', U7MP: 'AC Mesh Pro', U7HD: 'AC HD', U7SHD: 'AC SHD', U7IW: 'AC In-Wall', U7IWP: 'AC In-Wall Pro',
  UAL6: 'U6 Lite', UALR6: 'U6 LR', UAP6MP: 'U6 Pro', UAPL6: 'U6+', UAM6: 'U6 Mesh', U6ENT: 'U6 Enterprise',
  UDMPRO: 'Dream Machine Pro', UDMPROSE: 'Dream Machine SE', UDM: 'Dream Machine', UDR: 'Dream Router', UDW: 'Dream Wall',
  UXG: 'Gateway Lite', UXGPRO: 'Next-Gen Gateway Pro', UGW3: 'Security Gateway', UGW4: 'Security Gateway Pro', UCK: 'Cloud Key',
  USMINI: 'Flex Mini', USF5P: 'Switch Flex', US8: 'Switch 8', US8P60: 'Switch 8 PoE (60W)', US8P150: 'Switch 8 PoE (150W)',
  USL8LP: 'Switch Lite 8 PoE', USL16LP: 'Switch Lite 16 PoE', US16P150: 'Switch 16 PoE', US24P250: 'Switch 24 PoE',
};
// gateways with Wi-Fi of their own
const WIFI_GATEWAYS = /^(UDM|UDR|UDW|UX)$/;

export function guessKind(model) {
  const m = String(model || '').toUpperCase();
  if (/^UCK/.test(m)) return 'other';
  if (/^(UDM|UDR|UDW|UXG|UGW|UCG|UX)/.test(m)) return 'gateway';
  if (/^(US|ES)/.test(m)) return 'switch';
  if (/^(U7|U6|UA|UFL|UHD|UK|UM|UB|BZ|U2|E7|UDB)/.test(m)) return 'ap';
  return 'other';
}

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));

export class Engine extends EventEmitter {
  constructor({ ha, store, log, house, picture }) {
    super();
    this.ha = ha;
    this.store = store;
    this.data = store.data;
    this.log = log;
    this.house = house;
    this.fetchImage = picture || null;
    this.states = new Map();
    this.reg = { entities: new Map(), devices: new Map() };
    this.tz = 'UTC';
    this.ready = false;
    this.disabled = false;
    this.ix = { devices: new Map(), networks: new Map(), poe: [], relevant: new Set(), apMacs: new Set() };
  }

  start() {
    this.ha.on('ready', () => this._onReady().catch((err) => this.log.warn?.(`Wi-Fi: ${err.message}`)));
    this.ha.on('state_changed', (d) => this._onState(d));
    this.ha.on('event', (type) => { if (type === 'entity_registry_updated' || type === 'device_registry_updated') this._reloadSoon(); });
    this.ha.on('disconnected', () => { this.ready = false; this.changed(); });
    this.timer = setInterval(() => this.tick(), Math.max(200, 20000 * TS));
  }

  stop() { clearInterval(this.timer); clearInterval(this.regTimer); this.store.flush(); }

  changed() { this.emit('change'); }

  /** Home Assistant renamed an entity's ID: an access point's PoE port follows it. */
  /** Every entity ID Wi-Fi keeps (most is by MAC address): the PoE switches access points are turned off with. */
  entityIds() {
    return Object.values(this.data.devices || {}).map((d) => d?.poe).filter((e) => typeof e === 'string');
  }

  renameEntity(from, to) {
    let hit = false;
    for (const conf of Object.values(this.data.devices || {})) if (conf?.poe === from) { conf.poe = to; hit = true; }
    if (!hit) return false;
    this.store.save();
    this.addEvent(`Home Assistant renamed ${from} to ${to}: the access point switched off through it follows it.`);
    return true;
  }

  async _onReady() {
    const [config, states] = await Promise.all([this.ha.getConfig(), this.ha.getStates()]);
    this.tz = config?.time_zone || 'UTC';
    this.states = new Map(states.map((s) => [s.entity_id, s]));
    await this.ha.subscribeStateChanged();
    await Promise.all(['entity_registry_updated', 'device_registry_updated'].map((t) => this.ha.subscribeEvent(t).catch(() => {})));
    await this.loadRegistries();
    this.ready = true;
    this.tick();
    this.changed();
    clearInterval(this.regTimer);
    this.regTimer = setInterval(() => this.loadRegistries().then(() => this.changed()).catch(() => {}), 10 * 60000);
  }

  async loadRegistries() {
    const { entities, devices } = await this.ha.registries();
    // the registry lists entities that are turned off in Home Assistant too: some are offered to turn on
    this.reg.entities = new Map((entities || []).map((e) => [e.entity_id, e]));
    this.reg.devices = new Map((devices || []).map((d) => [d.id, d]));
    this.reindex();
  }

  _reloadSoon() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.loadRegistries().then(() => this.changed()).catch(() => {}), 1500);
  }

  // ---------- what Home Assistant has ----------

  /** The UniFi devices, networks and PoE ports, worked out from the registries once rather than on every change. */
  reindex() {
    const devices = new Map(); const networks = new Map(); const poe = []; const relevant = new Set();
    const dev = (mac) => {
      if (!devices.has(mac)) devices.set(mac, { mac, entities: {} });
      return devices.get(mac);
    };
    for (const e of this.reg.entities.values()) {
      if (e.platform !== 'unifi') continue;
      const uid = String(e.unique_id || '');
      const domain = e.entity_id.split('.')[0];
      const on = !e.disabled_by;
      let m;
      if (domain === 'switch' && (m = RE.wlan.exec(uid))) { if (on) { const n = networks.get(m[1]) || { id: m[1] }; n.switch = e.entity_id; n.device_id = e.device_id; networks.set(m[1], n); } }
      else if (domain === 'sensor' && (m = RE.wlanClients.exec(uid))) { if (on) { const n = networks.get(m[1]) || { id: m[1] }; n.clients = e.entity_id; networks.set(m[1], n); } }
      else if (domain === 'image' && (m = RE.qr.exec(uid))) { const n = networks.get(m[1]) || { id: m[1] }; n.qr = { entity: e.entity_id, enabled: on, by: e.disabled_by }; networks.set(m[1], n); }
      else if (domain === 'switch' && (m = RE.poe.exec(uid))) poe.push({ entity: e.entity_id, mac: m[1], port: Number(m[2]), enabled: on, by: e.disabled_by, device_id: e.device_id });
      else if (on) {
        for (const [key, re, dom] of [['led', RE.led, 'light'], ['restart', RE.restart, 'button'], ['state', RE.state, 'sensor'], ['uptime', RE.uptime, 'sensor'],
          ['clients', RE.clients, 'sensor'], ['temp', RE.temp, 'sensor'], ['update', RE.update, 'update'], ['uplink', RE.uplink, 'sensor'], ['tracker', RE.tracker, 'device_tracker']]) {
          if (domain === dom && (m = re.exec(uid))) {
            const d = dev(m[1]);
            d.entities[key] = e.entity_id;
            if (e.device_id) d.device_id ||= e.device_id;
            break;
          }
        }
      }
      if (on) relevant.add(e.entity_id);
    }
    // networks without their switch (turned off in Home Assistant) aren't shown
    for (const [id, n] of networks) if (!n.switch) networks.delete(id);
    this.ix = { devices, networks, poe: poe.sort((a, b) => a.port - b.port), relevant, apMacs: new Set() };
  }

  friendly(id) { return this.states.get(id)?.attributes?.friendly_name || this.lastName?.(id) || id; }
  deviceEntry(id) { return id ? this.reg.devices.get(id) || null : null; }
  deviceName(d) { const r = this.deviceEntry(d.device_id); return r?.name_by_user || r?.name || this.friendly(d.entities.led || d.entities.tracker || d.entities.state) || d.mac; }
  macOfId(id) { return String(id || '').toLowerCase().replace(/[^0-9a-f]/g, '').replace(/(..)(?!$)/g, '$1:'); }

  /** Devices connected through a router (UniFi or any other integration that tracks them). */
  clientStates() {
    const out = [];
    for (const s of this.states.values()) {
      if (!s.entity_id.startsWith('device_tracker.') || s.attributes?.source_type !== 'router') continue;
      const r = this.reg.entities.get(s.entity_id);
      if (r?.platform === 'unifi' && RE.tracker.test(String(r.unique_id || ''))) continue; // a UniFi device itself
      out.push([s, r]);
    }
    return out;
  }

  clients() {
    const apName = new Map([...this.ix.devices.values()].map((d) => [d.mac, this.deviceName(d)]));
    const blocks = new Map();
    for (const e of this.reg.entities.values()) {
      let m;
      if (e.platform === 'unifi' && !e.disabled_by && e.entity_id.startsWith('switch.') && (m = RE.block.exec(String(e.unique_id || '')))) blocks.set(m[1], e.entity_id);
    }
    return this.clientStates().map(([s, r]) => {
      const a = s.attributes || {};
      const uid = /-((?:[0-9a-f]{2}:){5}[0-9a-f]{2})$/.exec(String(r?.unique_id || ''));
      const mac = String(a.mac || uid?.[1] || '').toLowerCase() || null;
      const blockEntity = mac && blocks.get(mac);
      const unifi = r?.platform === 'unifi';
      return {
        id: s.entity_id,
        name: a.friendly_name || a.host_name || s.entity_id,
        mac, ip: a.ip || null, host: a.host_name || null, maker: a.oui || null,
        connected: s.state === 'home',
        since: Date.parse(s.last_changed) || null,
        network: a.essid || null,
        wired: unifi && s.state === 'home' ? !a.essid && !a.ap_mac : null,
        ap: a.ap_mac ? apName.get(String(a.ap_mac).toLowerCase()) || a.ap_mac : null,
        apMac: a.ap_mac ? String(a.ap_mac).toLowerCase() : null,
        band: BANDS[a.radio] || null,
        guest: !!a.is_guest,
        blocked: blockEntity ? this.states.get(blockEntity)?.state === 'off' : null,
        block: blockEntity || null,
        integration: r?.platform || null,
      };
    }).sort((x, y) => (y.connected - x.connected) || x.name.localeCompare(y.name));
  }

  /** UniFi client trackers Home Assistant has turned off (it does for devices it doesn't otherwise know). */
  untracked() {
    return [...this.reg.entities.values()].filter((e) => e.platform === 'unifi' && e.entity_id.startsWith('device_tracker.')
      && e.disabled_by === 'integration' && RE.client.test(String(e.unique_id || '')) && !RE.tracker.test(String(e.unique_id || '')));
  }

  deviceView(d, clients) {
    const st = (k) => (d.entities[k] ? this.states.get(d.entities[k]) : null);
    const reg = this.deviceEntry(d.device_id);
    const model = reg?.model || '';
    const conf = this.data.devices[d.mac] || {};
    const seen = clients.filter((c) => c.connected && c.apMac === d.mac).length;
    const kind = conf.kind || (this.ix.apMacs.has(d.mac) ? 'ap' : guessKind(model));
    const wifi = kind === 'ap' || this.ix.apMacs.has(d.mac) || (kind === 'gateway' && WIFI_GATEWAYS.test(model.toUpperCase()));
    const state = st('state')?.state;
    const tracker = st('tracker')?.state;
    const led = st('led');
    const power = conf.poe ? this.poeView(conf.poe) : null;
    const anyOn = ['led', 'restart', 'uptime'].some((k) => st(k) && st(k).state !== 'unavailable');
    const online = state ? state === 'connected' : tracker ? tracker === 'home' : anyOn;
    const sensorClients = Number(st('clients')?.state);
    return {
      id: d.mac.replace(/:/g, ''), mac: d.mac, name: this.deviceName(d),
      model, modelName: MODELS[model.toUpperCase()] || model || null, firmware: reg?.sw_version || null,
      kind, wifi, hidden: conf.kind === 'hidden',
      online, state: state && state !== 'unavailable' ? state : null,
      switchedOff: !!power && power.state === 'off',
      upSince: Date.parse(st('uptime')?.state) || null,
      clients: Number.isFinite(sensorClients) ? sensorClients : seen,
      temperature: Number.isFinite(Number(st('temp')?.state)) ? Number(st('temp').state) : null,
      update: st('update')?.state === 'on' ? (st('update').attributes?.latest_version || 'available') : null,
      led: d.entities.led ? { entity: d.entities.led, on: led?.state === 'on', available: !!led && led.state !== 'unavailable' } : null,
      restart: d.entities.restart || null,
      power,
      schedule: conf.schedule || { ...NO_SCHEDULE },
      ledScheduled: !!d.entities.led && this.ledScheduled(d.mac),
      uplink: st('uplink')?.state || null,
    };
  }

  poeView(entity) {
    const p = this.ix.poe.find((x) => x.entity === entity);
    const s = this.states.get(entity);
    const owner = p && this.ix.devices.get(p.mac);
    return {
      entity, port: p?.port ?? null, switchName: owner ? this.deviceName(owner) : null,
      name: s?.attributes?.friendly_name || entity,
      state: s?.state || (p && !p.enabled ? 'turned off in Home Assistant' : 'unavailable'),
      enabled: !!p?.enabled, available: !!s && s.state !== 'unavailable',
    };
  }

  /** PoE ports an access point could be plugged into: the one its uplink says first. */
  poeChoices(d) {
    const up = d.uplink ? String(d.uplink).toLowerCase() : null;
    return this.ix.poe.map((p) => {
      const owner = this.ix.devices.get(p.mac);
      const s = this.states.get(p.entity);
      return { entity: p.entity, port: p.port, switchName: owner ? this.deviceName(owner) : p.mac, name: s?.attributes?.friendly_name || `Port ${p.port}`, enabled: p.enabled, uplink: p.mac === up };
    }).sort((a, b) => (b.uplink - a.uplink) || a.switchName.localeCompare(b.switchName) || a.port - b.port);
  }

  networkView(n, clients) {
    const sw = this.states.get(n.switch);
    const reg = this.deviceEntry(n.device_id);
    const name = reg?.name_by_user || reg?.name || sw?.attributes?.friendly_name || n.switch;
    const count = Number(this.states.get(n.clients)?.state);
    return {
      id: n.id, entity: n.switch, name,
      on: sw?.state === 'on', available: !!sw && sw.state !== 'unavailable',
      clients: Number.isFinite(count) ? count : clients.filter((c) => c.connected && c.network === name).length,
      qr: n.qr ? { enabled: n.qr.enabled, byUser: n.qr.by === 'user' } : null,
      schedule: this.data.networks[n.id]?.schedule || { ...NO_SCHEDULE },
    };
  }

  ledScheduled(mac) {
    const L = this.data.settings.leds;
    return L.mode !== 'none' && (L.devices == null || L.devices.includes(mac));
  }

  snapshot() {
    const clients = this.clients();
    this.ix.apMacs = new Set(clients.filter((c) => c.apMac).map((c) => c.apMac));
    const devices = [...this.ix.devices.values()].map((d) => this.deviceView(d, clients))
      .sort((a, b) => (b.wifi - a.wifi) || a.name.localeCompare(b.name));
    const networks = [...this.ix.networks.values()].map((n) => this.networkView(n, clients)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      connected: this.ha.connected && this.ready,
      disabled: this.disabled,
      timeZone: this.tz,
      unifi: this.ix.devices.size > 0 || this.ix.networks.size > 0,
      aps: devices.filter((d) => d.wifi && !d.hidden),
      others: devices.filter((d) => !d.wifi && !d.hidden),
      hidden: devices.filter((d) => d.hidden),
      networks,
      clients,
      untracked: this.untracked().length,
      settings: this.data.settings,
      events: this.data.events.slice(0, 30),
    };
  }

  /** For the settings page: every device with the ports it could be switched off through. */
  settingsView() {
    const snap = this.snapshot();
    const all = [...snap.aps, ...snap.others, ...snap.hidden];
    return { ...snap, devices: all.map((d) => ({ ...d, poeChoices: d.wifi ? this.poeChoices(d) : [] })) };
  }

  events({ before = Infinity, limit = 60 } = {}) {
    return this.data.events.filter((e) => e.at < before).slice(0, limit);
  }

  addEvent(text, kind = 'note') {
    this.data.events.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), kind, text });
    if (this.data.events.length > MAX_EVENTS) this.data.events.length = MAX_EVENTS;
    this.store.save();
  }

  // ---------- changes ----------

  _onState({ entity_id: id, new_state: ns, old_state: os } = {}) {
    if (!id) return;
    if (ns) this.states.set(id, ns); else this.states.delete(id);
    if (!this.ready) return;
    // an entity turned on in Home Assistant (after we asked, say) shows up: read the registries again
    if (ns && !os && this.reg.entities.get(id)?.platform === 'unifi') this._reloadSoon();
    if (this.ix.relevant.has(id) || (id.startsWith('device_tracker.') && (ns || os)?.attributes?.source_type === 'router')) this.changed();
  }

  _need() {
    if (this.disabled) throw new UserError('Wi-Fi is turned off in Home Control\'s settings.', 409);
    if (!this.ready) throw new UserError('Not connected to Home Assistant right now.', 503);
  }

  device(id) {
    const mac = this.macOfId(id);
    const d = this.ix.devices.get(mac);
    if (!d) throw new UserError('That device isn\'t in Home Assistant\'s UniFi Network integration', 404);
    return d;
  }

  network(id) {
    const n = this.ix.networks.get(String(id));
    if (!n) throw new UserError('That network isn\'t in Home Assistant\'s UniFi Network integration', 404);
    return n;
  }

  async _switch(domain, entity, on) {
    const st = this.states.get(entity);
    if (!st || st.state === 'unavailable') throw new UserError(`Home Assistant shows ${this.friendly(entity)} as unavailable right now.`, 409);
    await this.ha.callService(domain, on ? 'turn_on' : 'turn_off', { entity_id: entity });
  }

  async setNetwork(id, on) {
    this._need();
    const n = this.network(id);
    await this._switch('switch', n.switch, on);
    this.addEvent(`${this.networkView(n, []).name} turned ${on ? 'on' : 'off'} here.`, 'manual');
    this.changed();
  }

  async setLed(id, on) {
    this._need();
    const d = this.device(id);
    if (!d.entities.led) throw new UserError('This device\'s light can\'t be switched from Home Assistant');
    await this._switch('light', d.entities.led, on);
    this.addEvent(`Status light ${on ? 'on' : 'off'} on ${this.deviceName(d)}.`, 'manual');
    this.changed();
  }

  async setAllLeds(on) {
    this._need();
    const done = [];
    for (const d of this.ix.devices.values()) {
      const s = d.entities.led && this.states.get(d.entities.led);
      if (!s || s.state === 'unavailable' || (s.state === 'on') === on) continue;
      if (this.data.devices[d.mac]?.kind === 'hidden') continue;
      await this.ha.callService('light', on ? 'turn_on' : 'turn_off', { entity_id: d.entities.led }).then(() => done.push(this.deviceName(d))).catch(() => {});
    }
    if (done.length) this.addEvent(`Status lights ${on ? 'on' : 'off'} on ${listOf(done)}.`, 'manual');
    this.changed();
    return done.length;
  }

  async restart(id) {
    this._need();
    const d = this.device(id);
    if (!d.entities.restart) throw new UserError('This device can\'t be restarted from Home Assistant');
    const st = this.states.get(d.entities.restart);
    if (!st || st.state === 'unavailable') throw new UserError(`${this.deviceName(d)} isn't connected right now, so it can't be restarted.`, 409);
    await this.ha.callService('button', 'press', { entity_id: d.entities.restart });
    this.addEvent(`${this.deviceName(d)} restarted. It's back in a minute or two.`, 'manual');
    this.changed();
  }

  async setPower(id, on) {
    this._need();
    const d = this.device(id);
    const poe = this.data.devices[d.mac]?.poe;
    if (!poe) throw new UserError(`Choose the PoE port ${this.deviceName(d)} is plugged into first (Wi-Fi → Settings).`);
    await this._switch('switch', poe, on);
    this.addEvent(on ? `${this.deviceName(d)} switched back on. It takes a few minutes to start.` : `${this.deviceName(d)} switched off (its PoE port).`, 'manual');
    this.changed();
  }

  async setBlocked(entity, blocked) {
    this._need();
    const c = this.clients().find((x) => x.id === entity);
    if (!c?.block) throw new UserError('That device can\'t be blocked from Home Assistant');
    await this._switch('switch', c.block, !blocked);
    this.addEvent(`${c.name} ${blocked ? 'blocked from' : 'allowed back on'} the network.`, 'manual');
    this.changed();
  }

  /** Turn entities on in Home Assistant's entity registry; Home Assistant adds them within a minute. */
  async enableEntities(ids) {
    let n = 0;
    for (const entity_id of ids) {
      try { await this.ha.send('config/entity_registry/update', { entity_id, disabled_by: null }); n++; } catch (err) { this.log.warn?.(`Wi-Fi: couldn't turn on ${entity_id}: ${err.message}`); }
    }
    this._reloadSoon();
    return n;
  }

  async trackAll() {
    this._need();
    const list = this.untracked().map((e) => e.entity_id);
    const n = await this.enableEntities(list);
    if (n) this.addEvent(`Asked Home Assistant to track ${n} more device${n === 1 ? '' : 's'}. They appear within a minute or so.`);
    this.changed();
    return n;
  }

  async showQr(id) {
    this._need();
    const n = this.network(id);
    if (!n.qr) throw new UserError('Home Assistant has no QR code for this network');
    if (!n.qr.enabled) await this.enableEntities([n.qr.entity]);
    return { ready: n.qr.enabled };
  }

  async qrImage(id) {
    const n = this.network(id);
    if (!n.qr?.enabled || !this.fetchImage) return null;
    return this.fetchImage(n.qr.entity);
  }

  // ---------- settings ----------

  schedule(input, current) {
    if (input == null) return current;
    const s = { ...(current || NO_SCHEDULE), ...input };
    if (!MODES.includes(s.mode)) throw new UserError('Choose when the schedule applies');
    if (!validTime(s.from) || !validTime(s.to)) throw new UserError('Times look like 22:00');
    if (s.mode !== 'none' && s.from === s.to) throw new UserError('The two times need to be different');
    return { mode: s.mode, from: s.from, to: s.to };
  }

  updateNetwork(id, body) {
    const n = this.network(id);
    const cur = this.data.networks[n.id] || {};
    const schedule = this.schedule(body.schedule, cur.schedule);
    this.data.networks[n.id] = { ...cur, schedule };
    this._forget(`net:${n.id}`);
    this.store.save();
    this.tick();
    this.changed();
  }

  updateDevice(id, body) {
    const d = this.device(id);
    const cur = this.data.devices[d.mac] || {};
    const next = { ...cur };
    if ('kind' in body) {
      if (![null, 'ap', 'switch', 'gateway', 'other', 'hidden'].includes(body.kind)) throw new UserError('Unknown kind of device');
      next.kind = body.kind || undefined;
    }
    if ('poe' in body) {
      if (body.poe && !this.ix.poe.some((p) => p.entity === body.poe)) throw new UserError('That isn\'t a PoE port Home Assistant knows');
      next.poe = body.poe || undefined;
      const p = this.ix.poe.find((x) => x.entity === body.poe);
      if (p && !p.enabled) this.enableEntities([p.entity]).catch(() => {}); // Home Assistant turns these off to start with
    }
    if (body.schedule) next.schedule = this.schedule(body.schedule, cur.schedule);
    if (next.schedule?.mode === 'on_between') throw new UserError('An access point can be switched off between two times; it\'s on the rest of the day');
    this.data.devices[d.mac] = next;
    this._forget(`power:${d.mac}`);
    this.store.save();
    this.tick();
    this.changed();
  }

  updateSettings(body) {
    if (body.leds) {
      const L = this.data.settings.leds;
      const s = this.schedule({ mode: body.leds.mode ?? L.mode, from: body.leds.from ?? L.from, to: body.leds.to ?? L.to }, L);
      if (s.mode === 'on_between') throw new UserError('Lights can be off between two times; they\'re on the rest of the day');
      let devices = L.devices;
      if ('devices' in body.leds) devices = Array.isArray(body.leds.devices) ? body.leds.devices.map((x) => this.macOfId(x)) : null;
      this.data.settings.leds = { ...s, devices };
      this._forget('led:');
    }
    if (body.clients && typeof body.clients === 'object') {
      const c = { ...this.data.settings.clients };
      for (const k of ['aps', 'networks', 'card']) if (typeof body.clients[k] === 'boolean') c[k] = body.clients[k];
      this.data.settings.clients = c;
    }
    this.store.save();
    this.tick();
    this.changed();
  }

  _forget(prefix) {
    for (const k of Object.keys(this.data.applied)) if (k.startsWith(prefix)) delete this.data.applied[k];
  }

  // ---------- schedules ----------

  /** The schedule's most recent change before now: on or off, and since when (a key, so it's made once). */
  boundary(s, ms = Date.now()) {
    if (!s || s.mode === 'none' || !validTime(s.from) || !validTime(s.to) || s.from === s.to) return null;
    const p = zonedParts(ms, this.tz);
    const agoF = (p.minutes - toMin(s.from) + 1440) % 1440;
    const agoT = (p.minutes - toMin(s.to) + 1440) % 1440;
    const startOfWindow = agoF <= agoT;
    const ago = startOfWindow ? agoF : agoT;
    const at = ms - ago * 60000 - p.second * 1000;
    const d = zonedParts(at, this.tz);
    const on = s.mode === 'on_between' ? startOfWindow : !startOfWindow;
    return { on, at, key: `${d.year}-${d.month}-${d.day} ${startOfWindow ? s.from : s.to} ${s.mode}` };
  }

  /** Make each scheduled change once, at its time (or as soon as the device is back). Changes made by
   *  hand in between are left alone until the next scheduled change. */
  tick(ms = Date.now()) {
    if (!this.ready || this.disabled) return;
    const leds = { on: [], off: [] };
    const L = this.data.settings.leds;
    const b = this.boundary(L, ms);
    if (b) {
      for (const d of this.ix.devices.values()) {
        if (!d.entities.led || !this.ledScheduled(d.mac) || this.data.devices[d.mac]?.kind === 'hidden') continue;
        this._due(`led:${d.mac}`, b, d.entities.led, () => this.ha.callService('light', b.on ? 'turn_on' : 'turn_off', { entity_id: d.entities.led })
          .then(() => leds[b.on ? 'on' : 'off'].push(this.deviceName(d))));
      }
    }
    for (const n of this.ix.networks.values()) {
      const nb = this.boundary(this.data.networks[n.id]?.schedule, ms);
      if (!nb) continue;
      const name = this.networkView(n, []).name;
      this._due(`net:${n.id}`, nb, n.switch, () => this.ha.callService('switch', nb.on ? 'turn_on' : 'turn_off', { entity_id: n.switch })
        .then(() => this.addEvent(`${name} turned ${nb.on ? 'on' : 'off'} (schedule, ${this.clock(nb.at)}).`, 'schedule')));
    }
    for (const d of this.ix.devices.values()) {
      const conf = this.data.devices[d.mac];
      const pb = conf?.poe && this.boundary(conf.schedule, ms);
      if (!pb) continue;
      this._due(`power:${d.mac}`, pb, conf.poe, () => this.ha.callService('switch', pb.on ? 'turn_on' : 'turn_off', { entity_id: conf.poe })
        .then(() => this.addEvent(`${this.deviceName(d)} switched ${pb.on ? 'back on' : 'off'} (schedule, ${this.clock(pb.at)}).`, 'schedule')));
    }
    // one line for the lights, however many there are
    Promise.resolve().then(() => setTimeout(() => {
      for (const k of ['off', 'on']) if (leds[k].length) this.addEvent(`Status lights ${k} on ${listOf(leds[k])} (schedule, ${this.clock(b.at)}).`, 'schedule');
      if (leds.on.length || leds.off.length) this.changed();
    }, 1500));
  }

  _due(key, b, entity, act) {
    if (this.data.applied[key] === b.key) return;
    const st = this.states.get(entity);
    if (!st || st.state === 'unavailable') return; // done when it's back
    this.data.applied[key] = b.key;
    this.store.save();
    if ((st.state === 'on') === b.on) return; // already as the schedule says
    act().catch((err) => {
      delete this.data.applied[key]; // try again next time round
      this.log.warn?.(`Wi-Fi schedule: ${err.message}`);
    });
  }

  clock(ms) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  }
}

function listOf(a) {
  return a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
