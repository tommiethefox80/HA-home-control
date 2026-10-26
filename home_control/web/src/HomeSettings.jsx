// Settings for the whole of Home Control, the General group at the top of the Settings menu in
// every section: which parts it looks after (heating, lighting…), Away (what it does, and switching
// to it from phone locations), the Dashboard button and Home Assistant entities. Each is its own page in the menu. Changes save as they're made.
import { useCallback, useEffect, useRef, useState } from 'react';
import { hcFetch } from './net.js';

async function homeApi(method = 'GET', body) {
  const r = await hcFetch('api/house', { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
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
  { id: 'energy', name: 'Energy', what: 'Prices, today\'s cost, the car, and running things at the cheapest time', offWhat: 'Turn on to see your electricity prices and costs (Octopus, or Home Assistant\'s Energy dashboard)' },
];
const OFF = {
  heating: 'Radiators and the boiler go back to their own schedules, and Home Control stops changing them. The Heating pages and settings are hidden, and its dashboard sensors are removed.',
  lighting: 'Lights and sockets stay as they are, and Home Control stops switching them. The Lighting pages and settings are hidden, and its dashboard sensor is removed.',
  cameras: 'No more movement alerts or recordings from Home Control. The cameras keep working as they do in their own apps. The Cameras pages and settings are hidden, and its dashboard sensor is removed.',
  wifi: 'No more scheduled changes to the access points, their lights or the networks: everything stays as it is now. The Wi-Fi pages and settings are hidden, and its dashboard sensor is removed.',
  energy: 'Plans stop switching things on at the cheapest time, and the phones aren\'t told about prices. The car charges as Octopus plans. The Energy pages and settings are hidden, and its dashboard sensor is removed.',
};

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
export const ICON = {
  heating: <svg viewBox="0 0 24 24" {...P}><path d="M12 3c1 3.5 5 5.6 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.2-4.8.3 1.6 1.1 2.6 2.1 3C11 8.7 11.4 5.6 12 3Z" /></svg>,
  cameras: <svg viewBox="0 0 24 24" {...P}><path d="M3 7h12a2 2 0 0 1 2 2v1.5L21 8v8l-4-2.5V15a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" /></svg>,
  lighting: <svg viewBox="0 0 24 24" {...P}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z" /></svg>,
  wifi: <svg viewBox="0 0 24 24" {...P}><path d="M2 8.8a15 15 0 0 1 20 0M5.5 12.4a10 10 0 0 1 13 0M9 15.9a5 5 0 0 1 6 0M12 19.5h.01" /></svg>,
  energy: <svg viewBox="0 0 24 24" {...P}><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" /></svg>,
};

const num = (v) => (v === '' || v == null ? null : Number(v));

export const GENERAL = [
  { id: 'parts', label: 'What it looks after' },
  { id: 'presence', label: 'Away' },
  { id: 'dashboard', label: 'Dashboard button' },
  { id: 'entities', label: 'Home Assistant entities' },
];

const deg = (v) => `${Math.round(Number(v) * 10) / 10}°`;
const listOf = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/** What Away does for the whole house: the rooms' temperature and the lived-in lights. A room or a
 *  lighting group can have its own, in its own settings; this says which do. */
function AwayDefaults({ away, busy, put }) {
  const from = (a) => ({ temp: a.heating?.temp ?? '', off: a.lighting?.offTime ?? '23:00', bri: a.lighting?.brightness ?? '' });
  const [v, setV] = useState(() => from(away));
  useEffect(() => { setV(from(away)); }, [away.heating?.temp, away.lighting?.offTime, away.lighting?.brightness]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = away.heating; const l = away.lighting; const w = away.wifi;
  const ownRooms = (h?.rooms || []).filter((r) => r.temp != null);
  const lived = (l?.groups || []).filter((g) => g.livedIn);
  const ownText = (g) => {
    const bits = [g.offTime && `off around ${g.offTime}`, g.brightness != null && `${g.brightness}%`].filter(Boolean);
    return bits.length ? `${g.name} (${bits.join(', ')})` : g.name;
  };
  return (
    <>
      {h && (
        <>
          <h3>Heating</h3>
          <label className="home-field home-narrow">
            <span>Rooms drop to (°C)</span>
            <input type="number" step="0.5" min="5" max="21" inputMode="decimal" value={v.temp} disabled={busy}
              onChange={(e) => setV({ ...v, temp: e.target.value })}
              onBlur={() => { const t = num(v.temp); if (t != null && t !== h.temp) put({ away: { heating: { temp: t } } }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </label>
          <small className="home-after">
            {ownRooms.length
              ? <>{ownRooms.length === h.rooms.length ? 'Every room has its own' : 'With their own'}: {listOf(ownRooms.map((r) => `${r.name} ${deg(r.temp)}`))}. </>
              : 'Every room uses this. '}
            To give a room its own, edit it in <a href="#/settings/rooms">Heating → Rooms</a>.
          </small>
        </>
      )}
      {l && (
        <>
          <h3>Lights</h3>
          <p className="home-set-fine">Lights stay off, except groups set to look lived in: they come on a little after sunset and go off around this time, a bit differently each day (up to 20 minutes either way).</p>
          <div className="home-pair">
            <label className="home-field">
              <span>Go off around</span>
              <input type="time" value={v.off} disabled={busy} onChange={(e) => setV({ ...v, off: e.target.value })}
                onBlur={() => { if (v.off && v.off !== l.offTime) put({ away: { lighting: { offTime: v.off } } }); }} />
            </label>
            <label className="home-field">
              <span>Brightness (%)</span>
              <input type="number" min="1" max="100" inputMode="numeric" value={v.bri} disabled={busy} onChange={(e) => setV({ ...v, bri: e.target.value })}
                onBlur={() => { const b = num(v.bri); if (b != null && b !== l.brightness) put({ away: { lighting: { brightness: b } } }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            </label>
          </div>
          <small className="home-after">
            {lived.length ? <>Looking lived in: {listOf(lived.map(ownText))}. </> : 'No group is set to look lived in yet. '}
            Choose which, and give a group its own time or brightness, by editing it in <a href="#/lighting/settings/groups">Lighting → Groups</a>.
          </small>
        </>
      )}
      {w && (
        <>
          <h3>Wi-Fi</h3>
          <small>
            {w.items.length
              ? <>Switched off while away, and back when someone's back: {listOf(w.items.map((i) => `${i.name}${i.kind === 'network' ? ' (network)' : i.kind === 'ap' && !i.ready ? ' (choose its PoE port)' : ''}`))}. </>
              : 'Nothing is switched off while away. '}
            Choose networks in <a href="#/wifi/settings/networks">Network schedules</a>, access points in <a href="#/wifi/settings/aps">Access points</a> and anything else powered by a PoE port in <a href="#/wifi/settings/ports">PoE ports</a>.
          </small>
        </>
      )}
    </>
  );
}

/** One of the General settings pages: 'parts', 'presence' (Away), 'dashboard' or 'entities'. */
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
  if (item === 'entities') return <EntitySettings label={label} mods={mods} />;

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
          <p className="home-set-fine">One Away for the whole house: the Away button on the Heating or Lighting page, phone locations (below), or the Away switch in Home Assistant all do the same. This is what it does; a room or a lighting group can have its own setting, in its own settings.</p>
          {home.away && <AwayDefaults away={home.away} busy={busy} put={put} />}
          <h3>Away automatically</h3>
          <label className="home-toggle">
            <span className="home-sw">
              <input type="checkbox" role="switch" checked={!!pr.enabled} disabled={busy} onChange={(e) => savePresence({ enabled: e.target.checked })} />
              <span className="home-sw-track" aria-hidden="true" />
            </span>
            <span>
              <strong>Use phone locations</strong>
              <small>When everyone below has been out for a while, the house goes to Away{(() => { const what = [mods.heating && 'the heating', mods.lighting && 'the lights', mods.wifi && home.away?.wifi?.items?.length && 'what Wi-Fi switches off'].filter(Boolean); return what.length > 1 ? `: ${listOf(what)}` : ''; })()}{mods.cameras ? '. Camera alerts set to "when everyone\'s out" follow it' : ''}. When someone is home or on their way back, it goes back to Schedules. A mode you pick by hand always wins.</small>
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


// ---------- groups, rooms, scenes and Away as Home Assistant entities (MQTT discovery) ----------

const KINDS = [
  { id: 'lights', label: 'Each lighting group, as a light', part: 'lighting', eg: 'light.home_control_lounge: on, off, brightness and warmth, as from the Lighting page' },
  { id: 'rooms', label: 'Each heating room, as a thermostat', part: 'heating', eg: 'climate.home_control_lounge: a temperature holds until the room\'s next scheduled change; Off snoozes it until turned back on; Heat puts it back on its schedule' },
  { id: 'scenes', label: 'Each lighting scene', part: 'lighting', eg: 'scene.home_control_film_night' },
  { id: 'away', label: 'Away, for the whole house', part: null, eg: 'switch.home_control_away: on is Away, off is back to the schedules' },
  { id: 'mode', label: 'The heating mode', part: 'heating', eg: 'select.home_control_heating_mode: Schedules, Away or Heating off' },
];

function EntitySettings({ label, mods }) {
  const [v, setV] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const call = useCallback(async (method = 'GET', body) => {
    const r = await hcFetch('api/ha-entities', { method, cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Home Control answered ${r.status}`);
    return data;
  }, []);
  useEffect(() => { call().then(setV).catch((e) => setError(e.message)); }, [call]);
  const put = async (body) => {
    setBusy(true); setError(null);
    try { setV(await call('PUT', body)); setSaved(true); setTimeout(() => setSaved(false), 2500); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const s = v?.settings;
  const kinds = KINDS.filter((k) => !k.part || mods[k.part]);
  return (
    <section className="home-set" aria-labelledby="home-ent-h">
      <div className="home-set-head">
        <h2 id="home-ent-h">{label}</h2>
        <span className="home-set-saved" role="status">{saved ? 'Saved' : ''}</span>
      </div>
      <p className="home-set-fine">Your lighting groups, heating rooms, scenes and Away as real Home Assistant entities, so Alexa or Google ("Alexa, turn off the lounge lights"), Home Assistant automations and any dashboard can use them. Switching one does just what the same button here does, so groups come on at their scheduled level and rooms go back to their schedules.</p>
      {!v && !error && <p className="home-set-fine">Loading…</p>}
      {s && (
        <>
          <label className="home-toggle">
            <span className="home-sw">
              <input type="checkbox" role="switch" checked={!!s.enabled} disabled={busy} onChange={(e) => put({ enabled: e.target.checked })} />
              <span className="home-sw-track" aria-hidden="true" />
            </span>
            <span>
              <strong>Make Home Assistant entities</strong>
              <small>Made with MQTT discovery, through Home Assistant's own MQTT connection: no passwords needed here. Turning this off removes them from Home Assistant.</small>
            </span>
          </label>
          {v.mqtt === false && (
            <div className="home-ent-note" role="note">
              <strong>MQTT isn't set up in Home Assistant yet.</strong>
              <ol>
                <li>Settings → Add-ons → Add-on store → <b>Mosquitto broker</b> → Install, then Start.</li>
                <li>Settings → Devices &amp; services: Home Assistant finds it. Under Discovered, <b>MQTT</b> → Configure → Submit.</li>
                <li>Come back here: the entities are made straight away.</li>
              </ol>
            </div>
          )}
          {s.enabled && (
            <>
              <h3>What to make</h3>
              <ul className="home-mods home-ent-kinds">
                {kinds.map((k) => (
                  <li key={k.id} className={s[k.id] ? 'on' : ''}>
                    <label htmlFor={`ent-${k.id}`} className="home-mod-text"><strong>{k.label}</strong><small>{k.eg}</small></label>
                    <span className="home-sw">
                      <input id={`ent-${k.id}`} type="checkbox" role="switch" checked={!!s[k.id]} disabled={busy} onChange={(e) => put({ [k.id]: e.target.checked })} />
                      <span className="home-sw-track" aria-hidden="true" />
                    </span>
                  </li>
                ))}
              </ul>
              {v.mqtt && v.entities.length > 0 && (
                <>
                  <h3>In Home Assistant now ({v.entities.length})</h3>
                  <ul className="home-ent-list">
                    {v.entities.map((e) => <li key={e.id}><span>{e.name}</span><code>{e.id}</code></li>)}
                  </ul>
                  <small>Each group and room is a device of its own, in the Home Assistant area with the same name if there is one. Renaming one here renames it there. Rename the entities or their IDs in Home Assistant if you like: they keep working, and the IDs shown here follow.</small>
                  <h3>Alexa and Google</h3>
                  <small>With Home Assistant Cloud: Settings → Voice assistants → Expose, and tick the ones to use (they may be exposed already if new entities are). Then "Alexa, discover devices". With your own Alexa skill, add them to its filter. Your real lights stay as they were, so name things so Alexa can tell them apart.</small>
                </>
              )}
              {v.error && <p className="home-set-error" role="alert">Home Assistant said: {v.error}</p>}
            </>
          )}
        </>
      )}
      {error && <p className="home-set-error" role="alert">{error}</p>}
    </section>
  );
}
