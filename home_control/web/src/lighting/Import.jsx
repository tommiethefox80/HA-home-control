// Bringing lights across from the old Lighting Control app, and handing over to this one.
//
// This page runs inside Home Assistant, so it can ask Home Assistant (as the signed-in admin) to
// find the old app, read its groups, schedules and scenes through its own ingress address, and
// stop it. Lighting here stays paused until then, so the two apps never drive the same lights.
import { useCallback, useEffect, useState } from 'react';
import { api, plural } from './lib.js';
import { Icon, Notice } from './ui.jsx';

function hass() {
  try {
    if (window.parent === window) return null;
    const h = window.parent.document.querySelector('home-assistant')?.hass;
    return h?.callWS ? h : null;
  } catch { return null; }
}
const sup = (endpoint, method = 'get', data) => hass().callWS({ type: 'supervisor/api', endpoint, method, ...(data ? { data } : {}), timeout: null });
const plainError = (e) => e?.message || e?.error || (typeof e === 'string' ? e : 'Home Assistant said no');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Finds the old Lighting Control app. status: 'checking' | 'none' | 'found' */
export function useOldApp() {
  const [res, setRes] = useState({ status: hass() ? 'checking' : 'none', app: null });
  const check = useCallback(async () => {
    if (!hass()) { setRes({ status: 'none', app: null }); return null; }
    try {
      const list = await sup('/addons');
      const addons = list?.addons || (Array.isArray(list) ? list : []);
      const hit = addons.find((a) => /(^|_)lighting_control$/.test(a.slug)) || addons.find((a) => a.name === 'Lighting Control');
      if (!hit) { setRes({ status: 'none', app: null }); return null; }
      const info = await sup(`/addons/${hit.slug}/info`);
      const app = { slug: hit.slug, name: info.name || hit.name, state: info.state, boot: info.boot, ingress: info.ingress_url };
      setRes({ status: 'found', app });
      return app;
    } catch {
      // not an admin, or no Supervisor: just don't offer it
      setRes({ status: 'none', app: null });
      return null;
    }
  }, []);
  useEffect(() => { check(); }, [check]);
  return { ...res, check };
}

async function readOldApp(app, onStep) {
  const get = async (path) => {
    const r = await fetch(`${app.ingress}${path}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Lighting Control answered ${r.status}`);
    return r.json();
  };
  if (app.state !== 'started') {
    onStep('Starting Lighting Control for a moment to read your settings…');
    await sup(`/addons/${app.slug}/start`, 'post');
  }
  let last = null;
  for (let i = 0; i < 30; i++) {
    try {
      const cfg = await get('api/config');
      const sch = await get('api/schedules');
      if (!Array.isArray(cfg.groups)) throw new Error('That didn\'t look like Lighting Control');
      return { groups: cfg.groups, schedules: sch.schedules || {}, scenes: cfg.scenes || [], settings: cfg.settings || {} };
    } catch (e) { last = e; await sleep(2000); }
  }
  throw last || new Error('Lighting Control didn\'t answer');
}

/** One button: read everything from the old app and bring it here, paused. */
export function BringAcross({ old, run, again }) {
  const [step, setStep] = useState(null);
  const [error, setError] = useState(null);
  if (old.status !== 'found') return null;
  const go = async () => {
    if (again && !window.confirm('Replace the groups, schedules and scenes here with the ones from Lighting Control?')) return;
    setError(null);
    setStep('Reading your groups, schedules and scenes…');
    try {
      const body = await readOldApp(old.app, setStep);
      setStep('Bringing them across…');
      await run(() => api('POST', 'import', body));
      await old.check();
    } catch (e) {
      setError(plainError(e));
    } finally { setStep(null); }
  };
  return (
    <div className="bring">
      {!again && (
        <>
          <h3>Bring your lights across</h3>
          <p>Lighting Control is installed. Bring its groups, schedules and scenes here in one go, then switch over when you've checked them. Nothing changes on your lights while you do.</p>
        </>
      )}
      {old.app.state !== 'started' && !again && <p className="fine">It's stopped at the moment, so it'll be started for a few seconds to read your settings.</p>}
      <div className="btn-pair">
        <button type="button" className={`btn ${again ? 'btn-quiet' : 'btn-primary'}`} onClick={go} disabled={!!step}>
          <Icon name="copy" size={18} />{step ? 'Working…' : again ? 'Bring across again' : 'Bring them across'}
        </button>
      </div>
      {step && <p className="fine" role="status">{step}</p>}
      {error && (
        <Notice tone="error">
          Couldn't bring them across: {error}. You can add your groups again from Settings instead; Home Assistant areas make it quick.
        </Notice>
      )}
    </div>
  );
}

/** While lighting is paused: what's been brought across, and the switch-over. */
export function PausedPanel({ state, run, old }) {
  const [step, setStep] = useState(null);
  const [error, setError] = useState(null);
  const running = old.status === 'found' && old.app.state === 'started';
  const canStop = old.status === 'found';
  const groups = state.groups.length;
  const scenes = (state.scenes || []).length;

  const switchOver = async () => {
    setError(null);
    try {
      if (running) {
        setStep('Stopping Lighting Control…');
        await sup(`/addons/${old.app.slug}/stop`, 'post');
      }
      if (canStop && old.app.boot !== 'manual') {
        // so it doesn't come back after a restart
        try { await sup(`/addons/${old.app.slug}/options`, 'post', { boot: 'manual' }); } catch { /* not essential */ }
      }
      setStep('Starting lighting here…');
      await run(() => api('POST', 'paused', { paused: false }));
      old.check();
    } catch (e) {
      setError(plainError(e));
    } finally { setStep(null); }
  };

  return (
    <section className="card paused" aria-labelledby="paused-h">
      <div className="paused-head">
        <Icon name="pause" size={22} />
        <h2 id="paused-h">Lighting is paused</h2>
      </div>
      <p>
        {groups ? `${plural(groups, 'group')}${scenes ? ` and ${plural(scenes, 'scene')}` : ''} brought across from Lighting Control. ` : ''}
        Nothing is sent to your lights until you switch over, so the two apps don't fight.
        {' '}Check the groups and schedules look right, then switch over. Nothing changes on your lights when you do: each group carries on as it is until its next scheduled change.
      </p>
      {canStop && running && <p className="fine">This stops the Lighting Control app and stops it starting again after a restart. You can uninstall it later.</p>}
      {canStop && !running && <p className="fine">Lighting Control is already stopped.</p>}
      {!canStop && <p className="fine">First stop the Lighting Control app in Home Assistant (Settings, then Apps or Add-ons, then Lighting Control, then Stop), so the two don't both drive your lights.</p>}
      <div className="btn-pair">
        <button type="button" className="btn btn-primary" onClick={switchOver} disabled={!!step}>
          <Icon name="power" size={18} />{step || (running ? 'Stop Lighting Control and start here' : 'Start lighting here')}
        </button>
      </div>
      {error && <Notice tone="error">That didn't work: {error}. Stop Lighting Control yourself from Home Assistant's settings, then press Start lighting here.</Notice>}
    </section>
  );
}

/** Settings: the old app, if it's still installed. */
export function OldAppSettings({ old, run, paused }) {
  if (old.status !== 'found') return null;
  const running = old.app.state === 'started';
  return (
    <section className="card settings-section" aria-labelledby="set-old">
      <h3 id="set-old">Lighting Control app</h3>
      {running && !paused && (
        <Notice tone="warn">The old Lighting Control app is still running. Both apps will try to drive the same lights. Stop it in Home Assistant's settings.</Notice>
      )}
      {!running && <p className="fine">The old Lighting Control app is installed but stopped. Once you're happy with lighting here, you can uninstall it from Home Assistant's settings.</p>}
      {running && paused && <p className="fine">Lighting here is paused until you switch over on the Lights page.</p>}
      <p className="fine">Bringing across again replaces the groups, schedules and scenes here with Lighting Control's.</p>
      <BringAcross old={old} run={run} again />
    </section>
  );
}
