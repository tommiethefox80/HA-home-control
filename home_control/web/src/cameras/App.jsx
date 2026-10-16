// Cameras: a CCTV page for any make of camera in Home Assistant, with movement alerts and
// recording on schedules, offline alerts, and each camera's own settings in one place.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon, Sheet, Toggle, Field, Notice, Chips } from '../lighting/ui.jsx';
import { goDashboard, plural, joinNames } from '../lighting/lib.js';
import { HomeSettings } from '../HomeSettings.jsx';
import { api, useLiveState, clock, when, openLive, WHEN_OPTIONS, whenText } from './lib.js';

const TABS = [
  { id: 'cameras', label: 'Cameras', icon: 'camera' },
  { id: 'activity', label: 'Activity', icon: 'list' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

function useHashRoute() {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, '').replace(/^cameras\/?/, '');
    const [tab, ...rest] = h.split('/');
    return { tab: TABS.some((t) => t.id === tab) ? tab : 'cameras', arg: rest.join('/') || null };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((tab, arg) => { window.location.hash = `#/cameras/${tab === 'cameras' ? '' : tab}${arg ? `/${arg}` : ''}`; }, []);
  return [route, go];
}

function statusChip(state) {
  if (!state) return { text: 'Connecting', tone: 'quiet' };
  if (!state.connected) return { text: 'Not connected to Home Assistant', tone: 'warn' };
  const cams = state.cameras;
  if (!cams.length) return { text: 'No cameras yet', tone: 'quiet' };
  const off = cams.filter((c) => !c.online).map((c) => c.name);
  if (off.length) return { text: `${joinNames(off)} offline`, tone: 'warn' };
  const moving = cams.filter((c) => c.movingNow).map((c) => c.name);
  if (moving.length) return { text: `Movement at ${joinNames(moving)}`, tone: 'on' };
  return { text: `${cams.length === 1 ? 'Camera' : `All ${cams.length} cameras`} online`, tone: 'quiet' };
}

export function App({ active = true, switcher }) {
  const { state, link, replace } = useLiveState();
  const [route, go] = useHashRoute();
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    try {
      const res = await fn();
      if (res?.cameras) replace(res);
      setError(null);
      return res;
    } catch (err) { setError(err.message); throw err; }
  }, [replace]);

  if (!active) return null;
  const chip = statusChip(state);
  return (
    <div className="app cam-app">
      <header className="top home-top">
        <div className="home-top-l">
          <button type="button" className="btn btn-quiet dash-btn" onClick={() => goDashboard(state?.dashboardPath || '/')}>
            <Icon name="home" /><span>Dashboard</span>
          </button>
        </div>
        <h1 className="sr-only">{{ cameras: 'Cameras', activity: 'Camera activity', settings: 'Camera settings' }[route.tab]}</h1>
        {switcher?.({})}
        <div className="home-top-r">
          <span className={`status-chip status-${chip.tone}`} role="status"><span className="status-dot" />{chip.text}</span>
        </div>
      </header>

      {error && (
        <div className="wrap">
          <Notice tone="error" action={<button type="button" className="btn btn-quiet" onClick={() => setError(null)}>Dismiss</button>}>{error}</Notice>
        </div>
      )}
      {link === 'down' && <div className="wrap"><Notice tone="warn">Lost touch with the Home app. Retrying every few seconds.</Notice></div>}

      <main className="wrap" id="main">
        {route.tab === 'cameras' && <Cameras state={state} run={run} go={go} />}
        {route.tab === 'activity' && <Activity state={state} cameraId={route.arg} go={go} />}
        {route.tab === 'settings' && <Settings state={state} run={run} edit={route.arg} go={go} />}
      </main>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a key={t.id} href={`#/cameras/${t.id === 'cameras' ? '' : t.id}`} className={route.tab === t.id ? 'tab tab-on' : 'tab'} aria-current={route.tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} /><span>{t.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

// ---------- the cameras ----------

/** A new picture every few seconds while the page is open and on screen. */
function useTick(ms) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    let t = null;
    const loop = () => { if (!document.hidden) setTick(Date.now()); t = setTimeout(loop, ms); };
    t = setTimeout(loop, ms);
    const vis = () => { if (!document.hidden) setTick(Date.now()); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', vis); };
  }, [ms]);
  return tick;
}

function Cameras({ state, run, go }) {
  const tick = useTick(10000);
  const [controls, setControls] = useState(null);
  if (!state) return <p className="fine pad">Loading…</p>;
  if (!state.cameras.length) {
    return (
      <div className="card empty cam-empty">
        <Icon name="camera" size={32} />
        <h2>No cameras yet</h2>
        <p className="fine">Add the cameras Home Assistant already knows about: any make, from UniFi Protect, Reolink and Ring to Frigate, Tapo and plain RTSP cameras.</p>
        <button type="button" className="btn btn-primary" onClick={() => go('settings', 'add')}><Icon name="plus" />Add cameras</button>
      </div>
    );
  }
  const cam = controls && state.cameras.find((c) => c.id === controls);
  const alerting = state.cameras.filter((c) => c.alertsNow).map((c) => c.name);
  return (
    <>
      <p className="fine cam-lead">
        {state.disabled ? 'Cameras are turned off in Settings → Home Control.'
          : alerting.length ? `Movement alerts are on now for ${joinNames(alerting)}${state.away ? ' (everyone\'s out)' : ''}.`
            : `Movement alerts are off now${state.away ? '' : ' (no camera alerts while someone\'s home)'}.`}
        {!state.settings.notify.length && <> <a href="#/cameras/settings">Choose phones to alert</a>.</>}
      </p>
      <div className="cam-grid">
        {state.cameras.map((c) => (
          <CameraTile key={c.id} cam={c} tz={state.timeZone} tick={tick} run={run} openControls={() => setControls(c.id)} go={go} />
        ))}
      </div>
      {cam && <ControlsSheet cam={cam} run={run} onClose={() => setControls(null)} go={go} groups={state.groups} />}
    </>
  );
}

function CameraTile({ cam, tz, tick, run, openControls, go }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = `api/cameras/cameras/${cam.id}/picture?width=640&t=${tick}`;
  const status = !cam.online ? { text: cam.offlineSince ? `Offline since ${when(cam.offlineSince, tz)}` : 'Offline', tone: 'off' }
    : cam.movingNow ? { text: 'Movement now', tone: 'moving' } : null;
  const last = cam.lastMovement ? `${cam.lastMovement.text}, ${when(cam.lastMovement.at, tz)}` : 'No movement seen yet';
  const toggleAlerts = () => run(() => api('PUT', `cameras/${cam.id}`, { alerts: { on: !cam.alerts.on } }));
  return (
    <article className={`card cam-tile${cam.online ? '' : ' cam-off'}${cam.movingNow ? ' cam-moving' : ''}`} aria-label={cam.name}>
      <button type="button" className="cam-pic" onClick={() => { if (!openLive(cam.entity)) go('activity', cam.id); }} aria-label={`${cam.name}: open the live view`}>
        {cam.online && !failed && (
          <img src={src} alt="" loading="lazy" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className={loaded ? 'in' : ''} />
        )}
        {(!cam.online || failed) && <span className="cam-nopic"><Icon name={cam.online ? 'image' : 'offline'} size={28} /><span>{cam.online ? 'No picture right now' : 'Offline'}</span></span>}
        {status && <span className={`cam-badge cam-badge-${status.tone}`}>{status.text}</span>}
        {cam.online && <span className="cam-live"><Icon name="live" size={16} />Live</span>}
      </button>
      <div className="cam-body">
        <div className="cam-head">
          <h2 className="cam-name">{cam.name}</h2>
          <span className="cam-make">{[cam.make, cam.model].filter(Boolean).join(' ')}</span>
        </div>
        <p className="cam-last">{last}</p>
        <div className="cam-actions">
          <button type="button" className={`cam-chip${cam.alerts.on ? ' cam-chip-on' : ''}`} aria-pressed={cam.alerts.on} onClick={toggleAlerts}
            title={cam.alerts.on ? `Alerts ${whenText(cam.alerts)}. Press to turn off.` : 'Alerts off. Press to turn on.'}>
            <Icon name={cam.alerts.on ? 'bell' : 'bellOff'} size={18} />
            <span>{cam.alerts.on ? `Alerts ${whenText(cam.alerts)}` : 'Alerts off'}</span>
          </button>
          <span className={`cam-chip cam-chip-static${cam.recordNow ? ' cam-chip-rec' : ''}`} title={`Saving clips ${whenText(cam.record)}`}>
            <Icon name="rec" size={18} /><span>{cam.record.when === 'never' ? 'Not saving' : `Saving ${whenText(cam.record)}`}</span>
          </span>
          <button type="button" className="cam-chip" onClick={openControls}><Icon name="sliders" size={18} /><span>Camera settings</span></button>
        </div>
      </div>
    </article>
  );
}

function ControlsSheet({ cam, run, onClose, go, groups }) {
  const [busy, setBusy] = useState(null);
  const send = async (c, value) => {
    setBusy(c.id);
    try { await run(() => api('POST', `cameras/${cam.id}/control`, { entity: c.id, value })); } catch { /* shown */ } finally { setBusy(null); }
  };
  const byGroup = groups.map((g) => ({ ...g, items: cam.controls.filter((c) => c.group === g.id) })).filter((g) => g.items.length);
  return (
    <Sheet title={cam.name} subtitle={[cam.make, cam.model].filter(Boolean).join(' ') || null} onClose={onClose}
      footer={<button type="button" className="btn btn-quiet" onClick={() => { onClose(); go('settings', cam.id); }}>Alerts and recording for {cam.name}</button>}>
      {!byGroup.length && <p className="fine">This camera doesn't have any settings Home Assistant can change. Alerts and recording still work.</p>}
      {byGroup.map((g) => (
        <section key={g.id} className="sheet-section">
          <h3>{g.name}</h3>
          {g.items.map((c) => <Control key={c.id} c={c} busy={busy === c.id} send={send} />)}
        </section>
      ))}
    </Sheet>
  );
}

function Control({ c, busy, send }) {
  const [val, setVal] = useState(c.state);
  useEffect(() => { setVal(c.state); }, [c.state]);
  const off = !c.available || busy;
  if (['switch', 'light', 'siren'].includes(c.domain)) {
    return <Toggle label={c.name} checked={c.state === 'on'} disabled={off} onChange={(v) => send(c, v)}
      description={!c.available ? 'Not available right now' : c.domain === 'light' && c.brightness != null ? `${c.brightness}%` : null} />;
  }
  if (c.domain === 'select') {
    return (
      <Field label={c.name} htmlFor={`c-${c.id}`}>
        <select id={`c-${c.id}`} value={c.state} disabled={off} onChange={(e) => send(c, e.target.value)}>
          {!c.options.includes(c.state) && <option value={c.state}>{c.state}</option>}
          {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
    );
  }
  if (c.domain === 'number') {
    return (
      <Field label={`${c.name}${c.unit ? ` (${c.unit})` : ''}`} htmlFor={`c-${c.id}`}>
        <div className="cam-number">
          <input id={`c-${c.id}`} type="range" min={c.min} max={c.max} step={c.step} value={Number(val) || 0} disabled={off}
            onChange={(e) => setVal(e.target.value)} onPointerUp={() => send(c, val)} onKeyUp={() => send(c, val)} />
          <output htmlFor={`c-${c.id}`}>{val}</output>
        </div>
      </Field>
    );
  }
  if (c.domain === 'button') {
    return (
      <div className="toggle-row">
        <label><span className="toggle-label">{c.name}</span></label>
        <button type="button" className="btn btn-quiet btn-small" disabled={off} onClick={() => send(c)}>{busy ? 'Sending…' : 'Press'}</button>
      </div>
    );
  }
  return null;
}

// ---------- activity ----------

function Activity({ state, cameraId, go }) {
  const [items, setItems] = useState(null);
  const [more, setMore] = useState(false);
  const [playing, setPlaying] = useState(null);
  const tz = state?.timeZone || 'UTC';
  const load = useCallback(async (before = null) => {
    const q = new URLSearchParams();
    if (cameraId) q.set('camera', cameraId);
    if (before) q.set('before', String(before));
    const r = await api('GET', `activity?${q}`);
    setItems((cur) => (before ? [...(cur || []), ...r.items] : r.items));
    setMore(r.items.length >= 60);
  }, [cameraId]);
  useEffect(() => { setItems(null); load().catch(() => setItems([])); }, [load]);
  // new movement shows up without a refresh
  const newest = state?.cameras?.map((c) => c.lastMovement?.at || 0).reduce((a, b) => Math.max(a, b), 0);
  useEffect(() => { if (newest) load().catch(() => {}); }, [newest, load]);

  const names = Object.fromEntries((state?.cameras || []).map((c) => [c.id, c.name]));
  return (
    <>
      <div className="page-head"><h2>Activity</h2></div>
      {state?.cameras?.length > 1 && (
        <Chips small label="Camera" value={cameraId || ''} onChange={(v) => go('activity', v || null)}
          options={[{ value: '', label: 'All cameras' }, ...state.cameras.map((c) => ({ value: c.id, label: c.name }))]} />
      )}
      {!items && <p className="fine pad">Loading…</p>}
      {items && !items.length && <p className="fine pad">Nothing yet. Movement, alerts and cameras going offline will show here.</p>}
      <ul className="cam-events">
        {items?.map((e) => (
          <li key={e.id} className={`cam-ev cam-ev-${e.type}`}>
            {e.picture
              ? <button type="button" className="cam-thumb" onClick={() => setPlaying(e)} aria-label={`${e.clip ? 'Play' : 'Show'} ${e.text} at ${names[e.camera] || ''}`}>
                  <img src={`api/cameras/media/${e.camera}/${e.picture}`} alt="" loading="lazy" />
                  {e.clip && <span className="cam-play"><Icon name="play" size={18} /></span>}
                </button>
              : <span className="cam-thumb cam-thumb-none"><Icon name={e.type === 'offline' ? 'offline' : e.type === 'movement' ? 'motion' : 'camera'} size={22} /></span>}
            <div className="cam-ev-text">
              <strong>{e.type === 'note' && !e.camera ? 'Cameras' : names[e.camera] || 'Camera'}</strong>
              <span>{e.text}</span>
              <small>{when(e.at, tz)}{e.alerted ? ' · phones alerted' : ''}{e.clip ? ' · clip saved' : e.picture ? ' · picture saved' : ''}</small>
            </div>
          </li>
        ))}
      </ul>
      {more && <button type="button" className="btn btn-quiet" onClick={() => load(items[items.length - 1].at)}>Show older</button>}
      {playing && (
        <Sheet title={`${names[playing.camera] || 'Camera'}: ${playing.text}`} subtitle={when(playing.at, tz)} onClose={() => setPlaying(null)} wide>
          {playing.clip
            ? <video className="cam-video" src={`api/cameras/media/${playing.camera}/${playing.clip}`} poster={playing.picture ? `api/cameras/media/${playing.camera}/${playing.picture}` : undefined} controls autoPlay playsInline />
            : <img className="cam-video" src={`api/cameras/media/${playing.camera}/${playing.picture}`} alt={playing.text} />}
          <p className="fine">Saved in Home Assistant's media folder (Media → home_control). Kept for {state?.settings?.keepDays || 14} days.</p>
        </Sheet>
      )}
    </>
  );
}

// ---------- settings ----------

function Settings({ state, run, edit, go }) {
  const [targets, setTargets] = useState(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(null);
  useEffect(() => { api('GET', 'notify-targets').then(setTargets).catch(() => setTargets([])); }, [state?.connected]);
  if (!state) return <p className="fine pad">Loading…</p>;
  const s = state.settings;
  const save = (patch) => run(() => api('PUT', 'settings', patch));
  const editing = edit && edit !== 'add' ? state.cameras.find((c) => c.id === edit) : null;
  const move = (i, dir) => {
    const ids = state.cameras.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run(() => api('POST', 'order', { ids })).catch(() => {});
  };
  const phones = targets || [];
  const chosen = new Set(s.notify);
  const toggle = (svc) => save({ notify: chosen.has(svc) ? s.notify.filter((x) => x !== svc) : [...s.notify, svc] }).catch(() => {});
  const test = async () => {
    setTesting(true); setTested(null);
    try { const r = await api('POST', 'test-alert'); setTested(`Sent to ${plural(r.sent, 'phone')}.`); } catch (e) { setTested(e.message); } finally { setTesting(false); }
  };

  return (
    <>
      <div className="page-head settings-head"><h2>Settings</h2></div>
      <HomeSettings />

      <section className="card settings-section" aria-labelledby="cam-list-h">
        <div className="row-between">
          <h3 id="cam-list-h">Cameras</h3>
          <button type="button" className="btn btn-primary" onClick={() => go('settings', 'add')} disabled={!state.candidates.length}><Icon name="plus" size={18} />Add a camera</button>
        </div>
        <p className="fine">Any camera in Home Assistant can be added: its movement sensors and its own settings come with it.</p>
        {!state.cameras.length && <p className="fine">No cameras yet.</p>}
        <ul className="group-list">
          {state.cameras.map((c, i) => (
            <li key={c.id}>
              <div className="group-li-text">
                <strong>{c.name}</strong>
                <span className="fine">
                  {[c.make, c.model].filter(Boolean).join(' ')}{c.make || c.model ? '. ' : ''}
                  Alerts {c.alerts.on ? whenText(c.alerts) : 'off'}; saving clips {whenText(c.record)}.
                </span>
                {!c.online && <span className="warn-text"><Icon name="warn" size={14} /> Offline</span>}
              </div>
              <div className="group-li-actions">
                <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${c.name} up`}><Icon name="up" /></button>
                <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === state.cameras.length - 1} aria-label={`Move ${c.name} down`}><Icon name="down" /></button>
                <button type="button" className="btn btn-quiet" onClick={() => go('settings', c.id)}>Edit</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card settings-section" aria-labelledby="cam-phones-h">
        <h3 id="cam-phones-h">Phones to alert</h3>
        <p className="fine">Movement alerts, and cameras going offline, go to these. Phones with the Home Assistant app are listed first.</p>
        {targets === null && <p className="fine">Looking…</p>}
        {targets && !phones.length && <p className="fine">No phones found. Install the Home Assistant app on a phone and sign in, and it appears here.</p>}
        {phones.length > 0 && (
          <div className="cam-checks">
            {phones.map((p) => (
              <label key={p.service}>
                <input type="checkbox" checked={chosen.has(p.service)} onChange={() => toggle(p.service)} />
                <span>{p.name}</span>
                <small>{p.phone ? 'Home Assistant app' : p.service}</small>
              </label>
            ))}
          </div>
        )}
        <Toggle label="Send a picture with each alert" checked={s.picture} onChange={(v) => save({ picture: v })}
          description="A picture from the camera at the moment of the movement, in the notification itself." />
        <div className="row-between cam-test">
          <button type="button" className="btn btn-quiet" onClick={test} disabled={testing || !s.notify.length}>{testing ? 'Sending…' : 'Send a test alert'}</button>
          {tested && <span className="fine" role="status">{tested}</span>}
        </div>
      </section>

      <section className="card settings-section" aria-labelledby="cam-offline-h">
        <h3 id="cam-offline-h">Offline cameras</h3>
        <Field label="Tell the phones when a camera has been offline for (minutes)" htmlFor="cam-offmin" help="And again when it's back. 0 never tells them. A camera can be left out of these in its own settings.">
          <NumberInput id="cam-offmin" value={s.offlineMinutes} min={0} max={240} onSave={(v) => save({ offlineMinutes: v })} />
        </Field>
      </section>

      <section className="card settings-section" aria-labelledby="cam-rec-h">
        <h3 id="cam-rec-h">Recordings</h3>
        <p className="fine">On movement, a picture and a short clip are saved in Home Assistant's media folder (Media → home_control), and play from Activity. Cameras that don't give Home Assistant a video stream save pictures only.</p>
        <Field label="Keep clips and pictures for (days)" htmlFor="cam-keep">
          <NumberInput id="cam-keep" value={s.keepDays} min={1} max={365} onSave={(v) => save({ keepDays: v })} />
        </Field>
      </section>

      {edit === 'add' && <AddCameras state={state} run={run} onClose={() => go('settings')} />}
      {editing && <CameraEditor cam={editing} run={run} onClose={() => go('settings')} />}
    </>
  );
}

function NumberInput({ id, value, min, max, onSave }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <input id={id} type="number" inputMode="numeric" min={min} max={max} value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (Number(v) !== value) onSave(Number(v)); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

function AddCameras({ state, run, onClose }) {
  const [adding, setAdding] = useState(null);
  const add = async (entity) => {
    setAdding(entity);
    try { await run(() => api('POST', 'cameras', { entity })); } catch { /* shown */ } finally { setAdding(null); }
  };
  return (
    <Sheet title="Add a camera" subtitle="The cameras Home Assistant knows about" onClose={onClose}>
      {!state.candidates.length && <p className="fine">Every camera in Home Assistant is already here. To add another, set it up in Home Assistant first (Settings → Devices and services).</p>}
      <ul className="group-list">
        {state.candidates.map((c) => (
          <li key={c.entity}>
            <div className="group-li-text">
              <strong>{c.name}</strong>
              <span className="fine">{[c.make, c.model].filter(Boolean).join(' ') || c.integration}{c.online ? '' : ' · offline'} · {c.entity}</span>
            </div>
            <div className="group-li-actions">
              <button type="button" className="btn btn-quiet" onClick={() => add(c.entity)} disabled={!!adding}>{adding === c.entity ? 'Adding…' : 'Add'}</button>
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function Schedule({ label, value, onChange, idPrefix }) {
  return (
    <>
      <Field label={label} htmlFor={`${idPrefix}-when`}>
        <select id={`${idPrefix}-when`} value={value.when} onChange={(e) => onChange({ ...value, when: e.target.value })}>
          {WHEN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {['times', 'away_or_times'].includes(value.when) && (
        <div className="field-pair">
          <Field label="From" htmlFor={`${idPrefix}-from`}><input id={`${idPrefix}-from`} type="time" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /></Field>
          <Field label="Until" htmlFor={`${idPrefix}-to`}><input id={`${idPrefix}-to`} type="time" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></Field>
        </div>
      )}
    </>
  );
}

function CameraEditor({ cam, run, onClose }) {
  const [name, setName] = useState(cam.name);
  const [alerts, setAlerts] = useState(cam.alerts);
  const [record, setRecord] = useState(cam.record);
  const [offline, setOffline] = useState(cam.offline);
  const [movement, setMovement] = useState(cam.movement.filter((m) => m.used).map((m) => m.id));
  const [card, setCard] = useState(cam.card);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const allMovement = cam.movement.map((m) => m.id);
  const save = async () => {
    setBusy(true);
    try {
      await run(() => api('PUT', `cameras/${cam.id}`, {
        name, alerts, record, offline, card,
        movement: movement.length === allMovement.length ? null : movement,
      }));
      onClose();
    } catch { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await run(() => api('DELETE', `cameras/${cam.id}`)); onClose(); } catch { setBusy(false); }
  };
  const kindWord = { person: 'Person', vehicle: 'Vehicle', animal: 'Animal', visitor: 'Doorbell', package: 'Package', sound: 'Sound', movement: 'Movement' };
  return (
    <Sheet title={`Edit ${cam.name}`} subtitle={[cam.make, cam.model].filter(Boolean).join(' ') || cam.entity} onClose={onClose}
      footer={(
        <>
          {confirm
            ? <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>Remove {cam.name}</button>
            : <button type="button" className="btn btn-danger-quiet" onClick={() => setConfirm(true)}><Icon name="trash" size={18} />Remove</button>}
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>Save</button>
        </>
      )}>
      <Field label="Name" htmlFor="cam-name"><input id="cam-name" type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></Field>

      <section className="sheet-section">
        <h3>Movement that counts</h3>
        {!cam.movement.length && <p className="fine">Home Assistant has no movement sensors for this camera, so it can't alert or record on movement. Its own app may still do so.</p>}
        {cam.movement.length > 0 && (
          <div className="cam-checks">
            {cam.movement.map((m) => (
              <label key={m.id}>
                <input type="checkbox" checked={movement.includes(m.id)} onChange={() => setMovement((v) => (v.includes(m.id) ? v.filter((x) => x !== m.id) : [...v, m.id]))} />
                <span>{m.name}</span>
                <small>{kindWord[m.kind]}{m.on ? ' · now' : ''}</small>
              </label>
            ))}
          </div>
        )}
        {cam.movement.length > 1 && <p className="fine">Untick plain motion to be told only about people, vehicles or the doorbell.</p>}
      </section>

      <section className="sheet-section">
        <h3>Alerts</h3>
        <Toggle label="Alert phones on movement" checked={alerts.on} onChange={(v) => setAlerts({ ...alerts, on: v })}
          description="Also on the Cameras page, as the bell." />
        {alerts.on && (
          <>
            <Schedule label="When" idPrefix="al" value={alerts} onChange={setAlerts} />
            <Field label="At most one alert every (minutes)" htmlFor="al-cool" help="Movement keeps being saved in between; this only stops a busy scene sending one alert after another.">
              <input id="al-cool" type="number" inputMode="numeric" min="0" max="120" value={alerts.cooldownMinutes} onChange={(e) => setAlerts({ ...alerts, cooldownMinutes: e.target.value })} />
            </Field>
          </>
        )}
        <Toggle label="Alert when it goes offline" checked={offline} onChange={setOffline} />
      </section>

      <section className="sheet-section">
        <h3>Recording</h3>
        <Schedule label="Save a picture and a clip on movement" idPrefix="rec" value={record} onChange={setRecord} />
        {record.when !== 'never' && (
          <Field label="Clip length (seconds)" htmlFor="rec-len" help="Starts 5 seconds before the movement.">
            <input id="rec-len" type="number" inputMode="numeric" min="5" max="300" value={record.seconds} onChange={(e) => setRecord({ ...record, seconds: e.target.value })} />
          </Field>
        )}
        {!cam.hasStream && <p className="fine">This camera doesn't give Home Assistant a video stream it can save, so only pictures are kept.</p>}
      </section>

      {cam.controls.length > 0 && (
        <section className="sheet-section">
          <h3>On the dashboard card</h3>
          <p className="fine">Up to four of the camera's own settings, to switch from the Home Control card on a dashboard.</p>
          <div className="cam-checks">
            {cam.controls.filter((c) => c.domain !== 'number').map((c) => (
              <label key={c.id}>
                <input type="checkbox" checked={card.includes(c.id)} disabled={!card.includes(c.id) && card.length >= 4}
                  onChange={() => setCard((v) => (v.includes(c.id) ? v.filter((x) => x !== c.id) : [...v, c.id]))} />
                <span>{c.name}</span>
              </label>
            ))}
          </div>
        </section>
      )}
    </Sheet>
  );
}
