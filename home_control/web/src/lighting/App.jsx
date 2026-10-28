import { useCallback, useEffect, useState } from 'react';
import { useLiveState, goDashboard, joinNames, plural, api } from './lib.js';
import { Icon, Segmented, Notice } from './ui.jsx';
import { Lights } from './Lights.jsx';
import { Schedules } from './Schedules.jsx';
import { Activity } from './Activity.jsx';
import { Settings } from './Settings.jsx';
import { SceneRow } from './Scenes.jsx';
import { useOldApp, PausedPanel } from './Import.jsx';
import { Suggestions } from '../Learn.jsx';

const TABS = [
  { id: 'lights', label: 'Lights', icon: 'bulb' },
  { id: 'schedules', label: 'Schedules', icon: 'calendar' },
  { id: 'activity', label: 'Activity', icon: 'list' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

// Lighting lives under #/lighting/… (the heating pages keep the plain #/… addresses)
function useHashRoute() {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, '').replace(/^lighting\/?/, '');
    const [tab, ...rest] = h.split('/');
    return { tab: TABS.some((t) => t.id === tab) ? tab : 'lights', arg: rest.join('/') || null };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((tab, arg) => { window.location.hash = `#/lighting/${tab}${arg ? `/${arg}` : ''}`; }, []);
  return [route, go];
}

// A short Home Assistant restart shouldn't flash a warning at the household.
const DOWN_GRACE = 30000;

// Away is one switch for the whole house, shared with the heating.
function houseText(state) {
  const h = state.house;
  if (!h) return '';
  const out = [h.heatingMode === 'off' ? 'The heating is off, so Away only changes the lights.' : 'Away here puts the heating on Away too.'];
  const p = h.presence;
  if (p?.enabled) {
    if (p.home.length) out.push(`It switches by itself when everyone's out (${joinNames(p.home)} ${p.home.length === 1 ? 'is' : 'are'} home).`);
    else if (state.mode === 'away') out.push('Back to Schedules as soon as someone is on their way home.');
    else out.push('Everyone is out, so Away starts soon unless Schedules was picked by hand.');
  }
  return ` ${out.join(' ')}`;
}

function statusChip(state) {
  if (!state) return { text: 'Connecting', tone: 'quiet' };
  if (!state.connected) return state.downFor > DOWN_GRACE ? { text: 'Not connected to Home Assistant', tone: 'warn' } : { text: 'Connecting to Home Assistant', tone: 'quiet' };
  const { onIn } = state.stats;
  if (!state.groups.length) return { text: 'No groups yet', tone: 'quiet' };
  const on = state.groups.flatMap((g) => g.devices).filter((d) => d.on);
  if (!on.length) return { text: 'Everything is off', tone: 'quiet' };
  const lights = on.filter((d) => d.kind === 'light').length;
  const sockets = on.length - lights;
  const what = [lights && plural(lights, 'light'), sockets && plural(sockets, 'socket')].filter(Boolean).join(' and ');
  return { text: `${what} on in ${joinNames(onIn)}`, tone: 'on' };
}

export function App({ active = true, switcher }) {
  const { state, link, replace } = useLiveState();
  const [route, go] = useHashRoute();
  const [error, setError] = useState(null);
  const old = useOldApp();

  const run = useCallback(async (fn) => {
    try {
      const res = await fn();
      if (res?.groups && res?.stats) replace(res);
      setError(null);
      return res;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }, [replace]);

  if (!active) return null;
  const chip = statusChip(state);
  const mode = state?.mode || 'schedule';
  const anyOn = !!state?.groups?.some((g) => g.devices.some((d) => d.on));

  return (
    <div className="app">
      <header className="top home-top">
        <div className="home-top-l">
          <button type="button" className="btn btn-quiet dash-btn" onClick={() => goDashboard(state?.house?.dashboardPath || state?.settings?.dashboardPath || '/')}>
            <Icon name="home" /><span>Dashboard</span>
          </button>
        </div>
        <h1 className="sr-only">{{ lights: 'Lighting', schedules: 'Lighting schedules', activity: 'Lighting activity', settings: 'Lighting settings' }[route.tab]}</h1>
        {switcher?.({ heatOn: !!state?.house?.heatingOn, lightOn: anyOn })}
        <div className="home-top-r">
          <span className={`status-chip status-${chip.tone}`} role="status">
            <span className="status-dot" />{state?.paused ? 'Paused' : chip.text}
          </span>
        </div>
      </header>

      {error && (
        <div className="wrap">
          <Notice tone="error" action={<button type="button" className="btn btn-quiet" onClick={() => setError(null)}>Dismiss</button>}>{error}</Notice>
        </div>
      )}
      {state && !state.connected && state.downFor > DOWN_GRACE && (
        <div className="wrap">
          <Notice tone="warn">
            {state.haError || 'Home Assistant isn\'t answering.'} Lights won't follow their schedules until the app reconnects. It keeps trying by itself every few seconds.
          </Notice>
        </div>
      )}
      {link === 'down' && (
        <div className="wrap"><Notice tone="warn">Lost touch with the Home app. Retrying every few seconds.</Notice></div>
      )}

      <main className="wrap" id="main">
        {state?.paused && route.tab === 'lights' && <PausedPanel state={state} run={run} old={old} />}
        {state?.paused && route.tab !== 'lights' && (
          <Notice tone="warn">Lighting is paused, so nothing is sent to your lights yet. <a href="#/lighting/lights">Switch over on the Lights page</a>.</Notice>
        )}
        {route.tab === 'lights' && (
          <>
            <div className="modebar">
              <Segmented label="Mode" value={mode}
                onChange={(m) => run(() => api('POST', 'mode', { mode: m }))}
                options={[{ value: 'schedule', label: 'Schedules', icon: 'calendar' }, { value: 'away', label: 'Away', icon: 'away' }]} />
              <p className="mode-help">
                {mode === 'schedule' && 'Lights and sockets follow their schedules. Changes made by hand last until the next scheduled change.'}
                {mode === 'away' && 'Everything stays off, except groups set to look lived in, which come on in the evening (and on dark mornings, if chosen) at slightly different times each day.'}
                {state && houseText(state)}
              </p>
            </div>
            {state && <SceneRow state={state} run={run} />}
            {state && <Suggestions part="lighting" learn={state.learn} notify={(msg, bad) => { if (bad) setError(msg); }} settingsHref="#/lighting/settings/groups" />}
            <Lights state={state} run={run} go={go} old={old} />
          </>
        )}
        {route.tab === 'schedules' && <Schedules state={state} run={run} go={go} groupId={route.arg} />}
        {route.tab === 'activity' && <Activity state={state} />}
        {route.tab === 'settings' && <Settings state={state} run={run} go={go} old={old} arg={route.arg} />}
      </main>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a key={t.id} href={`#/lighting/${t.id}`} className={route.tab === t.id ? 'tab tab-on' : 'tab'} aria-current={route.tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} /><span>{t.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
