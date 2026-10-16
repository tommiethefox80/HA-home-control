import { useEffect, useRef, useState } from 'react';
import { api, thermal, deg, fmtTime, minutesLeft, DAYS, nowLocal } from './lib.js';
import { Icon, Ribbon, Stepper, Sheet } from './ui.jsx';
import DaySpark from './DaySpark.jsx';

// "18:55", "Wed 18:55", or for more than a week ahead "Wed 21 Oct, 18:55"
export function fmtUntil(ms, tz) {
  if (ms - Date.now() < 6 * 86400000) return fmtTime(ms, tz);
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

export function statusLine(z, tz) {
  if (!z.enabled) return <>Not managed by this app</>;
  // a hold, boost or radiator change on a snoozed room hands back to the snooze, not the schedule
  if (z.snoozedUnder && z.source !== 'snooze' && ['boost', 'hold', 'manual'].includes(z.source)) {
    return <>{statusLine({ ...z, snoozedUnder: false }, tz)}, then snoozed again</>;
  }
  const next = z.scheduled?.next;
  const at = (n) => (n ? `${n.day !== nowLocal(tz).day ? `${n.day[0].toUpperCase()}${n.day.slice(1)} ` : ''}${n.time}` : '');
  switch (z.source) {
    case 'boost': return <>Boost to <b>{deg(z.target)}</b>, {minutesLeft(z.until)} left</>;
    case 'preheat': return <>Warming early to reach <b>{deg(z.target)}</b> by {z.readyBy}</>;
    case 'window': return <>Window open? Heating paused until {fmtTime(z.until, tz)}</>;
    case 'hold': return <>Held at <b>{deg(z.target)}</b> until {fmtTime(z.until, tz)}</>;
    case 'manual': return <>Changed on {z.by || 'the radiator'} to <b>{deg(z.target)}</b> until {fmtTime(z.until, tz)}</>;
    case 'snooze': return <>Snoozed at <b>{deg(z.target)}</b> {z.forever ? 'until you turn it back on' : `until ${fmtUntil(z.until, tz)}`}</>;
    case 'away': return <>Away mode, kept at <b>{deg(z.target)}</b></>;
    case 'off': return <>Heating off, frost protection at {deg(z.target)}</>;
    case 'no-schedule': return <>No schedule yet, kept at {deg(z.target)}</>;
    default: return next ? <>On schedule, <b>{deg(next.temp)}</b> from {at(next)}</> : <>On schedule</>;
  }
}

/** A room below its target that isn't heating: when it will, short for the card. */
export function waitLine(z) {
  if (!z.waiting || z.startAt == null) return null;
  return z.coasting
    ? <>Leftover heat should carry it to {deg(z.target)}. Heats again below <b>{deg(z.startAt)}</b></>
    : <>Not heating yet: heats again below <b>{deg(z.startAt)}</b></>;
}

/**
 * When a room next needs heat (so when the boiler fires for it), short for the card. Predicted by
 * the app from how fast the room loses heat, the weather forecast and its schedule.
 */
export function nextLine(z, tz) {
  const n = z.next;
  if (!z.enabled || !n) return waitLine(z);
  const at = n.at ? fmtTime(n.at, tz) : null;
  if (z.calling) return n.until ? <>Heating until about <b>{fmtTime(n.until, tz)}</b>{n.warm ? <>, when it reaches {deg(z.stopAt)}</> : ', when its target drops'}</> : null;
  if (n.withOthers) return <>Warming while the boiler runs for other rooms</>;
  if (z.waiting && (!at || n.reason === 'cooling')) {
    const when = at ? <>, about <b>{at}</b></> : null;
    return z.coasting
      ? <>Leftover heat should carry it to {deg(z.target)}. Heats again below <b>{deg(z.startAt)}</b>{when}</>
      : <>Not heating yet: heats again below <b>{deg(z.startAt)}</b>{when}</>;
  }
  if (!at) return null;
  if (n.reason === 'preheat') return <>Next heat about <b>{at}</b>, to be {deg(n.target)} by {n.readyBy}</>;
  if (n.reason === 'schedule') return <>Next heat <b>{at}</b>, when its schedule goes up to {deg(n.target)}</>;
  if (n.reason === 'change') return <>Next heat about <b>{at}</b>, back to {deg(n.target)}</>;
  return <>Next heat about <b>{at}</b>, once it's cooled to {deg(n.threshold)}</>;
}

/** How the prediction was made, for the room's own page. `out`: the outside temperature now. */
function nextWhy(z, tz, out) {
  const n = z.next;
  if (!z.enabled || !n) return null;
  if (z.calling) {
    if (!n.until) return 'Heating now. Once it has learned how fast it warms, this says when it should be done.';
    return n.warm
      ? `Heating now. At the speed it's learned (about ${deg(z.warmRate)} an hour) it should reach ${deg(z.stopAt)}, where it stops, about ${fmtTime(n.until, tz)}.`
      : `Heating now, until its target drops about ${fmtTime(n.until, tz)}. At the speed it's learned (about ${deg(z.warmRate)} an hour) it should be about ${deg(n.temp)} by then.`;
  }
  if (n.withOthers) return 'Its radiator is always open, so it\'s warming while the boiler runs for the other rooms.';
  const rate = n.k && out != null && z.current > out ? Math.round(n.k * (z.current - out) * 10) / 10 : null;
  const cools = n.k
    ? `${rate != null ? `It's losing about ${deg(rate)} an hour now, with ${deg(out)} outside, a little less as it cools` : 'It cools towards the outside temperature'}${n.basis === 'house' ? ' (going by the house\'s other rooms until its own rate is worked out)' : ''}.`
    : '';
  if (!n.at) return n.k ? `${cools} It shouldn't need heat in the next 24 hours.` : 'Still learning how quickly it cools: a prediction appears once it\'s had some time with the heating off (overnight is ideal).';
  const at = fmtTime(n.at, tz);
  const then = n.temp != null ? ` It should be about ${deg(n.temp)} by then.` : '';
  switch (n.reason) {
    case 'preheat': return `Next heat about ${at}, so it's ${deg(n.target)} by ${n.readyBy}.${then} ${cools}`;
    case 'schedule': return `Next heat at ${at}, when its schedule goes up to ${deg(n.target)}.${then} ${cools}`;
    case 'change': return `Next heat about ${at}, when it goes back to ${deg(n.target)}.${then} ${cools}`;
    default: return `Next heat about ${at}, when it should have cooled to ${deg(n.threshold)}, where it starts heating. ${cools} Sun, cooking or a door left open can move it.`;
  }
}

/** The same, in full, for the room's own page. */
function waitWhy(z) {
  if (!z.waiting || z.startAt == null) return null;
  const early = Math.round((z.target - z.stopAt) * 10) / 10; // as shown: target and stop point both rounded
  const coast = z.coasting && early > 0 ? `Heat stopped at ${deg(z.stopAt)} and the radiators' leftover heat should carry it to ${deg(z.target)}. ` : '';
  const why = z.gapFromStop
    ? `it stops heating ${deg(early)} early${z.stopMode === 'auto' ? ' (learned, because it keeps warming after the heat goes off)' : ''} and starts again a little below that, so the boiler doesn't flick on and off.`
    : `once it's ${deg(z.startGap)} under its target (Settings → Start heating when a room is this far below target), so the boiler doesn't flick on and off.`;
  return `${coast}It heats again below ${deg(z.startAt)}${z.gapFromStop ? ': ' : ' '}${why}`;
}

// a boost, a hold, or a change made on the radiator: anything "Back to schedule" undoes
export const isOverridden = (z) => ['boost', 'hold', 'manual', 'snooze'].includes(z.source);

// what "Back to schedule" returns the room to (Away still applies if the house is in Away)
function backTo(z, state) {
  return state.mode === 'away'
    ? { label: 'Back to Away', temp: state.settings.awayTemp, done: 'back on Away' }
    : { label: 'Back to schedule', temp: z.scheduled?.temp, done: 'back on schedule' };
}

function RoomCard({ z, state, onOpen, notify, today }) {
  const tz = state.timeZone;
  const [pending, setPending] = useState(null);
  const [clearing, setClearing] = useState(false);
  const timer = useRef(null);
  const inflight = useRef(null);
  const target = pending ?? z.target;
  const locked = state.mode === 'off' || !z.enabled;
  const back = backTo(z, state);
  const showBack = !locked && (pending != null || isOverridden(z));

  useEffect(() => { if (pending != null && Math.abs(pending - z.target) < 0.01) setPending(null); }, [z.target, pending]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const nudge = (t) => {
    setPending(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      inflight.current = api(`zones/${z.id}/override`, 'POST', { temp: t, untilNext: true, kind: 'hold' })
        .catch((e) => { setPending(null); notify(e.message, true); })
        .finally(() => { inflight.current = null; });
    }, 900);
  };

  const backToSchedule = async () => {
    clearTimeout(timer.current);
    setClearing(true);
    try {
      if (inflight.current) await inflight.current; // let a hold that's already on its way land first
      await api(`zones/${z.id}/override`, 'DELETE');
      setPending(null);
      notify(`${z.name} is ${back.done}`);
    } catch (e) { notify(e.message, true); }
    finally { setClearing(false); }
  };

  return (
    <article className={`room${z.enabled ? '' : ' disabled'}`} style={{ '--heat': thermal(target) }}>
      <button className="room-name" onClick={onOpen} aria-label={`${z.name}: details and boost`}>
        {z.name}
        {z.calling && <span className="calling"><Icon.flame />Heating</span>}
        <Icon.chev className="chev" />
      </button>
      <div className="now num">
        {deg(z.current)}
        <small>in the room now</small>
      </div>
      {locked ? <div /> : <Stepper value={target} onChange={nudge} label={`${z.name} target`} />}
      <div className="status">
        <span>{pending != null ? <>Holding <b>{deg(pending)}</b> until the next scheduled change</> : statusLine(z, tz)}</span>
        {showBack && (
          <button className="to-schedule" disabled={clearing} onClick={backToSchedule}
            aria-label={`${z.name}: ${back.label}${back.temp != null ? `, ${deg(back.temp)}` : ''}`}>
            <Icon.undo />{back.label}
          </button>
        )}
      </div>
      {pending == null && nextLine(z, tz) && <div className="wait"><Icon.clock /><span>{nextLine(z, tz)}</span></div>}
      {z.warnings.length > 0 && <div className="warn">{z.warnings.join('. ')}</div>}
      {z.enabled && <DaySpark room={today?.rooms?.find((r) => r.id === z.id)} today={today} tz={tz} current={z.current} next={pending == null ? z.next : null} show={state.settings.cards} />}
      <Ribbon schedule={state.schedules[z.id]} day={nowLocal(tz).day} tz={tz} showNow />
    </article>
  );
}

function LockToggle({ lock, name, notify }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try { await api('childlock', 'POST', { entity_id: lock.entity_id, on: !lock.on }); notify(`Child lock ${lock.on ? 'off' : 'on'} for ${name}`); }
    catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  return (
    <label className="lock-toggle">
      <input type="checkbox" role="switch" checked={lock.on} disabled={busy || !lock.available} onChange={toggle} />
      <span>Child lock</span>
    </label>
  );
}

const SNOOZES = [['2 h', 120], ['6 h', 360], ['1 day', 1440], ['2 days', 2880], ['1 week', 10080]];

function SnoozeSection({ z, state, run, busy }) {
  const frost = Number(state.settings.frostTemp) || 7;
  const [temp, setTemp] = useState(z.source === 'snooze' ? z.target : frost);
  const [n, setN] = useState(3);
  const [unit, setUnit] = useState('days');
  const snooze = (body, label) => run(() => api(`zones/${z.id}/override`, 'POST', { kind: 'snooze', temp, ...body }), `${z.name} snoozed ${label}`);
  const custom = Math.round(Number(n) * (unit === 'days' ? 1440 : 60));
  return (
    <>
      <h3>Snooze</h3>
      <p className="lede">
        {z.source === 'snooze'
          ? <>Snoozed {z.forever ? 'until you turn it back on' : `until ${fmtUntil(z.until, state.timeZone)}`}. Pick again to change it, or press Back to schedule.</>
          : <>Ignore the schedule and keep {z.name} cool, say while it's empty. Changing the whole-house mode doesn't end a snooze.</>}
      </p>
      <div className="snooze-temp">
        <span>Keep it at</span>
        <Stepper small value={temp} onChange={setTemp} label="snooze temperature" />
        {temp === frost && <small>frost protection</small>}
      </div>
      <div className="choice-row" style={{ marginTop: 10 }}>
        {SNOOZES.map(([label, mins]) => (
          <button key={mins} className="chip" disabled={busy} onClick={() => snooze({ minutes: mins }, `for ${label}`)}>{label}</button>
        ))}
        <button className="chip" disabled={busy} onClick={() => snooze({ forever: true }, 'until you turn it back on')}>Until I turn it back on</button>
      </div>
      <div className="snooze-custom">
        <span>Or for</span>
        <input type="number" min="1" max={unit === 'days' ? 90 : 2160} value={n} onChange={(e) => setN(e.target.value)} aria-label="How long" />
        <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Hours or days">
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        <button className="btn" disabled={busy || !(custom >= 15)} onClick={() => snooze({ minutes: custom }, `for ${n} ${Number(n) === 1 ? unit.slice(0, -1) : unit}`)}>Snooze</button>
      </div>
    </>
  );
}

function RoomSheet({ z, state, onClose, notify }) {
  const [boostTemp, setBoostTemp] = useState(Math.max(21, Math.ceil(z.target + 1)));
  const [busy, setBusy] = useState(false);
  const tz = state.timeZone;
  const run = async (fn, msg) => {
    setBusy(true);
    try { await fn(); notify(msg); onClose(); } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const boost = (minutes) => run(() => api(`zones/${z.id}/override`, 'POST', { temp: boostTemp, minutes }), `${z.name} boosted to ${deg(boostTemp)}`);
  const back = backTo(z, state);
  const cancel = () => run(() => api(`zones/${z.id}/override`, 'DELETE'), `${z.name} is ${back.done}`);
  const overridden = isOverridden(z);
  const blocked = state.mode === 'off';

  return (
    <Sheet onClose={onClose} label={z.name}>
      <h2>{z.name}</h2>
      <p className="lede">{deg(z.current)} now. {statusLine(z, tz)}.{waitWhy(z) ? ` ${waitWhy(z)}` : z.coasting ? ` Heat stopped at ${deg(z.stopAt)}; the radiators' leftover heat should carry it to ${deg(z.target)}.` : ''}</p>
      {nextWhy(z, tz, state.extras?.outside?.now) && <p className="lede next-why"><Icon.clock />{nextWhy(z, tz, state.extras?.outside?.now)}</p>}
      {overridden && !blocked && (
        <div className="actions back-row">
          <button className="btn primary" disabled={busy} onClick={cancel}>
            <Icon.undo />{back.label}{back.temp != null ? ` (${deg(back.temp)})` : ''}
          </button>
        </div>
      )}

      {z.source === 'window' && (
        <div className="boost-running" style={{ marginBottom: 12 }}>
          <p>{z.name} dropped {z.windowPause ? `${Math.round((z.windowPause.from - z.windowPause.to) * 10) / 10}°` : 'sharply'} in a few minutes, so its heating is paused until {fmtTime(z.until, tz)}.</p>
          <button className="btn" onClick={async () => { try { await api(`zones/${z.id}/window`, 'DELETE'); notify(`${z.name}: heating resumed`); onClose(); } catch (e) { notify(e.message, true); } }}>Window's closed, resume heating</button>
        </div>
      )}
      {blocked ? <p>Heating is switched off for the whole house. Switch back to Schedules to boost this room.</p> : (
        <>
          <h3>Boost</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <Stepper value={boostTemp} onChange={setBoostTemp} label="boost temperature" />
            <div className="choice-row">
              {[30, 60, 120].map((m) => (
                <button key={m} className="chip" disabled={busy} onClick={() => boost(m)}>{m < 60 ? `${m} min` : `${m / 60} h`}</button>
              ))}
            </div>
          </div>
        </>
      )}

      <SnoozeSection z={z} state={state} run={run} busy={busy} />

      <h3>Today</h3>
      <Ribbon schedule={state.schedules[z.id]} day={nowLocal(tz).day} tz={tz} tall showNow showHours labels />
      <div className="actions"><a className="btn link" href={`#/schedules/${z.id}`} onClick={onClose}>Edit the week’s schedule</a></div>

      <h3>Radiators</h3>
      <ul className="devices">
        {z.trvs.map((t) => (
          <li key={t.entity_id}>
            <span className="dev-name">{t.name}{t.childLock && <LockToggle lock={t.childLock} name={t.name} notify={notify} />}</span>
            <span className={`meta${t.available ? '' : ' bad'}`}>
              {!t.available ? 'Offline'
                : t.role === 'boiler' ? <>{deg(t.current)} now, {state.boiler.on ? 'firing the boiler' : 'boiler resting'}</>
                : <>{deg(t.current)} now, set to {deg(t.target)}{t.action === 'heating' ? ', valve open' : ''}</>}
            </span>
          </li>
        ))}
        {z.trvs.length === 0 && <li><span>No radiators linked</span></li>}
      </ul>
      {z.sensor && <p className="lede" style={{ marginTop: 10 }}>Room temperature comes from a separate thermometer.</p>}
    </Sheet>
  );
}

export default function Rooms({ state, notify, today }) {
  const [open, setOpen] = useState(null);
  const zone = state.zones.find((z) => z.id === open);
  if (!state.zones.length) {
    return (
      <div className="empty">
        <h2>No rooms yet</h2>
        <p>Add a room, link its radiators, and it will follow a schedule you set here.</p>
        <a className="btn primary" href="#/settings/rooms">Add a room</a>
      </div>
    );
  }
  return (
    <>
      <div className="rooms">
        {state.zones.map((z) => <RoomCard key={z.id} z={z} state={state} onOpen={() => setOpen(z.id)} notify={notify} today={today} />)}
      </div>
      {zone && <RoomSheet z={zone} state={state} onClose={() => setOpen(null)} notify={notify} />}
    </>
  );
}
export { DAYS };
