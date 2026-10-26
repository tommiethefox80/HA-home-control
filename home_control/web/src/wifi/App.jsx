// Wi-Fi: the access points, networks and who's connected, from Home Assistant's UniFi Network
// integration; switch networks and access points off and on, the access points' lights off at
// night, and a network on only at set times.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon, Sheet, Toggle, Field, Notice, Chips } from '../lighting/ui.jsx';
import { goDashboard, plural, joinNames } from '../lighting/lib.js';
import { SettingsFrame, settingsPage } from '../SettingsFrame.jsx';
import { api, useLiveState, when, upFor, scheduleText, statusOf } from './lib.js';

const TABS = [
  { id: 'aps', label: 'Access points', short: 'APs', icon: 'ap' },
  { id: 'networks', label: 'Networks', icon: 'wifi' },
  { id: 'devices', label: 'Devices', icon: 'phone' },
  { id: 'activity', label: 'Activity', icon: 'list' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

function useHashRoute() {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, '').replace(/^wifi\/?/, '');
    const [tab, ...rest] = h.split('/');
    return { tab: TABS.some((t) => t.id === tab) ? tab : 'aps', arg: rest.join('/') || null };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((tab, arg) => { window.location.hash = `#/wifi/${tab === 'aps' ? '' : tab}${arg ? `/${arg}` : ''}`; }, []);
  return [route, go];
}

function statusChip(state) {
  if (!state) return { text: 'Connecting', tone: 'quiet' };
  if (!state.connected) return { text: 'Not connected to Home Assistant', tone: 'warn' };
  if (!state.unifi) return { text: 'No UniFi network found', tone: 'quiet' };
  const down = state.aps.filter((a) => !a.online && !a.switchedOff).map((a) => a.name);
  if (down.length) return { text: `${joinNames(down)} offline`, tone: 'warn' };
  const n = state.clients.filter((c) => c.connected).length;
  return { text: `${plural(n, 'device')} connected`, tone: 'quiet' };
}

export function App({ active = true, switcher }) {
  const { state, link, replace } = useLiveState();
  const [route, go] = useHashRoute();
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    try {
      const res = await fn();
      replace(res);
      setError(null);
      return res;
    } catch (err) { setError(err.message); throw err; }
  }, [replace]);

  if (!active) return null;
  const chip = statusChip(state);
  return (
    <div className="app wifi-app">
      <header className="top home-top">
        <div className="home-top-l">
          <button type="button" className="btn btn-quiet dash-btn" onClick={() => goDashboard(state?.dashboardPath || '/')}>
            <Icon name="home" /><span>Dashboard</span>
          </button>
        </div>
        <h1 className="sr-only">{`Wi-Fi: ${TABS.find((t) => t.id === route.tab)?.label}`}</h1>
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
        {state?.away?.off?.length > 0 && route.tab !== 'settings' && (
          <Notice tone="info">Away: {joinNames(state.away.off)} {state.away.off.length === 1 ? 'is' : 'are'} switched off until someone's back.</Notice>
        )}
        {state && !state.unifi && route.tab !== 'settings' && route.tab !== 'activity' && <NoUnifi state={state} />}
        {route.tab === 'aps' && <AccessPoints state={state} run={run} go={go} />}
        {route.tab === 'networks' && <Networks state={state} run={run} />}
        {route.tab === 'devices' && <Devices state={state} run={run} filter={route.arg} go={go} />}
        {route.tab === 'activity' && <Activity state={state} />}
        {route.tab === 'settings' && <Settings state={state} run={run} arg={route.arg} />}
      </main>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a key={t.id} href={`#/wifi/${t.id === 'aps' ? '' : t.id}`} className={route.tab === t.id ? 'tab tab-on' : 'tab'} aria-current={route.tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} /><span className="tab-long">{t.label}</span>{t.short && <span className="tab-short" aria-hidden="true">{t.short}</span>}
          </a>
        ))}
      </nav>
    </div>
  );
}

function NoUnifi({ state }) {
  return (
    <div className="card empty wifi-empty">
      <Icon name="wifi" size={32} />
      <h2>No UniFi network in Home Assistant</h2>
      <p className="fine">The Wi-Fi pages use Home Assistant's UniFi Network integration. Add it in Home Assistant (Settings → Devices &amp; services → Add integration → UniFi Network), signing in with a local admin account on your UniFi console, and your access points and networks appear here.</p>
      {state.clients.length > 0 && <p className="fine">Meanwhile, the Devices page lists what Home Assistant's other router integrations can see.</p>}
    </div>
  );
}

// ---------- access points ----------

function Confirm({ title, children, yes, danger, onYes, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={title} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy}
          onClick={async () => { setBusy(true); try { await onYes(); onClose(); } catch { setBusy(false); } }}>{busy ? 'Working…' : yes}</button>
      </>}>
      {children}
    </Sheet>
  );
}

function AccessPoints({ state, run, go }) {
  const [ask, setAsk] = useState(null);
  if (!state) return <p className="fine pad">Loading…</p>;
  if (!state.unifi) return null;
  const aps = state.aps;
  const leds = [...aps, ...state.others].filter((d) => d.led?.available);
  const anyOn = leds.some((d) => d.led.on);
  const connected = state.clients.filter((c) => c.connected).length;
  const L = state.settings.leds;
  const allLeds = (on) => run(() => api('POST', 'leds', { on })).catch(() => {});
  const restartText = (d) => (d.wifi
    ? `Devices on ${d.name} drop off for a minute or two while it restarts, and move to another access point if they can.`
    : `Everything plugged into ${d.name} loses its connection for a minute or two while it restarts.`);
  return (
    <>
      <p className="fine wifi-lead">
        {state.disabled ? 'Wi-Fi is turned off in Settings → Home Control: shown, but nothing is switched on a schedule.'
          : `${plural(aps.filter((a) => a.online).length, 'access point')} online, ${plural(connected, 'device')} connected.`}
        {L.mode === 'off_between' ? ` Status lights off ${L.from}–${L.to}.` : <> <a href="#/wifi/settings/leds">Turn the status lights off at night</a>.</>}
      </p>
      {leds.length > 0 && (
        <div className="wifi-quick">
          <button type="button" className={`cam-chip${!anyOn ? ' cam-chip-on' : ''}`} onClick={() => allLeds(false)} disabled={!anyOn}><Icon name="led" size={18} /><span>All lights off</span></button>
          <button type="button" className="cam-chip" onClick={() => allLeds(true)} disabled={leds.every((d) => d.led.on)}><Icon name="led" size={18} /><span>All lights on</span></button>
        </div>
      )}
      {!aps.length && <p className="fine pad">No access points found. If one's listed under other devices below, mark it as an access point in Settings.</p>}
      <div className="wifi-grid">
        {aps.map((d) => <ApCard key={d.id} d={d} state={state} run={run} go={go} ask={setAsk} restartText={restartText} />)}
      </div>

      {state.others.length > 0 && (
        <section className="card wifi-others" aria-labelledby="wifi-others-h">
          <h2 id="wifi-others-h">Other network devices</h2>
          <ul className="group-list">
            {state.others.map((d) => {
              const st = statusOf(d);
              return (
                <li key={d.id}>
                  <div className="group-li-text">
                    <strong><Icon name="netbox" size={16} /> {d.name}</strong>
                    <span className="fine">{[d.modelName !== d.name ? d.modelName : null, upFor(d.upSince) && d.online ? `Up ${upFor(d.upSince)}` : null, d.temperature != null ? `${d.temperature}°C` : null, d.update ? 'firmware update available' : null].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="group-li-actions">
                    <span className={`wifi-pill wifi-pill-${st.tone}`}>{st.text}</span>
                    {d.led && <LedChip d={d} run={run} />}
                    {d.restart && <button type="button" className="icon-btn" disabled={!d.online} onClick={() => setAsk({ kind: 'restart', d })} aria-label={`Restart ${d.name}`} title="Restart"><Icon name="restart" /></button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {ask?.kind === 'restart' && (
        <Confirm title={`Restart ${ask.d.name}?`} yes="Restart" onClose={() => setAsk(null)} onYes={() => run(() => api('POST', `devices/${ask.d.id}/restart`))}>
          <p>{restartText(ask.d)}</p>
        </Confirm>
      )}
      {ask?.kind === 'power' && (
        <Confirm title={`Switch ${ask.d.name} off?`} yes="Switch off" danger onClose={() => setAsk(null)} onYes={() => run(() => api('POST', `devices/${ask.d.id}/power`, { on: false }))}>
          <p>Home Control turns off {ask.d.power.name}, the PoE port it's plugged into. {ask.d.clients ? `The ${plural(ask.d.clients, 'device')} on it move to another access point if they can.` : ''}</p>
          <p className="fine">If this page reaches you through {ask.d.name}, you'll lose it until you're on another access point. Switching it back on takes a few minutes while it starts up.</p>
        </Confirm>
      )}
    </>
  );
}

function LedChip({ d, run }) {
  const [busy, setBusy] = useState(false);
  const flip = async () => { setBusy(true); try { await run(() => api('POST', `devices/${d.id}/led`, { on: !d.led.on })); } catch { /* shown */ } finally { setBusy(false); } };
  return (
    <button type="button" className={`cam-chip wifi-led${d.led.on ? ' wifi-led-on' : ''}`} aria-pressed={d.led.on} disabled={!d.led.available || busy} onClick={flip}
      title={d.led.on ? 'Status light on. Press to turn it off.' : 'Status light off. Press to turn it on.'}>
      <Icon name="led" size={18} /><span>{d.led.on ? 'Light on' : 'Light off'}</span>
    </button>
  );
}

function ApCard({ d, state, run, go, ask }) {
  const st = statusOf(d);
  const powerSched = scheduleText(d.power ? d.schedule : null, { offWord: 'off' });
  const lineBits = [
    d.online && upFor(d.upSince) ? `Up ${upFor(d.upSince)}` : null,
    d.ledScheduled ? `light off ${state.settings.leds.from}–${state.settings.leds.to}` : null,
    powerSched ? `${powerSched.toLowerCase()}` : null,
  ].filter(Boolean);
  return (
    <article className={`card wifi-ap${d.online ? '' : ' wifi-ap-off'}`} aria-label={d.name}>
      <div className="wifi-ap-head">
        <span className="wifi-ap-icon"><Icon name="ap" size={26} /></span>
        <div className="wifi-ap-title">
          <h2>{d.name}</h2>
          <span className="fine">{d.modelName}</span>
        </div>
        <span className={`wifi-pill wifi-pill-${st.tone}`}>{st.text}</span>
      </div>
      <button type="button" className="wifi-count" onClick={() => go('devices', `ap-${d.id}`)} disabled={!d.online}>
        <strong>{d.online ? d.clients : '–'}</strong>
        <span>{d.online ? (d.clients === 1 ? 'device connected' : 'devices connected') : d.switchedOff ? 'switched off here' : 'not connected'}</span>
      </button>
      {state.settings.clients?.aps && d.online && (
        <ClientList list={state.clients.filter((c) => c.connected && c.apMac === d.mac)} total={d.clients}
          detail={(c) => [c.network, c.band].filter(Boolean).join(' · ')} label={`Devices on ${d.name}`} />
      )}
      {lineBits.length > 0 && <p className="fine wifi-ap-line">{lineBits.join(' · ')}</p>}
      {d.update && <p className="fine wifi-ap-line"><Icon name="restart" size={14} /> Firmware {d.update === 'available' ? 'update' : d.update} available (install it from the UniFi app or Home Assistant)</p>}
      <div className="cam-actions">
        {d.led && <LedChip d={d} run={run} />}
        {d.power && (d.switchedOff
          ? <button type="button" className="cam-chip cam-chip-on" onClick={() => run(() => api('POST', `devices/${d.id}/power`, { on: true })).catch(() => {})} disabled={!d.power.available}><Icon name="power" size={18} /><span>Switch on</span></button>
          : <button type="button" className="cam-chip" onClick={() => ask({ kind: 'power', d })} disabled={!d.power.available}><Icon name="power" size={18} /><span>Switch off</span></button>)}
        {d.restart && <button type="button" className="cam-chip" onClick={() => ask({ kind: 'restart', d })} disabled={!d.online}><Icon name="restart" size={18} /><span>Restart</span></button>}
      </div>
    </article>
  );
}

/** The devices connected to an access point or a network, a few at a time. */
function ClientList({ list, total, detail, label }) {
  const SHOW = 6;
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => [...list].sort((a, b) => a.name.localeCompare(b.name)), [list]);
  // the access point's or network's own count can include devices Home Assistant isn't tracking
  const untracked = Math.max(0, (total ?? list.length) - list.length);
  if (!list.length && !untracked) return <p className="fine wifi-cl-none">Nothing connected right now.</p>;
  const shown = all ? sorted : sorted.slice(0, SHOW);
  return (
    <div className="wifi-cl">
      {list.length > 0 && (
        <ul aria-label={label}>
          {shown.map((c) => (
            <li key={c.id} title={[c.name, c.network, c.ap, c.band, c.ip, c.maker].filter(Boolean).join(' · ')}>
              <Icon name={c.wired ? 'plug' : 'phone'} size={16} />
              <span className="wifi-cl-name">{c.name}{c.guest && <span className="wifi-tag">Guest</span>}</span>
              <span className="wifi-cl-detail">{detail(c)}</span>
            </li>
          ))}
        </ul>
      )}
      {(list.length > SHOW || untracked > 0) && (
        <div className="wifi-cl-foot">
          {list.length > SHOW && <button type="button" className="wifi-linkbtn" onClick={() => setAll(!all)} aria-expanded={all}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
          {untracked > 0 && <span className="fine">{list.length ? 'and ' : ''}{plural(untracked, list.length ? 'more' : 'device', list.length ? 'more' : 'devices')} not tracked in Home Assistant (<a href="#/wifi/devices">track them</a>)</span>}
        </div>
      )}
    </div>
  );
}

// ---------- networks ----------

function Networks({ state, run }) {
  const [ask, setAsk] = useState(null);
  const [qr, setQr] = useState(null);
  if (!state) return <p className="fine pad">Loading…</p>;
  if (!state.unifi) return null;
  const nets = state.networks;
  if (!nets.length) return <p className="fine pad">No Wi-Fi networks found in Home Assistant's UniFi Network integration.</p>;
  const flip = (n) => (n.on ? setAsk(n) : run(() => api('POST', `networks/${n.id}/power`, { on: true })).catch(() => {}));
  return (
    <>
      <p className="fine wifi-lead">Your Wi-Fi networks. Switching one off takes it off every access point; devices on it drop off until it's back.</p>
      <div className="wifi-grid">
        {nets.map((n) => {
          const sched = scheduleText(n.schedule);
          return (
            <article key={n.id} className={`card wifi-net${n.on ? '' : ' wifi-net-off'}`} aria-label={n.name}>
              <div className="wifi-ap-head">
                <span className="wifi-ap-icon"><Icon name="wifi" size={24} /></span>
                <div className="wifi-ap-title">
                  <h2>{n.name}</h2>
                  <span className="fine">{n.on ? plural(n.clients, 'device') : 'Off'}{sched ? ` · ${sched}` : ''}</span>
                </div>
                <button type="button" role="switch" aria-checked={n.on} className="switch" disabled={!n.available || state.disabled}
                  aria-label={`${n.name} ${n.on ? 'on' : 'off'}`} onClick={() => flip(n)}><span /></button>
              </div>
              {state.settings.clients?.networks && n.on && (
                <ClientList list={state.clients.filter((c) => c.connected && c.network === n.name)} total={n.clients}
                  detail={(c) => [c.ap, c.band].filter(Boolean).join(' · ')} label={`Devices on ${n.name}`} />
              )}
              <div className="cam-actions">
                <a className="cam-chip" href={`#/wifi/devices/net-${encodeURIComponent(n.name)}`}><Icon name="phone" size={18} /><span>Who's on it</span></a>
                {n.qr && <button type="button" className="cam-chip" onClick={() => setQr(n.id)}><Icon name="qr" size={18} /><span>QR code to join</span></button>}
              </div>
            </article>
          );
        })}
      </div>
      {ask && (
        <Confirm title={`Turn ${ask.name} off?`} yes="Turn off" danger onClose={() => setAsk(null)} onYes={() => run(() => api('POST', `networks/${ask.id}/power`, { on: false }))}>
          <p>{ask.clients ? `${plural(ask.clients, 'device')} on ${ask.name} drop off` : `Nothing's on ${ask.name} right now, and it stops being available`} until it's turned back on.</p>
          <p className="fine">If this page reaches you over {ask.name}, you'll lose it. Turn the network back on from another network, the UniFi app or Home Assistant.</p>
        </Confirm>
      )}
      {qr && <QrSheet net={nets.find((n) => n.id === qr)} onClose={() => setQr(null)} />}
    </>
  );
}

function QrSheet({ net, onClose }) {
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState(null);
  const [stamp, setStamp] = useState(Date.now());
  const ready = net?.qr?.enabled;
  useEffect(() => { if (ready) setStamp(Date.now()); }, [ready]);
  if (!net) return null;
  const turnOn = async () => {
    setError(null); setAsked(true);
    try { await api('POST', `networks/${net.id}/qr`); } catch (e) { setError(e.message); setAsked(false); }
  };
  return (
    <Sheet title={`Join ${net.name}`} subtitle="Point a phone's camera at the code" onClose={onClose}>
      {ready ? (
        <div className="wifi-qr">
          <img src={`api/wifi/networks/${net.id}/qr.png?t=${stamp}`} alt={`QR code to join ${net.name}`} />
          <p className="fine">The code holds the network's name and password, so share it with people you'd give the password to.</p>
        </div>
      ) : (
        <>
          <p>Home Assistant can show a QR code for joining {net.name}, but its UniFi Network integration keeps that turned off to start with.</p>
          {net.qr.byUser
            ? <p className="fine">It was turned off by hand in Home Assistant. Turn it on there: Settings → Devices &amp; services → UniFi Network → entities → {net.name} QR Code.</p>
            : asked
              ? <p className="fine" role="status">Asked Home Assistant to turn it on. The code appears here within a minute.</p>
              : <button type="button" className="btn btn-primary" onClick={turnOn}><Icon name="qr" size={18} />Turn on the QR code</button>}
          {error && <p className="fine warn-text">{error}</p>}
        </>
      )}
    </Sheet>
  );
}

// ---------- devices (who's connected) ----------

function Devices({ state, run, filter, go }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [tracking, setTracking] = useState(null);
  const list = useMemo(() => {
    if (!state) return [];
    let l = state.clients;
    if (filter?.startsWith('net-')) { const n = decodeURIComponent(filter.slice(4)); l = l.filter((c) => (n === 'wired' ? c.wired : c.network === n)); }
    if (filter?.startsWith('ap-')) { const ap = state.aps.find((a) => a.id === filter.slice(3)); l = l.filter((c) => ap && c.apMac === ap.mac); }
    if (!all) l = l.filter((c) => c.connected);
    const words = q.trim().toLowerCase();
    if (words) l = l.filter((c) => [c.name, c.ip, c.mac, c.maker, c.host, c.network, c.ap].filter(Boolean).join(' ').toLowerCase().includes(words));
    return l;
  }, [state, filter, all, q]);
  if (!state) return <p className="fine pad">Loading…</p>;
  const tz = state.timeZone;
  const nets = state.networks.map((n) => n.name);
  const hasWired = state.clients.some((c) => c.wired);
  const options = [{ value: '', label: 'Everywhere' }, ...nets.map((n) => ({ value: `net-${encodeURIComponent(n)}`, label: n })), ...(hasWired ? [{ value: 'net-wired', label: 'Wired' }] : []),
    ...state.aps.map((a) => ({ value: `ap-${a.id}`, label: a.name }))];
  const track = async () => {
    setTracking('asking');
    try { const r = await api('POST', 'track-all'); setTracking(`Asked Home Assistant to track ${plural(r.turnedOn, 'more device')}. They appear here within a minute or so.`); } catch (e) { setTracking(e.message); }
  };
  const block = (c, blocked) => run(() => api('POST', 'clients/block', { entity: c.id, blocked })).catch(() => {});
  const anyBlock = state.clients.some((c) => c.block);
  return (
    <>
      <div className="page-head wifi-devhead">
        <h2>Devices</h2>
        <input type="search" className="wifi-search" placeholder="Search name, IP or maker" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search devices" />
      </div>
      <Chips small label="Where" value={filter || ''} onChange={(v) => go('devices', v || null)} options={options} />
      <div className="wifi-filter-row">
        <Chips small label="Which" value={all ? 'all' : 'now'} onChange={(v) => setAll(v === 'all')}
          options={[{ value: 'now', label: `Connected now (${state.clients.filter((c) => c.connected).length})` }, { value: 'all', label: `Everything seen (${state.clients.length})` }]} />
      </div>
      {state.untracked > 0 && (
        <div className="card wifi-untracked">
          <p><strong>{plural(state.untracked, 'more device')} on your network {state.untracked === 1 ? 'isn\'t' : 'aren\'t'} tracked in Home Assistant.</strong> Its UniFi Network integration only tracks devices it already knows about, unless you ask.</p>
          {typeof tracking === 'string' && tracking !== 'asking'
            ? <p className="fine" role="status">{tracking}</p>
            : <button type="button" className="btn btn-quiet" onClick={track} disabled={tracking === 'asking' || state.disabled}><Icon name="plus" size={18} />Track them all</button>}
          <p className="fine">This adds a device tracker for each one to Home Assistant. You can turn any of them off again there.</p>
        </div>
      )}
      {!list.length && <p className="fine pad">{q ? 'Nothing matches that.' : all ? 'No devices yet.' : 'Nothing connected here right now.'}</p>}
      <ul className="wifi-clients">
        {list.map((c) => (
          <li key={c.id} className={c.connected ? '' : 'wifi-client-gone'}>
            <span className="wifi-client-icon"><Icon name={c.wired ? 'plug' : 'phone'} size={20} /></span>
            <div className="wifi-client-text">
              <strong>{c.name}{c.guest && <span className="wifi-tag">Guest</span>}{c.blocked && <span className="wifi-tag wifi-tag-warn">Blocked</span>}</strong>
              <span className="fine">
                {c.connected
                  ? [c.wired ? 'Wired' : c.network, c.ap, c.band, c.ip].filter(Boolean).join(' · ')
                  : `Last seen ${when(c.since, tz)}${c.ip ? ` · ${c.ip}` : ''}`}
              </span>
              {c.maker && <small>{c.maker}</small>}
            </div>
            {c.block && (
              <button type="button" className={`cam-chip${c.blocked ? ' cam-chip-on' : ''}`} onClick={() => block(c, !c.blocked)} disabled={state.disabled}>
                <Icon name="block" size={18} /><span>{c.blocked ? 'Allow' : 'Block'}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {!anyBlock && state.unifi && (
        <p className="fine wifi-foot">To block a device from here, add it to the UniFi Network integration's list of devices to block in Home Assistant (Settings → Devices &amp; services → UniFi Network → Configure); it then gets a Block button here.</p>
      )}
    </>
  );
}

// ---------- activity ----------

function Activity({ state }) {
  const [items, setItems] = useState(null);
  const [more, setMore] = useState(false);
  const load = useCallback(async (before) => {
    const r = await api('GET', `activity${before ? `?before=${before}` : ''}`);
    setItems((cur) => (before ? [...(cur || []), ...r.items] : r.items));
    setMore(r.items.length >= 60);
  }, []);
  const newest = state?.events?.[0]?.at;
  useEffect(() => { load().catch(() => setItems([])); }, [load, newest]);
  const tz = state?.timeZone || 'UTC';
  return (
    <>
      <div className="page-head"><h2>Activity</h2></div>
      {!items && <p className="fine pad">Loading…</p>}
      {items && !items.length && <p className="fine pad">Nothing yet. Changes made here, and by the schedules, show here.</p>}
      <ul className="cam-events">
        {items?.map((e) => (
          <li key={e.id} className={`cam-ev wifi-ev-${e.kind}`}>
            <span className="cam-thumb cam-thumb-none wifi-ev-icon"><Icon name={e.kind === 'schedule' ? 'clock' : e.kind === 'manual' ? 'wifi' : e.kind === 'away' ? 'away' : 'list'} size={20} /></span>
            <div className="cam-ev-text">
              <span>{e.text}</span>
              <small>{when(e.at, tz)}{e.kind === 'schedule' ? ' · schedule' : e.kind === 'manual' ? ' · from here' : e.kind === 'away' ? ' · Away' : ''}</small>
            </div>
          </li>
        ))}
      </ul>
      {more && <button type="button" className="btn btn-quiet" onClick={() => load(items[items.length - 1].at)}>Show older</button>}
    </>
  );
}

// ---------- settings ----------

const NET_MODES = [
  { value: 'none', label: 'Always on (no schedule)' },
  { value: 'off_between', label: 'Off between two times' },
  { value: 'on_between', label: 'On only between two times' },
];

function Times({ id, value, onChange, fromLabel = 'From', toLabel = 'To' }) {
  return (
    <div className="field-pair">
      <Field label={fromLabel} htmlFor={`${id}-from`}><input id={`${id}-from`} type="time" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /></Field>
      <Field label={toLabel} htmlFor={`${id}-to`}><input id={`${id}-to`} type="time" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></Field>
    </div>
  );
}

function Settings({ state, run, arg }) {
  const { item, shown } = settingsPage('wifi', arg);
  const show = (id) => shown === id;
  const [view, setView] = useState(null);
  const [saved, setSaved] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => api('GET', 'settings').then(setView).catch((e) => setErr(e.message)), []);
  // the settings view has the PoE ports; keep it fresh as things change
  const sig = state ? `${state.aps.length}|${state.others.length}|${state.hidden?.length}|${state.networks.length}|${state.events?.[0]?.id}` : '';
  useEffect(() => { load(); }, [load, sig]);
  if (!state || !view) return <SettingsFrame part="wifi" item={item} shown={shown}><p className="fine pad">{err || 'Loading…'}</p></SettingsFrame>;
  const put = async (path, body, what) => {
    setErr(null);
    try { const v = await run(() => api('PUT', path, body)); setView(v); setSaved(what); setTimeout(() => setSaved(null), 2500); } catch (e) { setErr(e.message); }
  };
  const L = view.settings.leds;
  const withLed = view.devices.filter((d) => d.led && !d.hidden);
  const chosen = L.devices == null ? new Set(withLed.map((d) => d.mac)) : new Set(L.devices);
  const toggleLed = (mac) => {
    const next = new Set(chosen);
    if (next.has(mac)) next.delete(mac); else next.add(mac);
    put('settings', { leds: { devices: next.size === withLed.length ? null : [...next] } }, 'leds');
  };
  return (
    <SettingsFrame part="wifi" item={item} shown={shown}>
      {err && <Notice tone="error">{err}</Notice>}

      {show('leds') && <section className="card settings-section" aria-labelledby="wifi-led-h">
        <h3 id="wifi-led-h">Status lights at night {saved === 'leds' && <span className="saved-note" role="status">Saved</span>}</h3>
        <Toggle label="Turn the status lights off at night" checked={L.mode === 'off_between'} onChange={(v) => put('settings', { leds: { mode: v ? 'off_between' : 'none' } }, 'leds')}
          description="The little lights on the access points and switches. They go off at the first time and back on at the second; switching one by hand in between is left alone until the next change." />
        {L.mode === 'off_between' && (
          <>
            <LedTimes value={L} onSave={(v) => put('settings', { leds: { from: v.from, to: v.to } }, 'leds')} />
            {withLed.length > 1 && (
              <div className="cam-checks">
                {withLed.map((d) => (
                  <label key={d.mac}>
                    <input type="checkbox" checked={chosen.has(d.mac)} onChange={() => toggleLed(d.mac)} />
                    <span>{d.name}</span>
                    <small>{d.modelName}</small>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
        {!withLed.length && <p className="fine">None of your UniFi devices has a light Home Assistant can switch.</p>}
      </section>}

      {show('clients') && <section className="card settings-section" aria-labelledby="wifi-cl-h">
        <h3 id="wifi-cl-h">Connected devices {saved === 'clients' && <span className="saved-note" role="status">Saved</span>}</h3>
        <Toggle label="List them on each access point" checked={!!view.settings.clients?.aps} onChange={(v) => put('settings', { clients: { aps: v } }, 'clients')}
          description="The devices on each access point, under its count on the Access points page." />
        <Toggle label="List them on each network" checked={!!view.settings.clients?.networks} onChange={(v) => put('settings', { clients: { networks: v } }, 'clients')}
          description="The devices on each Wi-Fi network, on the Networks page." />
        <Toggle label="List them on the dashboard card too" checked={!!view.settings.clients?.card} onChange={(v) => put('settings', { clients: { card: v } }, 'clients')}
          description="Their names under each access point and network on the Wi-Fi dashboard card (show: wifi)." />
      </section>}

      {show('networks') && <section className="card settings-section" aria-labelledby="wifi-net-h">
        <h3 id="wifi-net-h">Network schedules {saved === 'net' && <span className="saved-note" role="status">Saved</span>}</h3>
        <p className="fine">Switch a network off at night, or have a guest network on only in the day. Changes happen at the times set; switching a network by hand in between is left alone until the next one.</p>
        {!view.networks.length && <p className="fine">No networks found.</p>}
        {view.networks.map((n) => <NetSchedule key={n.id} n={n} onSave={(schedule) => put(`networks/${n.id}`, { schedule }, 'net')}
          onAway={(away) => put(`networks/${n.id}`, { away }, 'net')} />)}
      </section>}

      {show('aps') && <section className="card settings-section" aria-labelledby="wifi-ap-h">
        <h3 id="wifi-ap-h">Access points {saved === 'ap' && <span className="saved-note" role="status">Saved</span>}</h3>
        <p className="fine">An access point can be switched off by turning off the PoE port on the switch it's plugged into (the UniFi Network integration can't switch the access point itself off). Choose the port to switch it off from here, and on a schedule if you like.</p>
        {view.devices.filter((d) => d.wifi).map((d) => <ApSettings key={d.id} d={d} onSave={(body) => put(`devices/${d.id}`, body, 'ap')} />)}
      </section>}

      {show('ports') && <section className="card settings-section" aria-labelledby="wifi-port-h">
        <h3 id="wifi-port-h">PoE ports {saved === 'port' && <span className="saved-note" role="status">Saved</span>}</h3>
        <p className="fine">Switch a PoE port off while the house is on Away, so whatever it powers goes offline (a speaker, a screen, a camera indoors), and back on when someone's back. Not the port another switch, your router or Home Assistant is connected through. Access points are set under <a href="#/wifi/settings/aps">Access points</a>.</p>
        {!view.ports?.length && <p className="fine">No PoE ports found: Home Assistant's UniFi Network integration adds one for each port on a UniFi switch (or gateway) with PoE.</p>}
        {Object.entries((view.ports || []).reduce((m, p) => { (m[p.switchName] ||= []).push(p); return m; }, {})).map(([sw, list]) => (
          <div key={sw} className="wifi-ports">
            <h4>{sw}</h4>
            <ul className="group-list">
              {list.map((p) => <PortRow key={p.entity} p={p} sw={sw} onSave={(body) => put(`ports/${p.entity}`, body, 'port')} />)}
            </ul>
          </div>
        ))}
      </section>}

      {show('kinds') && <section className="card settings-section" aria-labelledby="wifi-kind-h">
        <h3 id="wifi-kind-h">What each device is {saved === 'kind' && <span className="saved-note" role="status">Saved</span>}</h3>
        <p className="fine">Worked out from each device's model. Change it if one's in the wrong place, or hide one.</p>
        <ul className="group-list">
          {view.devices.map((d) => (
            <li key={d.id}>
              <div className="group-li-text"><strong>{d.name}</strong><span className="fine">{d.modelName}{d.model && d.modelName !== d.model ? ` (${d.model})` : ''}</span></div>
              <div className="group-li-actions">
                <select aria-label={`What ${d.name} is`} value={d.hidden ? 'hidden' : d.wifi ? 'ap' : 'other'}
                  onChange={(e) => put(`devices/${d.id}`, { kind: e.target.value === 'ap' ? 'ap' : e.target.value === 'hidden' ? 'hidden' : 'other' }, 'kind')}>
                  <option value="ap">Access point</option>
                  <option value="other">Other network device</option>
                  <option value="hidden">Hidden</option>
                </select>
              </div>
            </li>
          ))}
        </ul>
      </section>}
    </SettingsFrame>
  );
}

function LedTimes({ value, onSave }) {
  const [v, setV] = useState({ from: value.from, to: value.to });
  useEffect(() => { setV({ from: value.from, to: value.to }); }, [value.from, value.to]);
  const dirty = v.from !== value.from || v.to !== value.to;
  return (
    <div className="wifi-times">
      <Times id="wifi-led" value={v} onChange={setV} fromLabel="Off at" toLabel="Back on at" />
      {dirty && <button type="button" className="btn btn-primary" onClick={() => onSave(v)}>Save times</button>}
    </div>
  );
}

function NetSchedule({ n, onSave, onAway }) {
  const [v, setV] = useState(n.schedule);
  useEffect(() => { setV(n.schedule); }, [n.schedule.mode, n.schedule.from, n.schedule.to]);
  const dirty = v.mode !== n.schedule.mode || (v.mode !== 'none' && (v.from !== n.schedule.from || v.to !== n.schedule.to));
  return (
    <div className="wifi-sched">
      <Field label={n.name} htmlFor={`wifi-n-${n.id}`}>
        <select id={`wifi-n-${n.id}`} value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>
          {NET_MODES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {v.mode !== 'none' && <Times id={`wifi-n-${n.id}`} value={v} onChange={setV} fromLabel={v.mode === 'off_between' ? 'Off at' : 'On at'} toLabel={v.mode === 'off_between' ? 'Back on at' : 'Off at'} />}
      {dirty && <button type="button" className="btn btn-primary" onClick={() => onSave(v)}>Save</button>}
      <Toggle label="Off while away" checked={!!n.away} onChange={onAway}
        description={`Turned off when the house goes to Away, and ${n.schedule.mode === 'none' ? 'back on' : 'back to its schedule'} when someone's back. Anything that only connects to ${n.name} goes offline meanwhile.`} />
    </div>
  );
}

function PortRow({ p, sw, onSave }) {
  const [label, setLabel] = useState(p.label);
  useEffect(() => { setLabel(p.label); }, [p.label]);
  // "Port 3", or the name it's been given in Home Assistant if that's something else
  const own = p.name === p.entity ? '' : p.name.replace(new RegExp(`^${sw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').replace(/\s*PoE$/i, '');
  const name = own && !/^port \d+$/i.test(own) ? `Port ${p.port}: ${own}` : `Port ${p.port}`;
  const state = !p.available ? 'unavailable' : p.heldAway ? 'off (Away)' : p.state === 'on' ? 'on' : 'off';
  return (
    <li className="wifi-port">
      <div className="group-li-text">
        <strong>{name}</strong>
        <span className="fine">{p.ap ? `Powers ${p.ap}: set under Access points` : !p.enabled ? 'Turned off in Home Assistant: ticking Off while away turns it on there' : `Power ${state}`}</span>
      </div>
      {!p.ap && (
        <div className="wifi-port-set">
          <input type="text" maxLength={40} placeholder="What's plugged in" aria-label={`What's plugged into ${name}`} value={label}
            onChange={(e) => setLabel(e.target.value)} onBlur={() => { if (label !== p.label) onSave({ label }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          <label className="wifi-port-away">
            <input type="checkbox" checked={p.away} onChange={(e) => onSave({ away: e.target.checked })} />
            <span>Off while away</span>
          </label>
        </div>
      )}
    </li>
  );
}

function ApSettings({ d, onSave }) {
  const [v, setV] = useState(d.schedule);
  useEffect(() => { setV(d.schedule); }, [d.schedule.mode, d.schedule.from, d.schedule.to]);
  const dirty = v.mode !== d.schedule.mode || (v.mode !== 'none' && (v.from !== d.schedule.from || v.to !== d.schedule.to));
  const ports = d.poeChoices;
  const bySwitch = ports.reduce((m, p) => { (m[p.switchName] ||= []).push(p); return m; }, {});
  return (
    <div className="wifi-sched">
      <Field label={`${d.name}: switched off through`} htmlFor={`wifi-p-${d.id}`}
        help={d.power && !d.power.enabled ? 'Home Assistant keeps PoE ports turned off to start with: Home Control has asked it to turn this one on, which takes about a minute.' : ports.length ? null : 'No PoE ports found: switching it off needs a UniFi switch (or gateway) with PoE that powers it.'}>
        <select id={`wifi-p-${d.id}`} value={d.power?.entity || ''} onChange={(e) => onSave({ poe: e.target.value || null })} disabled={!ports.length}>
          <option value="">Not switched off from here</option>
          {Object.entries(bySwitch).map(([sw, list]) => (
            <optgroup key={sw} label={sw}>
              {list.map((p) => <option key={p.entity} value={p.entity}>{p.name.replace(new RegExp(`^${sw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '')}{p.uplink ? ' (it\'s plugged into this switch)' : ''}{p.enabled ? '' : ' – turned off in Home Assistant'}</option>)}
            </optgroup>
          ))}
        </select>
      </Field>
      {d.power && (
        <>
          <Field label="Schedule" htmlFor={`wifi-ps-${d.id}`}>
            <select id={`wifi-ps-${d.id}`} value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>
              <option value="none">No schedule</option>
              <option value="off_between">Off between two times</option>
            </select>
          </Field>
          {v.mode !== 'none' && <Times id={`wifi-ps-${d.id}`} value={v} onChange={setV} fromLabel="Off at" toLabel="Back on at" />}
          {dirty && <button type="button" className="btn btn-primary" onClick={() => onSave({ schedule: v })}>Save</button>}
        </>
      )}
      {d.power && (
        <Toggle label="Off while away" checked={!!d.away} onChange={(away) => onSave({ away })}
          description={`Switched off when the house goes to Away, and ${d.schedule.mode === 'none' ? 'back on' : 'back to its schedule'} when someone's back (it takes a few minutes to start). Anything on Wi-Fi only through ${d.name} goes offline meanwhile: smart plugs, bulbs and cameras, including lights set to look lived in.`} />
      )}
    </div>
  );
}
