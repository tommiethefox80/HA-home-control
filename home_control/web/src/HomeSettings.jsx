// Settings for the whole of Home Control, the General group at the top of the Settings menu in
// every section: which parts it looks after (heating, lighting…), Away automatically, and the
// Dashboard button. Each is its own page in the menu. Changes save as they're made.
import { useCallback, useEffect, useRef, useState } from 'react';

async function homeApi(method = 'GET', body) {
  const r = await fetch('api/house', { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Home Control answered ${r.status}`);
  return data;
}

/** The house settings, kept fresh when they change anywhere on the page. null while loading. */
export function useHome() {
  const [home, setHome] = useState(null);
  const load = useCallback(async () => {
    try { setHome(await homeApi()); } catch { setHome((h) => h || { modules: { heating: true, lighting: true }, failed: true }); }
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('home-changed', load);
    return () => window.removeEventListener('home-changed', load);
  }, [load]);
  return { home, setHome, reload: load };
}

export const MODULES = [
  { id: 'heating', name: 'Heating', what: 'Rooms, radiators and the boiler' },
  { id: 'lighting', name: 'Lighting', what: 'Lights and sockets' },
  { id: 'cameras', name: 'Cameras', what: 'Movement alerts, recording and camera settings', offWhat: 'Turn on to add your cameras: any make Home Assistant knows about' },
  { id: 'wifi', name: 'Wi-Fi', what: 'Access points, networks and who\'s connected', offWhat: 'Turn on to see and switch your UniFi access points and networks' },
];
const OFF = {
  heating: 'Radiators and the boiler go back to their own schedules, and Home Control stops changing them. The Heating pages and settings are hidden, and its dashboard sensors are removed.',
  lighting: 'Lights and sockets stay as they are, and Home Control stops switching them. The Lighting pages and settings are hidden, and its dashboard sensor is removed.',
  cameras: 'No more movement alerts or recordings from Home Control. The cameras keep working as they do in their own apps. The Cameras pages and settings are hidden, and its dashboard sensor is removed.',
  wifi: 'No more scheduled changes to the access points, their lights or the networks: everything stays as it is now. The Wi-Fi pages and settings are hidden, and its dashboard sensor is removed.',
};

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
export const ICON = {
  heating: <svg viewBox="0 0 24 24" {...P}><path d="M12 3c1 3.5 5 5.6 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.2-4.8.3 1.6 1.1 2.6 2.1 3C11 8.7 11.4 5.6 12 3Z" /></svg>,
  cameras: <svg viewBox="0 0 24 24" {...P}><path d="M3 7h12a2 2 0 0 1 2 2v1.5L21 8v8l-4-2.5V15a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" /></svg>,
  lighting: <svg viewBox="0 0 24 24" {...P}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z" /></svg>,
  wifi: <svg viewBox="0 0 24 24" {...P}><path d="M2 8.8a15 15 0 0 1 20 0M5.5 12.4a10 10 0 0 1 13 0M9 15.9a5 5 0 0 1 6 0M12 19.5h.01" /></svg>,
};

const num = (v) => (v === '' || v == null ? null : Number(v));

export const GENERAL = [
  { id: 'parts', label: 'What it looks after' },
  { id: 'presence', label: 'Away automatically' },
  { id: 'dashboard', label: 'Dashboard button' },
];

/** One of the General settings pages: 'parts', 'presence' or 'dashboard'. */
export function HomeSettings({ item = 'parts' }) {
  const { home, setHome } = useHome();
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState(null);
  const [nums, setNums] = useState(null);
  const savedTimer = useRef(null);

  useEffect(() => {
    if (!home || home.failed) return;
    setPath((p) => p ?? home.dashboardPath);
    setNums((n) => n ?? { delayMinutes: home.presence.delayMinutes, nearMiles: home.presence.nearMiles });
  }, [home]);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  if (!home) return null;
  if (home.failed) return <section className="home-set"><p className="home-set-error" role="alert">Couldn't load these settings. Check the app is running, then reload the page.</p></section>;
  const mods = home.modules;
  const onCount = MODULES.filter((m) => mods[m.id]).length;
  const pr = home.presence;

  const put = async (body) => {
    setError(null); setBusy(true);
    try {
      setHome(await homeApi('PUT', body));
      window.dispatchEvent(new Event('home-changed'));
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
      return true;
    } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  };
  const flip = (id, value) => {
    if (!value) { setConfirm(id); return; }
    setConfirm(null);
    put({ modules: { [id]: true } });
  };
  const savePresence = (patch) => put({ presence: { ...pr, ...patch } });
  const allPeople = home.people || [];
  const counted = (id) => !pr.people?.length || pr.people.includes(id);
  const togglePerson = (id) => {
    const all = allPeople.map((p) => p.entity_id);
    const cur = pr.people?.length ? pr.people : all;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    savePresence({ people: next.length === all.length ? [] : next });
  };
  const label = GENERAL.find((g) => g.id === item)?.label || GENERAL[0].label;

  return (
    <section className="home-set" aria-labelledby={item === 'presence' ? 'home-away' : 'home-set-h'}>
      <div className="home-set-head">
        <h2 id={item === 'presence' ? 'home-away' : 'home-set-h'}>{label}</h2>
        <span className="home-set-saved" role="status">{saved ? 'Saved' : ''}</span>
      </div>

      {item === 'parts' && (
        <>
          <p className="home-set-fine">Turn a part off if something else looks after it. Its pages and settings are hidden and it stops controlling those devices. Everything you set up is kept, so you can turn it back on any time and carry on.</p>
          <ul className="home-mods">
            {MODULES.map((m) => {
              const isOn = !!mods[m.id];
              const last = isOn && onCount === 1;
              return (
                <li key={m.id} className={isOn ? 'on' : ''}>
                  <span className="home-mod-icon">{ICON[m.id]}</span>
                  <label htmlFor={`mod-${m.id}`} className="home-mod-text">
                    <strong>{m.name}</strong>
                    <small>{last ? `${m.what}. Home Control needs at least one part on.` : isOn ? m.what : m.offWhat ? `Off. ${m.offWhat}.` : `Off. ${m.what} are looked after elsewhere.`}</small>
                  </label>
                  <span className="home-sw">
                    <input id={`mod-${m.id}`} type="checkbox" role="switch" checked={isOn} disabled={busy || last}
                      onChange={(e) => flip(m.id, e.target.checked)} />
                    <span className="home-sw-track" aria-hidden="true" />
                  </span>
                </li>
              );
            })}
          </ul>
          {confirm && (
            <div className="home-confirm" role="alertdialog" aria-labelledby="home-confirm-t">
              <p id="home-confirm-t"><strong>Turn off {MODULES.find((m) => m.id === confirm).name.toLowerCase()}?</strong> {OFF[confirm]}</p>
              <div className="home-confirm-actions">
                <button type="button" className="home-btn-plain" onClick={() => setConfirm(null)}>Cancel</button>
                <button type="button" className="home-btn-strong" disabled={busy}
                  onClick={async () => { if (await put({ modules: { [confirm]: false } })) setConfirm(null); }}>
                  Turn off {MODULES.find((m) => m.id === confirm).name.toLowerCase()}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {item === 'dashboard' && (
        <label className="home-field">
          <span>Dashboard to go back to</span>
          <small>Where the Dashboard button at the top left takes you: the address after your Home Assistant URL, e.g. <code>/lovelace/0</code> or <code>/dashboard-home</code>. Leave as <code>/</code> for your default dashboard.</small>
          <input value={path ?? ''} placeholder="/" onChange={(e) => setPath(e.target.value)}
            onBlur={() => { if (path !== home.dashboardPath) put({ dashboardPath: path || '/' }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </label>
      )}

      {item === 'presence' && (
        <>
          <label className="home-toggle">
            <span className="home-sw">
              <input type="checkbox" role="switch" checked={!!pr.enabled} disabled={busy} onChange={(e) => savePresence({ enabled: e.target.checked })} />
              <span className="home-sw-track" aria-hidden="true" />
            </span>
            <span>
              <strong>Use phone locations</strong>
              <small>When everyone below has been out for a while, the house goes to Away{mods.heating && mods.lighting ? ': the heating and the lights' : ''}{mods.cameras ? '. Camera alerts set to "when everyone\'s out" follow it' : ''}. When someone is home or on their way back, it goes back to Schedules. A mode you pick by hand always wins.</small>
            </span>
          </label>
          {pr.enabled && (
            <>
              <div className="home-field">
                <span>People</span>
                {allPeople.length ? (
                  <div className="home-people">
                    {allPeople.map((p) => (
                      <label key={p.entity_id}>
                        <input type="checkbox" checked={counted(p.entity_id)} disabled={busy} onChange={() => togglePerson(p.entity_id)} />
                        {p.name}
                        <small>{p.home ? 'Home' : p.miles != null ? `${p.miles} miles away` : p.state.replace(/_/g, ' ')}</small>
                      </label>
                    ))}
                  </div>
                ) : <small>No people found. Add them in Home Assistant under Settings → People, with the Home Assistant app on their phone sharing location.</small>}
              </div>
              {nums && (
                <div className="home-pair">
                  <label className="home-field">
                    <span>Everyone out for (minutes)</span>
                    <input type="number" step="5" min="0" max="240" inputMode="numeric" value={nums.delayMinutes ?? ''}
                      onChange={(e) => setNums({ ...nums, delayMinutes: e.target.value })}
                      onBlur={() => { if (num(nums.delayMinutes) !== pr.delayMinutes) savePresence({ delayMinutes: num(nums.delayMinutes) }); }} />
                  </label>
                  <label className="home-field">
                    <span>Back on within (miles)</span>
                    <input type="number" step="0.5" min="0.2" max="50" inputMode="decimal" value={nums.nearMiles ?? ''}
                      onChange={(e) => setNums({ ...nums, nearMiles: e.target.value })}
                      onBlur={() => { if (num(nums.nearMiles) !== pr.nearMiles) savePresence({ nearMiles: num(nums.nearMiles) }); }} />
                  </label>
                </div>
              )}
            </>
          )}
        </>
      )}
      {error && <p className="home-set-error" role="alert">{error}</p>}
    </section>
  );
}
