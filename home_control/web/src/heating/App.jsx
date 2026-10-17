import { useCallback, useEffect, useState } from 'react';
import { api, useLiveState, fmtTime, relTime, deg, goToHA, thermal, minutesLeft } from './lib.js';
import { Icon, Sheet } from './ui.jsx';
import Rooms from './Rooms.jsx';
import Schedules from './Schedules.jsx';
import Settings from './Settings.jsx';
import { useToday, SideCards, TodayChart } from './Today.jsx';
import { BoostSheet } from './Boost.jsx';
import Insights from './Insights.jsx';

function useHashRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => { setRoute(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function BoilerChip({ state }) {
  const b = state.boiler;
  if (!b.entity) return <a className="boiler" href="#/settings/boiler">Choose your boiler in Settings</a>;
  const calling = state.zones.filter((z) => z.calling).map((z) => z.name);
  if (!b.available) return <span className="boiler"><Icon.flame />Boiler control offline</span>;
  return (
    <span className={`boiler${b.on ? ' on' : ''}`} role="status">
      <Icon.flame />
      {b.on ? (calling.length ? `Boiler on for ${list(calling)}${b.until ? ` until about ${fmtTime(b.until, state.timeZone)}` : ''}` : 'Boiler finishing its minimum run')
        : `Boiler resting${b.next ? `, next on about ${fmtTime(b.next.at, state.timeZone)}` : ''}`}
    </span>
  );
}
const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

function AwaySheet({ onClose, onPick, lights }) {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(16, 0, 0, 0);
  const [custom, setCustom] = useState(() => new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  return (
    <Sheet onClose={onClose} label="Away">
      <h2>Away</h2>
      <p className="lede">Every room drops to the away temperature{lights ? ' and the lights go to Away too' : ''}. Schedules pick up again when you return.</p>
      <div className="choice-row">
        <button className="chip" onClick={() => onPick(null)}>Until I switch it back</button>
        <button className="chip" onClick={() => onPick(tomorrow.getTime())}>Until 16:00 tomorrow</button>
      </div>
      <h3>Until a date</h3>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input className="field" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)}
          style={{ border: '1px solid var(--line)', background: 'var(--panel-2)', borderRadius: 10, padding: '9px 12px', margin: 0 }} />
        <button className="btn primary" onClick={() => onPick(new Date(custom).getTime())}>Go away until then</button>
      </div>
    </Sheet>
  );
}

function ModeBar({ state, notify }) {
  const [away, setAway] = useState(false);
  const [boost, setBoost] = useState(false);
  const hb = state.houseBoost;
  const stopBoost = async () => {
    try { await api('boost', 'DELETE'); notify('Boost stopped, rooms back to what they were doing'); } catch (e) { notify(e.message, true); }
  };
  const setMode = async (mode, until) => {
    try { await api('mode', 'POST', { mode, until }); notify({ auto: 'Back on schedules', away: 'Away mode on', off: 'Heating off, frost protection only' }[mode]); }
    catch (e) { notify(e.message, true); }
  };
  const m = state.mode;
  return (
    <>
      <div className="modes" role="group" aria-label="Whole-house mode">
        <button aria-pressed={m === 'auto'} onClick={() => setMode('auto')}>Schedules</button>
        <button aria-pressed={m === 'away'} onClick={() => setAway(true)}>Away</button>
        <button aria-pressed={m === 'off'} onClick={() => setMode('off')}>Off</button>
        <button className={`boost-btn${hb ? ' on' : ''}`} style={hb ? { '--heat': thermal(hb.temp) } : undefined}
          aria-label={hb ? `House boost running, ${minutesLeft(hb.until)} left. Open boost options` : 'Boost the house'} onClick={() => setBoost(true)}>
          <Icon.flame />{hb ? <span className="num">{minutesLeft(hb.until).replace(' min', 'm').replace(' h ', 'h ')}</span> : 'Boost'}
        </button>
      </div>
      {hb && (
        <p className="mode-note">
          Boosting {hb.zones.length === state.zones.filter((z) => z.enabled).length ? 'the house' : `${hb.zones.length} room${hb.zones.length === 1 ? '' : 's'}`} to {deg(hb.temp)} until {fmtTime(hb.until, state.timeZone)}. Rooms go back to what they were doing afterwards.{' '}
          <button className="btn link" onClick={stopBoost}>Stop boost</button>
        </p>
      )}
      {m === 'away' && <p className="mode-note">Away at {deg(state.settings.awayTemp)}{state.presence?.auto ? ', switched on automatically because everyone is out. It switches back when someone is on their way home.' : state.awayUntil ? ` until ${fmtTime(state.awayUntil, state.timeZone, true)}.` : state.awayBack === 'home' ? ' until someone\'s home (from the phone alert).' : state.awayBack === 'near' ? ' until someone\'s nearly home (from the phone alert).' : ' until you switch back.'}</p>}
      {m === 'off' && <p className="mode-note">Heating off. Rooms are kept above {deg(state.settings.frostTemp)} to stop pipes freezing.</p>}
      {boost && <BoostSheet state={state} onClose={() => setBoost(false)} notify={notify} />}
      {away && <AwaySheet lights={state.lighting?.groups > 0 && !state.lighting.paused} onClose={() => setAway(false)} onPick={(until) => { setAway(false); setMode('away', until); }} />}
    </>
  );
}

// Some notices can be dismissed (a room losing heat faster than usual): hidden until it's back to normal
function Attention({ items, notify }) {
  const [busy, setBusy] = useState(null);
  if (!items?.length) return null;
  const dismiss = async (a) => {
    setBusy(a.key);
    try { await api(`${a.dismiss}/dismiss`, 'POST'); notify(`Hidden until ${a.room || 'it'} is back to normal`); }
    catch (e) { notify(e.message, true); }
    setBusy(null);
  };
  return (
    <section className="attention" aria-label="Needs attention">
      <h2><Icon.alert />Needs attention</h2>
      <ul>
        {items.map((a) => (
          <li key={a.key}>
            {a.text}
            {a.dismiss && (
              <button type="button" className="btn link att-dismiss" disabled={busy === a.key} onClick={() => dismiss(a)}
                title="Hide this until the room is back to its usual. It shows again if it starts losing heat faster after that.">Dismiss</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// recent entries as "5 min ago"; older ones as "Sat 18:02", then "10 Oct 18:02"
function when(ms, tz) {
  const age = Date.now() - ms;
  if (age < 86400000) return relTime(ms);
  const opts = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(age < 6 * 86400000 ? { weekday: 'short' } : { day: 'numeric', month: 'short' }) };
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
}

// Activity's filter: heat-ups (the boiler and each room starting and stopping) or everything else
const isHeat = (l) => l.kind === 'room' || l.kind === 'boiler' || /^Boiler (ON|OFF)/.test(l.msg);
const SHOW = [['all', 'Everything'], ['heat', 'Heating on and off'], ['changes', 'Changes']];

function Activity({ state }) {
  const [older, setOlder] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [show, setShow] = useState('all');
  if (!state.log.length) return <div className="empty"><h2>Nothing yet</h2><p>Boiler starts, schedule changes and boosts will appear here.</p></div>;
  const lastLive = state.log[state.log.length - 1].at;
  const all = [...state.log, ...older.filter((o) => o.at < lastLive)];
  const total = state.logTotal ?? state.log.length;
  const days = state.settings.retention?.activityDays ?? 30;
  const more = async () => {
    setBusy(true);
    try {
      const d = await api(`log?before=${all[all.length - 1].at}&limit=100`);
      setOlder((o) => [...o, ...d.entries]);
      if (d.entries.length < 100) setDone(true);
    } catch { /* leave the button for another try */ } finally { setBusy(false); }
  };
  const shown = show === 'all' ? all : all.filter((l) => (show === 'heat') === isHeat(l));
  return (
    <>
      <div className="seg log-filter" role="group" aria-label="Show">
        {SHOW.map(([id, label]) => <button key={id} type="button" aria-pressed={show === id} onClick={() => setShow(id)}>{label}</button>)}
      </div>
      {shown.length === 0 && <p className="mode-note">Nothing like that in the {all.length} latest entries.</p>}
      <ul className="log">
        {shown.map((l, i) => (
          <li key={`${l.at}-${i}`}><time dateTime={new Date(l.at).toISOString()} title={new Date(l.at).toLocaleString('en-GB')}>{when(l.at, state.timeZone)}</time><span>{l.msg}</span></li>
        ))}
      </ul>
      <div className="log-foot">
        {!done && all.length < total && <button className="btn" disabled={busy} onClick={more}>{busy ? 'Loading…' : 'Show older'}</button>}
        <small>{show === 'all' ? `Showing ${all.length} of ${total}.` : `${shown.length} of the latest ${all.length} entries${all.length < total ? ` (of ${total})` : ''}.`} The app keeps {days} day{days === 1 ? '' : 's'} of activity; change that in <a href="#/settings/history">Settings → History</a>.</small>
      </div>
    </>
  );
}

const TABS = [
  ['', 'Rooms', Icon.rooms],
  ['schedules', 'Schedules', Icon.calendar],
  ['insights', 'Insights', Icon.chart],
  ['activity', 'Activity', Icon.list],
  ['settings', 'Settings', Icon.cog],
];

export default function App({ active = true, switcher }) {
  const [state, , error] = useLiveState();
  const route = useHashRoute();
  const [toast, setToast] = useState(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);

  const notify = useCallback((msg, err) => {
    setToast({ msg, err });
    clearTimeout(notify.t);
    notify.t = setTimeout(() => setToast(null), 3200);
  }, []);

  const page = route[0] || '';
  const [today, todayError] = useToday(active && page === '' && !!state);
  const title = { '': 'Heating', schedules: 'Heating schedules', insights: 'Heating insights', activity: 'Heating activity', settings: 'Heating settings' }[page] || 'Heating';
  if (!active) return null;

  return (
    <>
      <main className="app">
        <header className="top home-top">
          <div className="home-top-l">
            <button className="home-btn" onClick={() => goToHA(state?.settings?.dashboardPath || '/')} aria-label="Back to Home Assistant dashboard"><Icon.home /><span>Dashboard</span></button>
          </div>
          <h1 className="sr-only">{title}</h1>
          {switcher?.({ heatOn: !!state?.boiler?.on, lightOn: (state?.lighting?.on || 0) > 0 })}
          <div className="home-top-r">{state && <BoilerChip state={state} />}</div>
        </header>

        {!state && !error && <p className="mode-note">Loading your rooms…</p>}
        {!state && error && <div className="banner">Can’t reach the heating service: {error}. Check the add-on is running.</div>}
        {state && !state.haConnected && <div className="banner">Can’t reach Home Assistant right now. Rooms will update when it’s back.</div>}

        {state && page === '' && (
          <>
            <ModeBar state={state} notify={notify} />
            <Attention items={state.attention} notify={notify} />
            <div className="home-layout">
              <div className="home-main"><Rooms state={state} notify={notify} today={today} /></div>
              {state.zones.length > 0 && <aside className="home-side"><SideCards state={state} today={today} /></aside>}
            </div>
            {state.zones.length > 0 && <TodayChart state={state} today={today} error={todayError} />}
          </>
        )}
        {state && page === 'schedules' && <Schedules state={state} zoneId={route[1]} notify={notify} />}
        {state && page === 'activity' && <Activity state={state} />}
        {state && page === 'insights' && <Insights state={state} />}
        {state && page === 'settings' && <Settings state={state} notify={notify} focus={route[1]} />}
      </main>

      <nav className="tabs" aria-label="Sections">
        {TABS.map(([path, label, I]) => (
          <a key={label} href={`#/${path}`} aria-current={page === path ? 'page' : undefined}><I />{label}</a>
        ))}
      </nav>
      {toast && <div className={`toast${toast.err ? ' err' : ''}`} role="status">{toast.msg}</div>}
    </>
  );
}
