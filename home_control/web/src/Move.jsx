// Moving in from the Home Control that was installed by hand (a "local" app).
//
// The page runs inside Home Assistant, so it can ask Home Assistant (as the signed-in admin) to
// back the old app up, stop it and restart this one. This app reads the old app's data out of
// that backup, so everything comes across exactly: rooms, schedules, boiler and settings,
// lighting groups, scenes and schedules, Activity and history.
import { useCallback, useEffect, useState } from 'react';
import { hcFetch } from './net.js';

export function hass() {
  try {
    if (window.parent === window) return null;
    const h = window.parent.document.querySelector('home-assistant')?.hass;
    return h?.callWS ? h : null;
  } catch { return null; }
}
const sup = (endpoint, method = 'get', data) => hass().callWS({ type: 'supervisor/api', endpoint, method, ...(data ? { data } : {}), timeout: null });
const plainError = (e) => String(e?.message || e?.error || (typeof e === 'string' ? e : 'Home Assistant said no')).replace(/[.\s]+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function local(path, method = 'GET', body) {
  const r = await hcFetch(path, { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Home Control answered ${r.status}`);
  return data;
}
export const moveStatus = () => local('api/move');

/** This app's state for moving in: null while checking. */
export function useMove() {
  const [status, setStatus] = useState(null);
  const load = useCallback(async () => {
    try { setStatus(await moveStatus()); } catch { setStatus({ empty: false }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { status, reload: load };
}

/** The Home Control installed by hand, if there is one and this app has nothing set up yet. */
export function useOldHome(status) {
  const [old, setOld] = useState(undefined); // undefined: checking, null: none
  useEffect(() => {
    if (!status) return;
    if (!status.empty || !hass()) { setOld(null); return; }
    (async () => {
      try {
        const list = await sup('/addons');
        const addons = list?.addons || (Array.isArray(list) ? list : []);
        const mine = status.slug;
        // the copy installed by hand is a local app: local_heating_control
        const hit = addons.find((a) => /^local_(heating|home)_control$/.test(a.slug) && a.slug !== mine);
        if (!hit) { setOld(null); return; }
        const info = await sup(`/addons/${hit.slug}/info`);
        setOld({ slug: hit.slug, name: info.name || hit.name, version: info.version || hit.version, state: info.state, boot: info.boot, watchdog: !!info.watchdog });
      } catch { setOld(null); } // not an admin, or no Supervisor: nothing to offer
    })();
  }, [status]);
  return old;
}

/** This app's own slug, to restart it: the server knows it; otherwise find the app serving this page. */
async function mySlug(status, old) {
  if (status.slug) return status.slug;
  const list = await sup('/addons');
  const addons = (list?.addons || []).filter((a) => a.slug !== old.slug && /(^|_)home_control$/.test(a.slug));
  for (const a of addons) {
    const info = await sup(`/addons/${a.slug}/info`);
    if (info.ingress_url && window.location.pathname.startsWith(info.ingress_url)) return a.slug;
  }
  if (addons.length === 1) return addons[0].slug;
  throw new Error('Couldn\'t work out which app this is');
}

const STEPS = [
  ['backup', 'Backing up your current Home Control'],
  ['copy', 'Copying everything across'],
  ['stop', 'Stopping the current Home Control'],
  ['restart', 'Restarting Home Control here'],
  ['wait', 'Starting up with everything'],
];

export function MoveScreen({ status, old }) {
  const [step, setStep] = useState(null);
  const [error, setError] = useState(null);
  const [got, setGot] = useState(null);
  const busy = step && !error;

  const go = async () => {
    setError(null);
    let stage = 'backup';
    let stopped = false;
    try {
      setStep('backup');
      const b = await sup('/backups/new/partial', 'post', {
        name: `Home Control ${old.version || ''} before moving`.replace(/\s+/g, ' '),
        addons: [old.slug], homeassistant: false, location: null,
      });
      if (!b?.slug) throw new Error('Home Assistant didn\'t say which backup it made');

      stage = 'copy'; setStep('copy');
      const meta = await local('api/move', 'POST', { from: old.slug, backup: b.slug });
      setGot(meta.summary);

      stage = 'stop'; setStep('stop');
      await sup(`/addons/${old.slug}/stop`, 'post');
      stopped = true;
      // keep it from starting with Home Assistant, and take it out of the sidebar
      await sup(`/addons/${old.slug}/options`, 'post', { boot: 'manual', ingress_panel: false }).catch(() => {});

      stage = 'restart'; setStep('restart');
      const me = await mySlug(status, old);
      // this app takes the old one's place in the sidebar (and its watchdog, if it had it on)
      await sup(`/addons/${me}/options`, 'post', { ingress_panel: true, ...(old.watchdog ? { watchdog: true } : {}) }).catch(() => {});
      // the restart can cut this request off, so an error only counts if the app never restarts
      let restartErr = null;
      await sup(`/addons/${me}/restart`, 'post').catch((e) => { restartErr = e; });

      setStep('wait');
      const t0 = Date.now();
      for (;;) {
        await sleep(2000);
        let s = null;
        try { s = await moveStatus(); } catch { /* starting up */ }
        if (s?.moved && !s.empty) { window.location.reload(); return; }
        if (s?.staged && restartErr && Date.now() - t0 > 15000) throw restartErr; // it never restarted
        if (Date.now() - t0 > 300000) {
          stage = 'wait';
          throw new Error('Home Control is taking a long time to start. Open it again from the sidebar in a minute');
        }
      }
    } catch (e) {
      const msg = plainError(e);
      // anything before this app restarted: put everything back as it was
      if (stage !== 'wait') {
        await local('api/move', 'DELETE').catch(() => {});
        if (stopped) {
          await sup(`/addons/${old.slug}/options`, 'post', { boot: old.boot || 'auto', ingress_panel: true }).catch(() => {});
          await sup(`/addons/${old.slug}/start`, 'post').catch(() => {});
        }
        setError(`${msg}. Nothing has changed${stopped ? ': your current Home Control is running again' : ''}.`);
      } else setError(msg);
    }
  };

  const at = STEPS.findIndex(([k]) => k === step);
  return (
    <main className="app move">
      <header className="top"><h1>Home Control</h1></header>
      <section className="section move-card" aria-labelledby="move-h">
        <h2 id="move-h">Bring everything across</h2>
        <p>
          This is the new Home Control, installed from your GitHub repository, so updates are now a press of
          Update. Your current Home Control{old.version ? ` (${old.version})` : ''} is still running the house.
        </p>
        <p>
          One press moves everything here: rooms, schedules, boiler and settings; lighting groups, schedules and
          scenes; and Activity and history.
        </p>
        <ol className="move-what">
          <li>A backup of your current Home Control is made first. It stays in Settings → System → Backups.</li>
          <li>Everything is copied here.</li>
          <li>The current Home Control is stopped. It won't start with Home Assistant again and leaves the sidebar.</li>
          <li>This app restarts and takes over. Your dashboard card opens this app from then on.</li>
        </ol>
        <p className="hint">It takes about a minute. Radiators go back to their own schedules for a moment while it switches over, as they do when the app restarts.</p>

        {step && (
          <ol className="move-steps" aria-live="polite">
            {STEPS.map(([k, text], i) => (
              <li key={k} className={i < at ? 'mv-done' : i === at ? (error ? 'mv-failed' : 'mv-now') : ''}>
                {text}{k === 'copy' && got && i < at ? `: ${summary(got)}` : ''}
              </li>
            ))}
          </ol>
        )}
        {error && <div className="banner" role="alert">{error}</div>}
        <div className="actions">
          <button type="button" className="btn primary" onClick={go} disabled={!!busy}>{busy ? 'Moving…' : error ? 'Try again' : 'Move everything here'}</button>
        </div>
      </section>
    </main>
  );
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const and = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
function summary(s) {
  const bits = [];
  if (s.rooms) bits.push(plural(s.rooms, 'room'));
  if (s.groups) bits.push(plural(s.groups, 'lighting group'));
  if (s.scenes) bits.push(plural(s.scenes, 'scene'));
  return bits.length ? bits.join(', ') : 'settings';
}

// ---------- after moving: point dashboard links at this app ----------

function repoint(node, from, to) {
  let n = 0;
  const fix = (s) => (s === from || s.startsWith(`${from}?`) || s.startsWith(`${from}/`) || s.startsWith(`${from}#`) ? (n++, to + s.slice(from.length)) : s);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return typeof v === 'string' ? fix(v) : v;
  };
  const out = walk(node);
  return { out, n };
}

async function repointDashboards(from, to) {
  const h = hass();
  const list = await h.callWS({ type: 'lovelace/dashboards/list' });
  const boards = [{ url_path: null, title: 'Overview', mode: 'storage' }, ...(list || [])];
  const res = { changed: 0, dashboards: [], skipped: [] };
  for (const d of boards) {
    let config;
    try { config = await h.callWS({ type: 'lovelace/config', ...(d.url_path ? { url_path: d.url_path } : {}) }); } catch { continue; } // not set up, or generated
    if (!config || config.strategy) continue;
    const { out, n } = repoint(config, from, to);
    if (!n) continue;
    if (d.mode === 'yaml') { res.skipped.push(d.title || d.url_path); continue; }
    try {
      await h.callWS({ type: 'lovelace/config/save', config: out, ...(d.url_path ? { url_path: d.url_path } : {}) });
      res.changed += n;
      res.dashboards.push(d.title || d.url_path || 'Overview');
    } catch { res.skipped.push(d.title || d.url_path); }
  }
  return res;
}

/** Shown once after moving in, on both pages. Also finishes the move: dashboard links. */
export function MovedBanner({ status, onDone }) {
  const m = status?.moved;
  const [links, setLinks] = useState(m?.links || null);
  useEffect(() => {
    if (!m || m.dismissed || m.links || !status.panel || !hass()) return;
    const from = `/${m.from}`;
    if (from === status.panel) return;
    repointDashboards(from, status.panel)
      .then(async (r) => { setLinks(r); await local('api/move/links', 'POST', r).catch(() => {}); })
      .catch(() => {});
  }, [m, status?.panel]);
  if (!m || m.dismissed) return null;
  const s = m.summary || {};
  const card = status.card || {};
  return (
    <div className="moved" role="status">
      <div className="moved-in">
        <p><strong>Everything's here.</strong> Moved in from your old Home Control{m.fromVersion ? ` ${m.fromVersion}` : ''}: {summary(s)}, with Activity and history.</p>
        <p>
          The old app is stopped and out of the sidebar, and its backup is in Settings → System → Backups.
          {links?.changed ? ` ${plural(links.changed, 'link')} on ${and(links.dashboards)} now ${links.changed === 1 ? 'opens' : 'open'} here.` : ''}
          {links?.skipped?.length ? ` ${and(links.skipped)} still ${links.skipped.length === 1 ? 'has links' : 'have links'} to the old app, to change by hand.` : ''}
          {' '}When you're happy, you can uninstall the old Home Control.
        </p>
        {card.restartNeeded && <p>Restart Home Assistant once so the dashboard card can load (Settings → System → Restart).</p>}
        {card.resource === 'yaml' && <p>Your dashboards' resources are set in YAML: point the Home Control card at <code>{card.url}</code>.</p>}
      </div>
      <button type="button" className="moved-ok" onClick={async () => { await local('api/move/dismiss', 'POST').catch(() => {}); onDone?.(); }}>Done</button>
    </div>
  );
}
