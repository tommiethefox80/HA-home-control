// Puts a summary of the heating and the lighting into Home Assistant, for dashboards:
//   sensor.home_heating    state: Schedules / Away / Off; attributes: boiler, every room
//   binary_sensor.home_boiler   on while the boiler is firing (device_class heat)
//   sensor.home_boiler_today    minutes the boiler has run today
//   sensor.home_boiler_next     when the boiler should next fire (a prediction; unknown while it's on)
//   sensor.home_lighting   state: how many lights and sockets are on; attributes: every group
// The Home Control card (dashboard/home-control-card.js) draws these; any other card can use them too.
//
// They're written with Home Assistant's REST API (POST /api/states/…), so they aren't
// saved by Home Assistant itself: they're written again whenever it (re)connects.

const MODE_NAME = { auto: 'Schedules', away: 'Away', off: 'Off' };
const LIGHT_MODE_NAME = { schedule: 'Schedules', away: 'Away' };

const deg = (t) => (t == null ? '–' : `${Number(t).toFixed(1).replace(/\.0$/, '')}°`);
const round1 = (n) => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 10) / 10);
const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// like the Lighting page: "Lounge, Kitchen and 2 more"
const names = (a) => (a.length <= 3 ? list(a) : `${a[0]}, ${a[1]} and ${a.length - 2} more`);

function clock(ms, tz, withDay) {
  if (!ms) return '';
  const d = new Date(ms);
  const opts = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short' });
  if (withDay || day.format(d) !== day.format(new Date())) opts.weekday = 'short';
  return new Intl.DateTimeFormat('en-GB', opts).format(d);
}
function minutesLeft(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
function today(tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date()).toLowerCase().slice(0, 3);
}

/** The same words as the room cards in the app, as plain text. */
export function roomStatus(z, tz) {
  const base = baseStatus(z, tz);
  // below its target but not heating: say when it will
  if (!z.enabled || !z.waiting || z.startAt == null || ['off', 'window'].includes(z.source)) return base;
  return z.source === 'schedule' || !z.source ? `Heats again below ${deg(z.startAt)} · ${base.replace(/^On schedule, /, '')}` : `${base} · heats again below ${deg(z.startAt)}`;
}

function baseStatus(z, tz) {
  if (!z.enabled) return 'Not managed by this app';
  if (z.snoozedUnder && z.source !== 'snooze' && ['boost', 'hold', 'manual'].includes(z.source)) {
    return `${baseStatus({ ...z, snoozedUnder: false }, tz)}, then snoozed again`;
  }
  const next = z.scheduled?.next;
  const at = (n) => (n ? `${n.day !== today(tz) ? `${n.day[0].toUpperCase()}${n.day.slice(1)} ` : ''}${n.time}` : '');
  switch (z.source) {
    case 'boost': return `Boost to ${deg(z.target)}, ${minutesLeft(z.until)} left`;
    case 'preheat': return `Warming early to reach ${deg(z.target)} by ${z.readyBy}`;
    case 'window': return `Window open? Heating paused until ${clock(z.until, tz)}`;
    case 'hold': return `Held at ${deg(z.target)} until ${clock(z.until, tz)}`;
    case 'manual': return `Changed on ${z.by || 'the radiator'} to ${deg(z.target)} until ${clock(z.until, tz)}`;
    case 'snooze': return `Snoozed at ${deg(z.target)} ${z.forever ? 'until you turn it back on' : `until ${clock(z.until, tz)}`}`;
    case 'away': return `Away mode, kept at ${deg(z.target)}`;
    case 'off': return `Heating off, frost protection at ${deg(z.target)}`;
    case 'no-schedule': return `No schedule yet, kept at ${deg(z.target)}`;
    default: return next ? `On schedule, ${deg(next.temp)} from ${at(next)}` : 'On schedule';
  }
}

const hm = (mins) => (mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/** When a room next needs heat (the app's prediction), short for a dashboard card. */
export function nextText(z, tz) {
  const n = z.next;
  if (!z.enabled || !n) return null;
  if (z.calling) return n.until ? `Heating until about ${clock(n.until, tz)}` : null;
  if (n.withOthers) return 'Warming with the other rooms';
  if (!n.at) return null;
  return `Next heat ${n.reason === 'schedule' ? '' : 'about '}${clock(n.at, tz)}`;
}

/** Why, to go with it. */
export function nextWhy(z) {
  const n = z.next;
  if (!z.enabled || !n) return null;
  if (z.calling) return n.until ? (n.warm ? `when it reaches ${deg(z.stopAt)}` : 'when its target drops') : null;
  if (!n.at) return null;
  return { cooling: `as it cools to ${deg(n.threshold)}`, preheat: `to be ${deg(n.target)} by ${n.readyBy}`, schedule: `its schedule goes up to ${deg(n.target)}`, change: `back to ${deg(n.target)}` }[n.reason] || null;
}

export function heatingState(snap, today = null, panel = null) {
  const tz = snap.timeZone;
  const rooms = snap.zones.map((z) => ({
    id: z.id, name: z.name, temp: round1(z.current), target: round1(z.target),
    calling: !!z.calling, enabled: z.enabled !== false, status: roomStatus(z, tz),
    next: nextText(z, tz), next_why: nextWhy(z), next_heat: iso(!z.calling && z.next?.at), heating_until: iso(z.calling && z.next?.until),
  }));
  const b = snap.boiler;
  const calling = snap.zones.filter((z) => z.calling).map((z) => z.name);
  const boiler = !b.entity ? 'No boiler chosen yet'
    : !b.available ? 'Boiler control offline'
      : b.on ? (calling.length ? `Boiler on for ${list(calling)}${b.until ? ` until about ${clock(b.until, tz)}` : ''}` : 'Boiler finishing its minimum run')
        : `Boiler resting${b.next ? `, next on about ${clock(b.next.at, tz)}` : ''}`;
  const mode = snap.mode;
  let modeText = MODE_NAME[mode] || mode;
  if (mode === 'away' && snap.awayUntil) modeText = `Away until ${clock(snap.awayUntil, tz, true)}`;
  return {
    state: MODE_NAME[mode] || mode,
    attributes: {
      friendly_name: 'Heating',
      icon: mode === 'off' ? 'mdi:radiator-off' : 'mdi:radiator',
      mode,
      mode_text: modeText,
      away_auto: !!snap.presence?.auto,
      boiler_on: !!b.on,
      boiler,
      // predicted: when it next fires (and for which rooms), or while it's on, about when it's done
      boiler_next: iso(!b.on && b.next?.at),
      boiler_next_rooms: !b.on && b.next ? b.next.rooms : [],
      boiler_until: iso(b.on && b.until),
      // today's run time, as on the app's "Boiler today" card
      boiler_today_minutes: today ? today.minutes : null,
      boiler_today: today ? hm(today.minutes) : null,
      boiler_fires_today: today ? today.fires : null,
      boost: snap.houseBoost ? { temp: snap.houseBoost.temp, until: new Date(snap.houseBoost.until).toISOString(), text: `Boosting to ${deg(snap.houseBoost.temp)}, ${minutesLeft(snap.houseBoost.until)} left` } : null,
      attention: (snap.attention || []).map((a) => a.text),
      rooms,
      connected: !!snap.haConnected,
      panel, // where the app is, so a dashboard card can open it
    },
  };
}

/** Minutes the boiler has run today: a number Home Assistant keeps history and daily statistics for. */
export function boilerTodayState(today) {
  return {
    state: today.minutes,
    attributes: {
      friendly_name: 'Boiler today', icon: 'mdi:fire-circle',
      unit_of_measurement: 'min', device_class: 'duration', state_class: 'total_increasing',
      fires: today.fires,
    },
  };
}

/** When the boiler should next fire: a timestamp sensor, for dashboards and automations. */
export function boilerNextState(snap) {
  const b = snap.boiler;
  const at = !b.on && b.next?.at ? b.next.at : null;
  const z = at ? snap.zones.find((x) => x.next?.at === at && b.next.rooms.includes(x.name)) : null;
  const why = z ? nextWhy(z) : null;
  return {
    state: at ? new Date(at).toISOString() : 'unknown',
    attributes: {
      friendly_name: 'Boiler next on', icon: 'mdi:fire-alert', device_class: 'timestamp',
      rooms: at ? b.next.rooms : [],
      reason: why,
      on_until: b.on && b.until ? new Date(b.until).toISOString() : null,
    },
  };
}

export function boilerState(snap) {
  return {
    state: snap.boiler.on ? 'on' : 'off',
    attributes: { friendly_name: 'Boiler', device_class: 'heat', icon: snap.boiler.on ? 'mdi:fire' : 'mdi:fire-off' },
  };
}

export function lightingState(snap, panel = null) {
  const groups = snap.groups.map((g) => {
    const c = g.current || {};
    const kinds = new Set(g.devices.map((d) => (d.kind === 'light' ? 'light' : 'socket')));
    return {
      id: g.id, name: g.name, on: !!c.on,
      level: !c.on ? 'Off' : g.dimmable && c.brightness != null ? `${c.brightness}%` : 'On',
      brightness: c.on && g.dimmable ? c.brightness ?? null : null,
      kelvin: c.on ? c.kelvin ?? null : null,
      on_count: c.onCount ?? 0, total: c.total ?? g.devices.length,
      kind: kinds.size > 1 ? 'mixed' : kinds.has('socket') ? 'sockets' : 'lights',
      status: g.status?.text || '',
      // whether the Home Control card shows it (a group's setting: show, only in season, or hide)
      card: g.card || 'show',
      shown: g.onCard !== false,
      // so a dashboard can switch the group: what's in it, and the level "on" means right now
      available: g.devices.some((d) => d.available !== false),
      devices: g.devices.map((d) => ({ id: d.id, dimmable: !!d.dimmable, ct: !!d.ct, available: d.available !== false })),
      turn_on: g.turnOn ? { brightness: g.dimmable ? g.turnOn.brightness ?? null : null, kelvin: g.ct ? g.turnOn.kelvin ?? null : null } : null,
    };
  });
  const onDevices = snap.groups.flatMap((g) => g.devices).filter((d) => d.on);
  const lights = onDevices.filter((d) => d.kind === 'light').length;
  const sockets = onDevices.length - lights;
  const onIn = groups.filter((g) => g.on).map((g) => g.name);
  const what = [lights && plural(lights, 'light'), sockets && plural(sockets, 'socket')].filter(Boolean).join(' and ');
  const summary = snap.paused ? 'Paused while switching over from Lighting Control'
    : !groups.length ? 'No groups yet'
      : onDevices.length ? `${what} on in ${names(onIn)}` : 'Everything is off';
  return {
    state: onDevices.length,
    attributes: {
      friendly_name: 'Lighting',
      icon: onDevices.length ? 'mdi:lightbulb-group' : 'mdi:lightbulb-group-outline',
      mode: snap.mode,
      mode_text: LIGHT_MODE_NAME[snap.mode] || snap.mode,
      paused: !!snap.paused,
      step: snap.settings?.stepSize || 10, // the brightness step for minus and plus, as in the app
      summary,
      groups,
      connected: !!snap.connected,
      panel,
    },
  };
}

const ENTITIES = { heating: ['sensor.home_heating', 'binary_sensor.home_boiler', 'sensor.home_boiler_today', 'sensor.home_boiler_next'], lighting: ['sensor.home_lighting'], cameras: ['sensor.home_cameras'], wifi: ['sensor.home_wifi'] };

/** sensor.home_cameras: how many cameras are online; every camera's state, for dashboards. */
export function camerasState(snap, panel = null) {
  const cams = snap.cameras || [];
  const online = cams.filter((c) => c.online).length;
  const offline = cams.filter((c) => !c.online).map((c) => c.name);
  const moving = cams.filter((c) => c.movingNow).map((c) => c.name);
  const last = cams.filter((c) => c.lastMovement).sort((a, b) => b.lastMovement.at - a.lastMovement.at)[0];
  const summary = !cams.length ? 'No cameras yet'
    : offline.length ? `${list(offline)} offline`
      : moving.length ? `Movement at ${list(moving)}`
        : last ? `All ${plural(cams.length, 'camera')} online. Last movement: ${last.name}, ${clock(last.lastMovement.at, snap.timeZone)}`
          : `All ${plural(cams.length, 'camera')} online`;
  return {
    state: online,
    attributes: {
      friendly_name: 'Cameras',
      icon: offline.length ? 'mdi:cctv-off' : 'mdi:cctv',
      unit_of_measurement: 'online',
      total: cams.length,
      away: !!snap.away,
      summary,
      cameras: cams.map((c) => ({
        id: c.id, name: c.name, entity: c.entity, online: c.online, moving: c.movingNow,
        last_movement: c.lastMovement ? new Date(c.lastMovement.at).toISOString() : null,
        last_movement_text: c.lastMovement ? `${c.lastMovement.text}, ${clock(c.lastMovement.at, snap.timeZone)}` : null,
        alerts_now: c.alertsNow, recording_now: c.recordNow,
        // the camera's own controls chosen for the dashboard card
        controls: c.controls.filter((x) => c.card.includes(x.id)).map((x) => ({ id: x.id, domain: x.domain, name: x.name, ...(x.options ? { options: x.options } : {}) })),
      })),
      connected: !!snap.connected,
      panel,
    },
  };
}

/** sensor.home_wifi: how many devices are connected; access points and networks, for dashboards. */
export function wifiState(snap, panel = null) {
  const aps = snap.aps || [];
  const nets = snap.networks || [];
  const on = (snap.clients || []).filter((c) => c.connected);
  const connected = on.length;
  // the devices on each, for the card, when chosen in Wi-Fi → Settings
  const lists = !!snap.settings?.clients?.card;
  const names = (list) => list.map((c) => c.name).sort((a, b) => a.localeCompare(b));
  const down = aps.filter((a) => !a.online && !a.switchedOff).map((a) => a.name);
  const off = nets.filter((n) => !n.on).map((n) => n.name);
  const summary = !aps.length && !nets.length ? 'No UniFi access points or networks found'
    : [down.length ? `${list(down)} offline` : `${plural(aps.filter((a) => a.online).length, 'access point')} online`,
      `${plural(connected, 'device')} connected`, off.length ? `${list(off)} off` : null].filter(Boolean).join(' · ');
  return {
    state: connected,
    attributes: {
      friendly_name: 'Wi-Fi',
      icon: down.length ? 'mdi:wifi-alert' : 'mdi:wifi',
      unit_of_measurement: 'connected',
      summary,
      access_points: aps.map((a) => ({
        id: a.id, name: a.name, model: a.modelName, online: a.online, switched_off: a.switchedOff, clients: a.clients,
        led: a.led ? { entity: a.led.entity, on: a.led.on } : null,
        ...(lists ? { devices: names(on.filter((c) => c.apMac === a.mac)) } : {}),
      })),
      networks: nets.map((n) => ({ id: n.id, name: n.name, entity: n.entity, on: n.on, clients: n.clients, ...(lists ? { devices: names(on.filter((c) => c.network === n.name)) } : {}) })),
      leds_schedule: snap.settings?.leds?.mode === 'off_between' ? `Off ${snap.settings.leds.from}–${snap.settings.leds.to}` : null,
      connected: !!snap.connected,
      panel,
    },
  };
}

export function createPublisher({ restBase, token, log, heating, lighting, cameras = null, wifi = null, client, panel = () => null, isEmpty = () => false, house = null }) {
  const last = new Map();      // entity -> JSON last written
  const lastAt = new Map();    // kind -> time of last write
  const timers = new Map();
  let failing = false;
  // heating changes (temperatures) are frequent and slow-moving; lights should show promptly
  const GAP = { heating: 20000, lighting: 3000, cameras: 2000, wifi: 5000 };

  async function write(entity, { state, attributes }) {
    const body = JSON.stringify({ state, attributes });
    if (last.get(entity) === body) return;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10000);
      const res = await fetch(`${restBase}/states/${entity}`, {
        method: 'POST', body, signal: ctl.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
      last.set(entity, body);
      if (failing) { failing = false; log.info?.('Dashboard sensors are being written again'); }
    } catch (err) {
      if (!failing) { failing = true; log.warn?.(`Couldn't write the dashboard sensors (${entity}): ${err.message}. Will keep trying.`); }
    }
  }

  // a module turned off in Home Control's settings: take its sensors out of Home Assistant
  const removed = new Set();
  async function remove(entity) {
    try {
      const res = await fetch(`${restBase}/states/${entity}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (res.ok || res.status === 404) { removed.add(entity); last.delete(entity); }
    } catch { /* tried again next time */ }
  }

  async function flush(kind) {
    timers.delete(kind);
    lastAt.set(kind, Date.now());
    if (!client.connected) return;
    if (house && !house.on(kind)) {
      for (const e of ENTITIES[kind]) if (!removed.has(e)) await remove(e);
      return;
    }
    for (const e of ENTITIES[kind]) removed.delete(e);
    // a fresh install with nothing set up says nothing, so it can't cover up another copy of the app
    if (isEmpty()) return;
    try {
      if (kind === 'heating') {
        const snap = heating.snapshot();
        const today = await heating.boilerToday?.().catch(() => null);
        await write('sensor.home_heating', heatingState(snap, today, panel()));
        await write('binary_sensor.home_boiler', boilerState(snap));
        await write('sensor.home_boiler_next', boilerNextState(snap));
        if (today) await write('sensor.home_boiler_today', boilerTodayState(today));
      } else if (kind === 'cameras') {
        if (cameras) await write('sensor.home_cameras', camerasState(cameras.snapshot(), panel()));
      } else if (kind === 'wifi') {
        if (wifi) await write('sensor.home_wifi', wifiState(wifi.snapshot(), panel()));
      } else {
        await write('sensor.home_lighting', lightingState(lighting.snapshot(), panel()));
      }
    } catch (err) { log.warn?.(`Dashboard sensors: ${err.message}`); }
  }

  function schedule(kind, soon = false) {
    if (timers.has(kind)) {
      if (!soon) return;
      clearTimeout(timers.get(kind));
    }
    const wait = soon ? 1000 : Math.max(1000, GAP[kind] - (Date.now() - (lastAt.get(kind) || 0)));
    timers.set(kind, setTimeout(() => flush(kind), wait));
  }

  // a new mode, the boiler starting or stopping, or a room starting to call shows straight away
  let heatSig = '';
  heating.engine.on('change', () => {
    let sig = '';
    try { sig = `${heating.store.data.runtime.mode}|${heating.engine.boilerView().on}|${heating.engine.views.filter((v) => v.calling).map((v) => v.id)}`; } catch { /* starting up */ }
    const soon = sig !== heatSig;
    heatSig = sig;
    schedule('heating', soon);
  });
  lighting.engine.on('change', () => schedule('lighting'));
  cameras?.engine.on('change', () => schedule('cameras'));
  wifi?.engine.on('change', () => schedule('wifi'));
  // Home Assistant forgets these when it restarts: write them all again on every (re)connect
  client.on('ready', () => { last.clear(); removed.clear(); setTimeout(() => { schedule('heating', true); schedule('lighting', true); if (cameras) schedule('cameras', true); if (wifi) schedule('wifi', true); }, 3000); });
  house?.events.on('modules', (changed) => { for (const m of changed) schedule(m, true); });
  // a slow refresh, so "minutes left" and clock times stay right on a quiet day
  setInterval(() => { schedule('heating'); schedule('lighting'); if (cameras) schedule('cameras'); if (wifi) schedule('wifi'); }, 5 * 60000);

  return { flushNow: async () => { await flush('heating'); await flush('lighting'); if (cameras) await flush('cameras'); if (wifi) await flush('wifi'); }, last };
}
