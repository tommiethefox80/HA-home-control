import { useEffect, useRef, useState } from 'react';
import { api, clock, lightCss, inkOn, levelText, warmthWord, plural, store } from './lib.js';
import { Icon, Ribbon, Sheet, Slider, Chips, Notice, kindIcon, brightnessTrack, warmthTrack } from './ui.jsx';
import { Chart } from './Chart.jsx';
import { BringAcross } from './Import.jsx';

export function Lights({ state, run, go, old }) {
  const [open, setOpen] = useState(null);
  if (!state) return <div className="loading" role="status">Loading your lights</div>;
  if (!state.groups.length) {
    return (
      <section className="empty card">
        <Icon name="bulb" size={32} />
        <h2>No lights or sockets set up yet</h2>
        {old?.status === 'found' ? (
          <>
            <BringAcross old={old} run={run} />
            <p className="fine">Or start afresh: <a href="#/lighting/settings/new">add a group</a>.</p>
          </>
        ) : (
          <>
            <p>Put your lights and smart sockets into groups, such as a room or "Christmas lights". You can start from your Home Assistant areas.</p>
            <a className="btn btn-primary" href="#/lighting/settings/new">Add your first group</a>
          </>
        )}
      </section>
    );
  }
  const group = open && state.groups.find((g) => g.id === open);
  return (
    <>
      <div className="lights-layout">
        <section className="groups" aria-label="Groups">
          {state.groups.map((g) => (
            <GroupCard key={g.id} g={g} state={state} run={run} onOpen={() => setOpen(g.id)} go={go} />
          ))}
        </section>
        <aside className="stats" aria-label="Summary">
          <Stats state={state} />
        </aside>
      </div>
      <Chart state={state} />
      {group && <GroupSheet g={group} state={state} run={run} onClose={() => setOpen(null)} go={go} />}
    </>
  );
}

// ---------- group card ----------

function display(g, pending) {
  const c = g.current;
  if (pending) return { on: pending.on, brightness: pending.brightness ?? c.brightness, kelvin: pending.kelvin ?? c.kelvin };
  return { on: c.onCount > 0, brightness: c.brightness, kelvin: c.kelvin };
}

function bigText(g, d) {
  const c = g.current;
  if (!d.on) return 'Off';
  if (g.dimmable && d.brightness != null) return `${d.brightness}%`;
  if (c.total > 1 && c.onCount < c.total) return `${c.onCount} of ${c.total}`;
  return 'On';
}

function targetLabel(g) {
  const t = g.target;
  if (g.override || !t) return null; // the status line already says what's going on

  const word = { schedule: 'Scheduled', override: 'Set here', motion: 'Movement', away: 'Away', off: 'All off' }[g.source] || 'Target';
  return { text: `${word} ${levelText(t, g.dimmable).toLowerCase()}`, level: t };
}

// Wait this long after the last press before sending, so several presses become one change.
const STEP_WAIT = 500;

export function countText(devices) {
  const lights = devices.filter((x) => x.kind === 'light').length;
  const others = devices.length - lights;
  const parts = [];
  if (lights) parts.push(plural(lights, 'light'));
  if (others) parts.push(plural(others, 'socket'));
  return parts.join(' and ') || 'Empty';
}

function GroupCard({ g, state, run, onOpen }) {
  const [pending, setPending] = useState(null);
  const timer = useRef(null);
  const step = state.settings.stepSize || 10;
  const d = display(g, pending);
  const colour = lightCss(d.on, d.brightness, d.kelvin);
  const tl = targetLabel(g);
  const unreachable = g.devices.filter((x) => !x.available);

  const seq = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Show the new value straight away. Once the app has taken the request, the server keeps showing
  // what was asked for while the lights catch up, so the screen never jumps back to an old value.
  const send = (body, delay) => {
    const mine = ++seq.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await run(() => api('POST', `groups/${g.id}/set`, body)); } catch { /* shown at the top */ }
      if (seq.current === mine) setPending(null);
    }, delay);
  };

  const stepBy = (dir) => {
    const cur = d.on ? (d.brightness ?? 100) : 0;
    let next = Math.round((cur + dir * step) / step) * step;
    if (dir > 0 && cur === 0) next = step;
    next = Math.min(100, next);
    if (next <= 0) { setPending({ on: false }); send({ on: false }, STEP_WAIT); return; }
    setPending({ on: true, brightness: next });
    send({ on: true, brightness: next }, STEP_WAIT);
  };

  const toggle = () => {
    const on = !d.on;
    setPending(on ? { on: true, brightness: g.turnOn?.brightness ?? 100, kelvin: g.turnOn?.kelvin } : { on: false });
    send({ on }, 0);
  };

  return (
    <article className="gcard" style={{ '--light': colour }}>
      <div className="gcard-head">
        <button type="button" className="gname" onClick={onOpen} aria-label={`${g.name}: open details`}>
          <span>{g.name}</span>
          <span className="gcount">{countText(g.devices)}</span>
        </button>
        <button type="button" className={`power ${d.on ? 'power-on' : ''}`} onClick={toggle}
          aria-label={d.on ? `Turn ${g.name} off` : `Turn ${g.name} on`} aria-pressed={d.on}
          style={d.on ? { background: colour, color: inkOn(true, d.brightness, d.kelvin) } : undefined}>
          <Icon name="power" />
        </button>
      </div>

      <div className="gcard-main">
        <div className="big" aria-live="polite">{bigText(g, d)}</div>
        {g.dimmable && (
          <div className="stepper">
            <button type="button" className="icon-btn step-btn" onClick={() => stepBy(-1)} aria-label={`Dim ${g.name}`} disabled={!d.on}><Icon name="minus" /></button>
            <button type="button" className="icon-btn step-btn" onClick={() => stepBy(1)} aria-label={`Brighten ${g.name}`} disabled={d.on && d.brightness >= 100}><Icon name="plus" /></button>
          </div>
        )}
      </div>

      <div className="gcard-meta">
        {tl && (
          <span className="target-chip">
            {tl.level && <span className="target-swatch" style={{ background: lightCss(tl.level.on, tl.level.brightness, tl.level.kelvin) }} />}
            {tl.text}
          </span>
        )}
        {(() => {
          const notes = [];
          if (d.on && d.kelvin) notes.push(warmthWord(d.kelvin));
          if (g.current.onCount > 0 && g.current.onCount < g.current.total && g.dimmable) notes.push(`${g.current.onCount} of ${g.current.total} on`);
          return notes.length ? <span className="meta-note">{notes.join(', ')}</span> : null;
        })()}
      </div>

      <p className={`gstatus tone-${g.status.tone}`}>{g.status.text}</p>
      {unreachable.length > 0 && unreachable.length < g.devices.length && (
        <p className="gwarn"><Icon name="warn" size={16} /> Can't reach {unreachable.map((x) => x.short).join(' and ')}</p>
      )}

      {state.settings.showDevices?.page && g.devices.length > 1 && (
        <ul className="gdevs" aria-label={`Lights and sockets in ${g.name}`}>
          {g.devices.map((x) => <DeviceRow key={x.id} x={x} g={g} run={run} step={step} />)}
        </ul>
      )}

      {g.segments.length ? (
        <Ribbon segments={g.segments} nowMin={state.today.minutes} dimmable={g.dimmable} />
      ) : g.hasSchedule ? (
        <a className="link-quiet" href={`#/lighting/schedules/${g.id}`}>See the schedule</a>
      ) : (
        <a className="link-quiet" href={`#/lighting/schedules/${g.id}`}>Add a schedule</a>
      )}
    </article>
  );
}

// One light or socket in a group's card (Lighting → Settings → Each light and socket): its own
// switch and, where it dims, minus and plus. A change lasts until the group's next scheduled change.
function DeviceRow({ x, g, run, step }) {
  const [pending, setPending] = useState(null);
  const timer = useRef(null);
  const seq = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const on = pending ? pending.on : x.on;
  const bri = pending?.brightness ?? (x.on ? x.brightness : null);
  const send = (body, delay) => {
    const mine = ++seq.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try { await run(() => api('POST', `groups/${g.id}/set`, { ...body, device: x.id })); } catch { /* shown at the top */ }
      if (seq.current === mine) setPending(null);
    }, delay);
  };
  const toggle = () => {
    setPending(on ? { on: false } : { on: true, brightness: x.dimmable ? g.turnOn?.brightness ?? 100 : null });
    send({ on: !on }, 0);
  };
  const stepBy = (dir) => {
    const cur = on ? (bri ?? 100) : 0;
    let next = Math.round((cur + dir * step) / step) * step;
    if (dir > 0 && cur === 0) next = step;
    next = Math.min(100, next);
    if (next <= 0) { setPending({ on: false }); send({ on: false }, STEP_WAIT); return; }
    setPending({ on: true, brightness: next });
    send({ on: true, brightness: next }, STEP_WAIT);
  };
  const level = !x.available ? 'Can\'t be reached' : !on ? 'Off' : x.dimmable ? `${bri ?? 100}%` : 'On';
  return (
    <li className={`gdev${on ? ' gdev-on' : ''}${x.available ? '' : ' gdev-gone'}`}>
      <span className="gdev-icon" style={{ background: lightCss(on, bri, x.kelvin), color: inkOn(on, bri, x.kelvin) }} aria-hidden="true">
        <Icon name={kindIcon(x.kind)} size={16} />
      </span>
      <span className="gdev-name">{x.short}<small aria-live="polite">{level}</small></span>
      {x.dimmable && x.available && (
        <span className="gdev-step">
          <button type="button" className="icon-btn" onClick={() => stepBy(-1)} disabled={!on} aria-label={`Dim ${x.short}`}><Icon name="minus" size={16} /></button>
          <button type="button" className="icon-btn" onClick={() => stepBy(1)} disabled={on && (bri ?? 100) >= 100} aria-label={`Brighten ${x.short}`}><Icon name="plus" size={16} /></button>
        </span>
      )}
      <button type="button" role="switch" aria-checked={on} className="switch" disabled={!x.available}
        aria-label={`${x.short} ${on ? 'on' : 'off'}`} onClick={toggle}><span /></button>
    </li>
  );
}

// ---------- details sheet ----------

const KEEP = [
  { value: 0, label: 'Until next change' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 h' },
  { value: 120, label: '2 h' },
  { value: 240, label: '4 h' },
];

function GroupSheet({ g, state, run, onClose }) {
  const [keep, setKeep] = useState(() => store.get('keep', 0));
  const [bri, setBri] = useState(g.current.brightness ?? 100);
  const [kel, setKel] = useState(g.current.kelvin ?? 2700);
  const [devVals, setDevVals] = useState({});
  const tz = state.ctx.tz;
  const isOn = g.current.onCount > 0;
  const minutes = keep || undefined;

  // Follow live values, except while dragging or while a change is on its way to the app
  // (updates sent before the app has it would pull the slider back to the old value).
  const dragging = useRef(false);
  const inFlight = useRef(0);
  useEffect(() => {
    if (dragging.current || inFlight.current) return;
    if (g.current.brightness != null) setBri(g.current.brightness);
    if (g.current.kelvin != null) setKel(g.current.kelvin);
  }, [g.current.brightness, g.current.kelvin]);

  const post = async (body) => {
    inFlight.current++;
    try { await run(() => api('POST', `groups/${g.id}/set`, { ...body, minutes })); } catch { /* shown at the top */ }
    inFlight.current--;
  };
  const set = (body) => post(body);
  const setDevice = (id, body) => post({ ...body, device: id });
  const clearDev = (id, key) => setDevVals((v) => ({ ...v, [id]: { ...v[id], [key]: undefined } }));

  const footer = g.override ? (
    <button type="button" className="btn btn-primary" onClick={() => run(() => api('POST', `groups/${g.id}/resume`)).catch(() => {})}>
      {state.mode === 'away' ? 'Back to Away' : state.mode === 'off' ? 'Back to all off' : 'Back to schedule'}
    </button>
  ) : null;

  return (
    <Sheet title={g.name} subtitle={g.status.text} onClose={onClose} footer={footer}>
      <section className="sheet-section">
        <div className="row-between">
          <h3>Whole group</h3>
          <div className="btn-pair">
            <button type="button" className={`btn ${isOn ? 'btn-quiet' : 'btn-primary'}`} onClick={() => set({ on: true })} data-autofocus>Turn on</button>
            <button type="button" className={`btn ${isOn ? 'btn-primary' : 'btn-quiet'}`} onClick={() => set({ on: false })}>Turn off</button>
          </div>
        </div>
        {!isOn && g.dimmable && g.turnOn && (
          <p className="fine">Turning on uses {g.turnOn.brightness}%, {g.turnOn.note}.</p>
        )}
        {g.dimmable && (
          <Slider label="Brightness" min={1} max={100} value={bri} format={(v) => `${v}%`} track={brightnessTrack(kel)}
            onChange={(v) => { dragging.current = true; setBri(v); }}
            onCommit={(v) => { dragging.current = false; set({ brightness: v }); }} />
        )}
        {g.ct && (
          <Slider label="Warmth" min={Math.max(2000, g.minK)} max={Math.min(6500, g.maxK)} step={50} value={kel}
            format={(v) => `${warmthWord(v)}, ${v} K`} track={warmthTrack()}
            onChange={(v) => { dragging.current = true; setKel(v); }}
            onCommit={(v) => { dragging.current = false; set({ kelvin: v }); }} />
        )}
        <div className="field">
          <span className="field-label" id={`keep-${g.id}`}>Keep changes</span>
          <Chips small label="Keep changes" value={keep} onChange={(v) => { setKeep(v); store.set('keep', v); }} options={KEEP} />
        </div>
      </section>

      <section className="sheet-section">
        <h3>Lights and sockets</h3>
        <ul className="dev-list">
          {g.devices.map((x) => {
            const v = devVals[x.id] || {};
            const b = v.brightness ?? (x.on ? x.brightness : 50);
            const k = v.kelvin ?? x.kelvin ?? 2700;
            return (
              <li key={x.id} className={`dev ${x.available ? '' : 'dev-off'}`}>
                <div className="dev-row">
                  <span className="dev-icon" style={{ background: lightCss(x.on, x.brightness, x.kelvin), color: inkOn(x.on, x.brightness, x.kelvin) }}>
                    <Icon name={kindIcon(x.kind)} size={18} />
                  </span>
                  <span className="dev-name">
                    {x.short}
                    <span className="dev-state">
                      {!x.available ? 'Can\'t be reached' : x.on ? (x.dimmable ? `On at ${x.brightness}%` : 'On') : 'Off'}
                      {x.kind === 'socket' ? ', socket' : ''}
                    </span>
                  </span>
                  <button type="button" role="switch" aria-checked={x.on} className="switch" disabled={!x.available}
                    aria-label={`${x.short} ${x.on ? 'on' : 'off'}`} onClick={() => setDevice(x.id, { on: !x.on })}><span /></button>
                </div>
                {x.available && x.on && x.dimmable && (
                  <Slider label="Brightness" min={1} max={100} value={b} format={(n) => `${n}%`} track={brightnessTrack(k)}
                    onChange={(n) => setDevVals((s) => ({ ...s, [x.id]: { ...s[x.id], brightness: n } }))}
                    onCommit={(n) => setDevice(x.id, { brightness: n }).then(() => clearDev(x.id, 'brightness'))} />
                )}
                {x.available && x.on && x.ct && (
                  <Slider label="Warmth" min={x.minK} max={x.maxK} step={50} value={k} format={(n) => `${n} K`} track={warmthTrack()}
                    onChange={(n) => setDevVals((s) => ({ ...s, [x.id]: { ...s[x.id], kelvin: n } }))}
                    onCommit={(n) => setDevice(x.id, { kelvin: n }).then(() => clearDev(x.id, 'kelvin'))} />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {(g.motion || g.lux) && (
        <section className="sheet-section">
          <h3>Sensors</h3>
          {g.motion && (
            <p className="sensor-line"><Icon name="motion" size={18} />
              {g.motion.missing ? `Can't find the movement sensor ${g.motion.entity}. Check it in Settings.`
                : `${g.motion.name} turns these on to ${g.motion.brightness}% for ${g.motion.minutes} min when there's movement${g.motion.active ? '. Movement now.' : '.'}`}
            </p>
          )}
          {g.lux && (
            <p className="sensor-line"><Icon name="sun" size={18} />
              {g.lux.missing ? `Can't find the light sensor ${g.lux.entity}. Check it in Settings.`
                : `Won't switch on above ${g.lux.threshold} lx. It's ${g.lux.value ?? 'unknown'} lx now.`}
            </p>
          )}
        </section>
      )}
      {g.override?.until && <p className="fine">This lasts until {clock(g.override.until, tz)}, then goes {state.mode === 'schedule' ? 'back to the schedule' : 'back to the mode'}.</p>}
    </Sheet>
  );
}

// ---------- stat cards ----------

function Stats({ state }) {
  const tz = state.ctx.tz;
  const { stats, today } = state;
  const next = stats.next;
  return (
    <>
      <div className="stat card">
        <span className="stat-label">On now</span>
        <span className="stat-value">{stats.lightsOn}<span className="stat-of"> of {stats.total}</span></span>
        <span className="stat-help">lights and sockets</span>
      </div>
      <div className="stat card">
        <span className="stat-label">Next change</span>
        {next ? (
          <>
            <span className="stat-value stat-time">{clock(next.at, tz)}</span>
            <span className="stat-help">{next.group} {next.on ? (next.brightness != null ? `to ${next.brightness}%` : 'on') : 'off'}{/sun/.test(next.when) ? `, ${next.when}` : ''}</span>
          </>
        ) : <span className="stat-help">Nothing scheduled</span>}
      </div>
      <div className="stat card">
        <span className="stat-label">Sun today</span>
        <span className="stat-sun">
          <span><Icon name="sun" size={16} /> Sunrise {today.sunrise ? clock(today.sunrise, tz) : 'none'}</span>
          <span><Icon name="moon" size={16} /> Sunset {today.sunset ? clock(today.sunset, tz) : 'none'}</span>
        </span>
        {!state.sunFound && <span className="stat-help">Worked out from your home location</span>}
      </div>
      <div className="stat card">
        <span className="stat-label">Changed by hand</span>
        <span className="stat-value">{stats.manualToday}</span>
        <span className="stat-help">in the last 24 hours</span>
      </div>
      {!state.settings.detectManual && (
        <Notice tone="warn">Changes made elsewhere are put back to the schedule. Turn on "Notice changes made elsewhere" in Settings to stop this.</Notice>
      )}
    </>
  );
}
