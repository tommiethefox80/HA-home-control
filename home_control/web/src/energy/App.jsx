// Energy: the electricity price now and ahead, today's cost, the car's charging (Intelligent
// Octopus), and plans that switch a socket on at the cheapest time. From the Octopus Energy
// integration and Home Assistant's Energy dashboard.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, Sheet, Toggle, Field, Notice, Chips } from '../lighting/ui.jsx';
import { goDashboard } from '../lighting/lib.js';
import { SettingsFrame, settingsPage } from '../SettingsFrame.jsx';
import { api, useLiveState, clock, when, span, dayWord, money, pence, kwh, hoursText, BAND, watts } from './lib.js';

const TABS = [
  { id: 'today', label: 'Today', icon: 'bolt' },
  { id: 'plans', label: 'Plans', icon: 'clock' },
  { id: 'history', label: 'History', icon: 'chart' },
  { id: 'activity', label: 'Activity', icon: 'list' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

function useHashRoute() {
  const read = () => {
    const h = window.location.hash.replace(/^#\/?/, '').replace(/^energy\/?/, '');
    const [tab, ...rest] = h.split('/');
    return { tab: TABS.some((t) => t.id === tab) ? tab : 'today', arg: rest.join('/') || null };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function statusChip(state) {
  if (!state) return { text: 'Connecting', tone: 'quiet' };
  if (!state.connected) return { text: 'Not connected to Home Assistant', tone: 'warn' };
  if (!state.price) return { text: state.found?.octopus ? 'Waiting for prices' : 'No prices found', tone: 'quiet' };
  const b = state.price.band;
  return { text: `${pence(state.price.p)} now${b && b !== 'standard' ? `, ${BAND[b].word.toLowerCase()}` : ''}`, tone: 'quiet' };
}

export function App({ active = true, switcher }) {
  const { state, link, replace } = useLiveState();
  const route = useHashRoute();
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
    <div className="app energy-app">
      <header className="top home-top">
        <div className="home-top-l">
          <button type="button" className="btn btn-quiet dash-btn" onClick={() => goDashboard(state?.dashboardPath || '/')}>
            <Icon name="home" /><span>Dashboard</span>
          </button>
        </div>
        <h1 className="sr-only">{`Energy: ${TABS.find((t) => t.id === route.tab)?.label}`}</h1>
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
        {route.tab === 'today' && <Today state={state} run={run} />}
        {route.tab === 'plans' && <Plans state={state} run={run} arg={route.arg} />}
        {route.tab === 'history' && <History state={state} />}
        {route.tab === 'activity' && <Activity state={state} />}
        {route.tab === 'settings' && <Settings state={state} run={run} arg={route.arg} />}
      </main>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a key={t.id} href={`#/energy/${t.id === 'today' ? '' : t.id}`} className={route.tab === t.id ? 'tab tab-on' : 'tab'} aria-current={route.tab === t.id ? 'page' : undefined}>
            <Icon name={t.icon} /><span className="tab-long">{t.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

// ---------- today ----------

function NoPrices({ state }) {
  return (
    <div className="card empty en-empty">
      <Icon name="bolt" size={32} />
      <h2>No electricity prices in Home Assistant</h2>
      <p className="fine">Energy reads your prices, today's cost and the car from the <strong>Octopus Energy</strong> integration (from HACS: search for "Octopus Energy" by BottlecapDave, then add it in Settings → Devices &amp; services with your Octopus API key). With another supplier, set up Home Assistant's own Energy dashboard with a price, and the price now and your usage show here.</p>
      {state.found?.dashboard && <p className="fine">Your Energy dashboard is set up, so the History page already works.</p>}
    </div>
  );
}

function Today({ state, run }) {
  if (!state) return <p className="fine pad">Loading…</p>;
  if (!state.found?.prices && !state.found?.dashboard) return <NoPrices state={state} />;
  const tz = state.timeZone;
  return (
    <div className="en-today">
      <div className="en-top">
        <PriceNow state={state} />
        <CostToday state={state} />
      </div>
      {state.rates.length > 0 && <PriceChart state={state} />}
      {state.ev && <Car state={state} run={run} />}
      <PlansSummary state={state} tz={tz} />
    </div>
  );
}

function PriceNow({ state }) {
  const tz = state.timeZone;
  const pr = state.price;
  const two = state.limits?.kind === 'two';
  const runs = state.cheapRuns || [];
  const nowRun = runs.find((r) => r.start <= state.now && state.now < r.end);
  const nextRun = runs.find((r) => r.start > state.now);
  return (
    <section className="card en-price" aria-labelledby="en-price-h">
      <div className="en-price-head">
        <h2 id="en-price-h">Electricity now</h2>
        {state.tariff?.name && <span className="fine">{state.tariff.name}</span>}
      </div>
      {pr ? (
        <>
          <p className="en-price-num">
            <strong className="num">{pence(pr.p)}</strong><span>per kWh</span>
            {pr.band && pr.band !== 'standard' && <span className={`en-band en-band-${pr.band}`}><span className="en-swatch" />{BAND[pr.band].word}</span>}
          </p>
          <p className="en-price-line">
            {pr.adjusted ? 'Cheap while the car charges' : nowRun ? `${two ? 'Off-peak' : 'Cheap'} until ${clock(nowRun.end, tz)}` : null}
            {(pr.adjusted || nowRun) && pr.next?.p != null ? ', then ' : ''}
            {pr.next?.p != null && <>{!(pr.adjusted || nowRun) && 'Until '}{!(pr.adjusted || nowRun) ? `${clock(pr.next.at, tz)}, then ` : ''}<strong>{pence(pr.next.p)}</strong>{(pr.adjusted || nowRun) ? ` from ${clock(pr.next.at, tz)}` : ''}</>}
          </p>
        </>
      ) : <p className="fine">{state.found?.octopus ? 'Waiting for today\'s prices from Octopus.' : 'No price found.'}</p>}
      <ul className="en-facts">
        {!nowRun && nextRun && <li><span className="en-swatch en-sw-cheap" /><span>{nextRun.extra ? 'Extra cheap' : two ? 'Off-peak' : 'Cheap'} {span(nextRun.start, nextRun.end, tz, state.now)}, {pence(nextRun.avg)}</span></li>}
        {runs.filter((r) => r.extra && r !== nextRun && r !== nowRun).slice(0, 2).map((r) => (
          <li key={r.start}><span className="en-swatch en-sw-cheap" /><span>Extra cheap {span(r.start, r.end, tz, state.now)} (car charging)</span></li>
        ))}
        {state.elec?.demand && <li><Icon name="bolt" size={16} /><span>Using <strong>{watts(state.elec.demand.w)}</strong> now</span></li>}
        {state.exportP != null && <li><Icon name="up" size={16} /><span>Export {pence(state.exportP)} per kWh</span></li>}
        {state.gas?.p != null && <li><Icon name="flame" size={16} /><span>Gas {pence(state.gas.p)} per kWh</span></li>}
      </ul>
    </section>
  );
}

function CostToday({ state }) {
  const tz = state.timeZone;
  const cur = state.currency;
  const t = state.elec?.today;
  const last = state.elec?.last;
  const g = state.gas;
  const use = state.elec?.use || [];
  const max = Math.max(0.01, ...use.map((u) => u.kwh || 0));
  const half = use.length > 1 && use[1].s - use[0].s <= 30 * 60000;
  return (
    <section className="card en-cost" aria-labelledby="en-cost-h">
      <h2 id="en-cost-h">Today so far</h2>
      <div className="en-cost-grid">
        <div>
          <p className="en-cost-label"><Icon name="bolt" size={16} />Electricity</p>
          <p className="en-cost-num num">{t?.cost != null ? money(t.cost, cur) : '–'}</p>
          <p className="fine">{t ? [t.kwh != null ? kwh(t.kwh) : null, t.standing != null ? `with ${money(t.standing, cur)} standing charge` : null, t.est ? 'estimated from the prices' : null].filter(Boolean).join(' · ') : 'No figures yet'}</p>
        </div>
        {g && (
          <div>
            <p className="en-cost-label"><Icon name="flame" size={16} />Gas</p>
            <p className="en-cost-num num">{g.today?.cost != null ? money(g.today.cost, cur) : '–'}</p>
            <p className="fine">{g.today ? [g.today.kwh != null ? `${Math.round(g.today.kwh * 10) / 10} ${g.unit || 'kWh'}` : null, g.today.standing != null ? `with ${money(g.today.standing, cur)} standing charge` : null].filter(Boolean).join(' · ') : g.last?.cost != null ? `${dayWord(g.last.day, tz, state.now)}: ${money(g.last.cost, cur)}` : 'No figures yet'}</p>
          </div>
        )}
      </div>
      {use.length > 0 && (
        <div className="en-use" role="img" aria-label={`Electricity used each ${half ? 'half hour' : 'hour'} today, up to ${kwh(max)}`}>
          {use.map((u) => <span key={u.s} style={{ height: `${Math.max(3, Math.round((u.kwh / max) * 100))}%` }} title={`${clock(u.s, tz)}: ${kwh(u.kwh)}${u.cost != null ? `, ${money(u.cost, cur)}` : ''}`} />)}
        </div>
      )}
      {last?.cost != null && <p className="fine en-last">{dayWord(last.day, tz, state.now)}: <strong>{money(last.cost, cur)}</strong>{last.kwh != null ? ` for ${kwh(last.kwh)}` : ''}</p>}
    </section>
  );
}

// The prices for today and tomorrow, half hour by half hour, coloured cheap, standard or peak
function PriceChart({ state }) {
  const tz = state.timeZone;
  const rates = state.rates;
  const [pick, setPick] = useState(null);
  const [list, setList] = useState(false);
  const ref = useRef(null);
  const W = 720; const Hh = 170; const top = 14; const bottom = 4;
  const from = rates[0].s; const to = rates[rates.length - 1].e;
  const maxP = Math.max(5, ...rates.map((r) => r.p));
  const minP = Math.min(0, ...rates.map((r) => r.p));
  const x = (t) => ((t - from) / (to - from)) * W;
  const y = (p) => top + (1 - (p - minP) / (maxP - minP)) * (Hh - top - bottom);
  const zero = y(0);
  const nowX = x(state.now);
  const nowIdx = rates.findIndex((r) => r.s <= state.now && state.now < r.e);
  const shown = pick ?? (nowIdx >= 0 ? nowIdx : null);
  const best = (state.cheapest || []).find((c) => c.minutes === 180);
  // hour marks every six hours, and where tomorrow starts
  const marks = [];
  for (let t = Math.ceil(from / 3600000) * 3600000; t < to; t += 3600000) {
    const h = Number(clock(t, tz).slice(0, 2));
    if (Number(clock(t, tz).slice(3)) !== 0 || h % 6 !== 0) continue;
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t));
    const tomorrow = key === new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(state.now + 86400000));
    marks.push({ t, label: h === 0 ? (tomorrow ? 'Tomorrow' : dayWord(key, tz, state.now)) : clock(t, tz), day: h === 0, minor: h === 6 || h === 18 });
  }
  const step = (d) => setPick((p) => { const cur = p ?? (nowIdx >= 0 ? nowIdx : 0); return Math.min(rates.length - 1, Math.max(0, cur + d)); });
  const onMove = (e) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    const t = from + (px / W) * (to - from);
    const i = rates.findIndex((r) => r.s <= t && t < r.e);
    if (i >= 0) setPick(i);
  };
  const r = shown != null ? rates[shown] : null;
  const legend = [...new Set(rates.map((x2) => x2.b))].filter(Boolean);
  const order = ['free', 'cheap', 'standard', 'peak'];
  return (
    <section className="card en-chart" aria-labelledby="en-chart-h">
      <div className="en-chart-head">
        <h2 id="en-chart-h">{to - from > 30 * 3600000 ? 'Prices today and tomorrow' : 'Prices today'}</h2>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setList((v) => !v)} aria-expanded={list}>{list ? 'Show the chart' : 'Show as a list'}</button>
      </div>
      {!list && (
        <>
          <p className="en-tip" aria-live="polite">
            {r ? <><strong>{span(r.s, r.e, tz, state.now)}</strong> · {pence(r.p)}{r.b ? ` · ${BAND[r.b].word}` : ''}{r.adj ? ' (car charging)' : ''}{shown === nowIdx ? ' · now' : ''}</> : ' '}
          </p>
          <div className="en-plot">
          <span className="en-ymax" aria-hidden="true">{pence(maxP)}</span>
          <svg ref={ref} className="en-svg" viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" role="img" tabIndex={0}
            aria-label={`Half-hourly electricity prices from ${pence(Math.min(...rates.map((q) => q.p)))} to ${pence(maxP)}. Use the arrow keys to read each one.`}
            onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setPick(null)}
            onKeyDown={(e) => { if (e.key === 'ArrowRight') { step(1); e.preventDefault(); } if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); } }}>
            {[0.5, 1].map((f) => { const p = minP + (maxP - minP) * f; return <line key={f} className="en-grid" x1="0" x2={W} y1={y(p)} y2={y(p)} />; })}
            {best && <rect className="en-best" x={x(best.start)} y={top - 10} width={Math.max(2, x(best.end) - x(best.start))} height={Hh - top - bottom + 10} rx="4" />}
            {rates.map((q, i) => {
              const x0 = x(q.s) + 0.6; const w = Math.max(0.8, x(q.e) - x(q.s) - 1.2);
              const yTop = Math.min(y(q.p), zero); const h = Math.max(1.5, Math.abs(zero - y(q.p)));
              return <rect key={q.s} className={`en-bar en-b-${q.b || 'standard'}${q.e <= state.now ? ' en-past' : ''}${i === shown ? ' en-on' : ''}`} x={x0} y={yTop} width={w} height={h} rx="1.5" />;
            })}
            <line className="en-zero" x1="0" x2={W} y1={zero} y2={zero} />
            {nowX > 0 && nowX < W && <line className="en-now" x1={nowX} x2={nowX} y1={top - 12} y2={Hh - bottom} />}
            {marks.filter((m) => m.day).map((m) => <line key={m.t} className="en-daymark" x1={x(m.t)} x2={x(m.t)} y1={top - 12} y2={Hh - bottom} />)}
          </svg>
          <div className="en-xaxis" aria-hidden="true">
            {marks.map((m) => {
              const pc = (x(m.t) / W) * 100;
              return <span key={m.t} className={m.day ? 'en-axis-day' : m.minor ? 'en-axis-minor' : ''} style={{ left: `${pc}%`, transform: `translateX(${pc < 4 ? 0 : pc > 96 ? -100 : -50}%)` }}>{m.label}</span>;
            })}
          </div>
          </div>
          <ul className="en-legend">
            {order.filter((b) => legend.includes(b)).map((b) => (
              <li key={b}><span className={`en-swatch en-sw-${b}`} />{BAND[b].word}{b === 'cheap' && state.limits?.cheap != null && state.limits.kind !== 'two' ? ` (${pence(state.limits.cheap)} or less)` : ''}{b === 'peak' && state.limits?.peak != null ? ` (${pence(state.limits.peak)} or more)` : ''}</li>
            ))}
            {best && <li><span className="en-swatch en-sw-best" />Cheapest 3 hours</li>}
          </ul>
        </>
      )}
      {list && <PriceList state={state} />}
      <Cheapest state={state} />
    </section>
  );
}

function PriceList({ state }) {
  const tz = state.timeZone;
  // runs of the same price, from now on
  const runs = [];
  for (const r of state.rates) {
    if (r.e <= state.now) continue;
    const last = runs[runs.length - 1];
    if (last && last.p === r.p && last.e === r.s) last.e = r.e; else runs.push({ ...r });
  }
  return (
    <table className="en-table">
      <thead><tr><th scope="col">When</th><th scope="col">Price</th><th scope="col">Band</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.s} className={r.s <= state.now ? 'en-row-now' : ''}>
            <td>{span(r.s, r.e, tz, state.now)}{r.s <= state.now ? ' (now)' : ''}</td>
            <td className="num">{pence(r.p)}</td>
            <td>{r.b ? <><span className={`en-swatch en-sw-${r.b}`} />{BAND[r.b].word}{r.adj ? ' (car)' : ''}</> : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Cheapest({ state }) {
  const tz = state.timeZone;
  const two = state.limits?.kind === 'two' || state.limits?.kind === 'flat';
  if (two || !state.cheapest?.length) return null;
  return (
    <div className="en-cheapest">
      <h3>Cheapest from now</h3>
      <ul>
        {state.cheapest.map((c) => (
          <li key={c.minutes}><span className="en-ch-len">{hoursText(c.minutes)}</span><span>{span(c.start, c.end, tz, state.now)}</span><strong className="num">{pence(c.avg)}</strong></li>
        ))}
      </ul>
    </div>
  );
}

// ---------- the car (Intelligent Octopus) ----------

// the charger or car Octopus controls, as its makers call it
const PROVIDERS = {
  PROJEKT: 'Projekt EV charger', OHME: 'Ohme charger', HYPERVOLT: 'Hypervolt charger', MYENERGI: 'myenergi zappi', ZAPPI: 'myenergi zappi',
  WALLBOX: 'Wallbox charger', INDRA: 'Indra charger', ANDERSEN: 'Andersen charger', EO: 'EO charger', EASEE: 'Easee charger',
  TESLA: 'Tesla', JEDLIX: 'car', SMART_CAR: 'car', ENODE: 'car', CHARGEPOINT: 'ChargePoint charger', PODPOINT: 'Pod Point charger', POD_POINT: 'Pod Point charger',
};
function providerName(p) {
  const k = String(p).toUpperCase();
  if (PROVIDERS[k]) return PROVIDERS[k];
  const words = k.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return `${words} charger`;
}

function Car({ state, run }) {
  const tz = state.timeZone;
  const ev = state.ev;
  const set = (what, value) => run(() => api('POST', 'ev', { what, value })).catch(() => {});
  const head = ev.dispatching ? `Smart charging${ev.until ? ` until ${clock(ev.until, tz)}` : ''}` : ev.bump ? 'Bump charging now' : ev.stateText || 'Car';
  return (
    <section className="card en-car" aria-labelledby="en-car-h">
      <div className="en-car-head">
        <span className={`en-car-icon${ev.dispatching || ev.bump ? ' en-car-on' : ''}`}><Icon name="car" size={24} /></span>
        <div>
          <h2 id="en-car-h">{head}</h2>
          <p className="fine">{[ev.soc != null ? `Battery ${Math.round(ev.soc)}%` : null, ev.chargedToday ? `${ev.chargedToday} kWh charged today` : null, ev.provider ? `through the ${providerName(ev.provider)}` : null].filter(Boolean).join(' · ') || 'Intelligent Octopus'}</p>
        </div>
      </div>
      {ev.planned.length > 0 && (
        <div className="en-slots">
          <h3>Octopus plans to charge</h3>
          <ul>{ev.planned.slice(0, 6).map((p) => <li key={p.start}><span className="en-swatch en-sw-cheap" />{span(p.start, p.end, tz, state.now)}</li>)}</ul>
          <p className="fine">The whole house gets the off-peak price during these times.</p>
        </div>
      )}
      <div className="en-car-controls">
        {ev.bump != null && (
          <button type="button" className={`btn ${ev.bump ? 'btn-primary' : 'btn-quiet'}`} onClick={() => set('bump', !ev.bump)} aria-pressed={ev.bump}>
            <Icon name="bolt" size={18} />{ev.bump ? 'Stop bump charge' : 'Bump charge now'}
          </button>
        )}
        {ev.target && (
          <label className="en-inline">
            <span>Charge to</span>
            <select value={ev.target.value ?? ''} onChange={(e) => set('target', Number(e.target.value))}>
              {Array.from({ length: Math.floor((ev.target.max - ev.target.min) / ev.target.step) + 1 }, (_, i) => ev.target.min + i * ev.target.step).map((v) => <option key={v} value={v}>{v}%</option>)}
            </select>
          </label>
        )}
        {ev.ready && (
          <label className="en-inline">
            <span>Ready by</span>
            {ev.ready.options ? (
              <select value={ev.ready.value} onChange={(e) => set('ready', e.target.value)}>
                {ev.ready.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : <input type="time" value={ev.ready.value} onChange={(e) => e.target.value && set('ready', e.target.value)} />}
          </label>
        )}
        {ev.smart != null && <Toggle label="Smart charging" checked={ev.smart} onChange={(v) => set('smart', v)} />}
      </div>
    </section>
  );
}

// ---------- plans ----------

function planNext(p, tz, now) {
  const n = p.next;
  if (!p.enabled && !n?.running) return 'Off';
  if (!n) return 'Waiting for the prices';
  const times = n.slots?.length > 1 ? n.slots.map(([s, e]) => span(s, e, tz, now)).join(', ') : span(n.start, n.end, tz, now);
  const price = n.avg != null ? ` at ${pence(n.avg)}` : '';
  if (n.running) return `Running now: ${times}${price}`;
  return `${n.provisional ? 'For now: ' : ''}${times}${price}`;
}

function PlansSummary({ state, tz }) {
  const plans = state.plans.filter((p) => p.enabled || p.next?.running);
  return (
    <section className="card en-plans-sum" aria-labelledby="en-ps-h">
      <div className="en-chart-head">
        <h2 id="en-ps-h">Plans</h2>
        <a className="btn btn-quiet btn-small" href="#/energy/plans">{plans.length ? 'All plans' : 'Add a plan'}</a>
      </div>
      {!plans.length && <p className="fine">Switch a socket on at the cheapest time: say the dishwasher, for 2 hours, done by 07:00. Set the appliance going and leave it waiting on the socket.</p>}
      <ul className="en-plan-list">
        {plans.map((p) => (
          <li key={p.id} className={p.next?.running ? 'en-plan-running' : ''}>
            <Icon name={p.next?.running ? 'bolt' : 'plug'} size={18} />
            <div><strong>{p.name}</strong><span className="fine">{planNext(p, tz, state.now)}</span></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LENGTHS = [30, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];

function Plans({ state, run, arg }) {
  const [edit, setEdit] = useState(arg === 'new' ? {} : null);
  const [opts, setOpts] = useState(null);
  useEffect(() => { if (edit && !opts) api('GET', 'settings').then(setOpts).catch(() => setOpts({ switches: [] })); }, [edit, opts]);
  if (!state) return <p className="fine pad">Loading…</p>;
  const tz = state.timeZone;
  const act = (method, path, body) => run(() => api(method, path, body)).catch(() => {});
  return (
    <>
      <div className="page-head">
        <h2>Plans</h2>
        <p className="fine en-lead">Each plan switches a socket on at the cheapest time before a deadline, and off again after. Set the dishwasher or washing machine going, leave it waiting with the socket off, and it runs when electricity is cheapest.{state.limits?.kind === 'two' ? ' On your tariff that\'s the off-peak night, or earlier when Octopus adds cheap slots for the car.' : ''}</p>
      </div>
      <div className="en-plan-grid">
        {state.plans.map((p) => (
          <article key={p.id} className={`card en-plan${p.enabled ? '' : ' en-plan-off'}${p.next?.running ? ' en-plan-running' : ''}`}>
            <div className="en-plan-head">
              <span className="wifi-ap-icon"><Icon name="plug" size={22} /></span>
              <div className="en-plan-title"><h3>{p.name}</h3><span className="fine">{p.entityName}{p.on != null ? `, ${p.on ? 'on' : 'off'} now` : p.available === false ? ', not available' : ''}</span></div>
              <Toggle label={`${p.name} on`} checked={p.enabled} onChange={(v) => act('PUT', `plans/${p.id}`, { enabled: v })} />
            </div>
            <p className="en-plan-rule">{hoursText(p.minutes)}{p.together ? ' in one go' : ', can be split'}, done by {p.by}{p.repeat === 'daily' ? ', every day' : ', once'}{p.maxP != null ? `, only at ${pence(p.maxP)} or less` : ''}</p>
            <p className={`en-plan-next${p.next?.running ? ' en-plan-next-on' : ''}`}><Icon name={p.next?.running ? 'bolt' : 'clock'} size={16} />{planNext(p, tz, state.now)}</p>
            {p.next?.provisional && <p className="fine">Tomorrow's prices aren't in yet: the time may change when they are.</p>}
            {p.next?.average != null && p.next?.avg != null && p.next.average > p.next.avg && !p.next.running && <p className="fine">{Math.round((1 - p.next.avg / p.next.average) * 100)}% below the average price between now and {p.by}.</p>}
            {p.last && <p className="fine">Last: {p.last.text}, {when(p.last.at, tz, state.now)}</p>}
            <div className="en-plan-actions">
              <button type="button" className="btn btn-quiet btn-small" onClick={() => setEdit(p)}>Edit</button>
              {(p.next || p.enabled) && <button type="button" className="btn btn-quiet btn-small" onClick={() => act('POST', `plans/${p.id}/skip`)}>{p.next?.running ? 'Stop now' : 'Skip next'}</button>}
            </div>
          </article>
        ))}
        <button type="button" className="card en-plan-add" onClick={() => setEdit({})}><Icon name="plus" size={22} /><span>Add a plan</span></button>
      </div>
      {edit && <PlanSheet plan={edit} opts={opts} onClose={() => setEdit(null)}
        onSave={(body) => run(() => (edit.id ? api('PUT', `plans/${edit.id}`, body) : api('POST', 'plans', body))).then(() => setEdit(null))}
        onDelete={edit.id ? () => run(() => api('DELETE', `plans/${edit.id}`)).then(() => setEdit(null)) : null} />}
    </>
  );
}

function PlanSheet({ plan, opts, onClose, onSave, onDelete }) {
  const [v, setV] = useState({ name: plan.name || '', entity: plan.entity || '', minutes: plan.minutes || 120, by: plan.by || '07:00', together: plan.together ?? true, repeat: plan.repeat || 'daily', maxP: plan.maxP ?? '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const sw = opts?.switches || [];
  const save = async () => {
    setBusy(true); setErr(null);
    try { await onSave({ ...v, maxP: v.maxP === '' ? null : Number(v.maxP) }); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Sheet title={plan.id ? `Edit ${plan.name}` : 'Add a plan'} onClose={onClose}
      footer={<>
        {onDelete && <button type="button" className="btn btn-danger" onClick={onDelete}>Delete</button>}
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={busy || !v.name.trim() || !v.entity} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      {err && <Notice tone="error">{err}</Notice>}
      <Field label="Name" htmlFor="en-pl-name"><input id="en-pl-name" value={v.name} maxLength={40} placeholder="Dishwasher" onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
      <Field label="Socket or switch" htmlFor="en-pl-ent" help="Switched on at the start and off at the end.">
        <select id="en-pl-ent" value={v.entity} onChange={(e) => setV({ ...v, entity: e.target.value, name: v.name || (sw.find((s) => s.entity === e.target.value)?.name || '').replace(/\s*(plug|socket)$/i, '') })}>
          <option value="">{opts ? 'Choose…' : 'Loading…'}</option>
          {sw.some((s) => s.socket) && <optgroup label="Sockets">{sw.filter((s) => s.socket).map((s) => <option key={s.entity} value={s.entity}>{s.name}</option>)}</optgroup>}
          <optgroup label="Other switches">{sw.filter((s) => !s.socket).map((s) => <option key={s.entity} value={s.entity}>{s.name}</option>)}</optgroup>
        </select>
      </Field>
      <div className="field-pair">
        <Field label="Run for" htmlFor="en-pl-len">
          <select id="en-pl-len" value={v.minutes} onChange={(e) => setV({ ...v, minutes: Number(e.target.value) })}>
            {LENGTHS.map((m) => <option key={m} value={m}>{hoursText(m)}</option>)}
          </select>
        </Field>
        <Field label="Done by" htmlFor="en-pl-by"><input id="en-pl-by" type="time" value={v.by} onChange={(e) => setV({ ...v, by: e.target.value })} /></Field>
      </div>
      <Chips label="How" value={v.together ? 'one' : 'split'} onChange={(x) => setV({ ...v, together: x === 'one' })}
        options={[{ value: 'one', label: 'In one go' }, { value: 'split', label: 'Can be split up' }]} />
      <p className="fine">{v.together ? 'For things that can\'t stop part way: a dishwasher or washing machine.' : 'For things that can stop and start: a hot water tank, storage heater or battery.'}</p>
      <Chips label="When" value={v.repeat} onChange={(x) => setV({ ...v, repeat: x })}
        options={[{ value: 'daily', label: 'Every day' }, { value: 'once', label: 'Just once' }]} />
      <Field label="Only if it's this cheap (pence per kWh, optional)" htmlFor="en-pl-max" help="If there's no time at this price or less before the deadline, it doesn't run that day.">
        <input id="en-pl-max" type="number" step="0.5" inputMode="decimal" value={v.maxP} placeholder="No limit" onChange={(e) => setV({ ...v, maxP: e.target.value })} />
      </Field>
    </Sheet>
  );
}

// ---------- history ----------

function History({ state }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [table, setTable] = useState(false);
  const [pick, setPick] = useState(null);
  useEffect(() => { setData(null); setErr(null); api('GET', `history?days=${days}`).then(setData).catch((e) => setErr(e.message)); }, [days]);
  const tz = state?.timeZone || 'UTC';
  if (err) return <><div className="page-head"><h2>History</h2></div><Notice tone="error">{err}</Notice></>;
  if (!data) return <><div className="page-head"><h2>History</h2></div><p className="fine pad">Loading…</p></>;
  const cur = data.currency;
  const costs = data.costs;
  const val = (d) => (costs ? (d.elecCost || 0) + (d.gasCost || 0) : d.elecKwh || 0);
  const max = Math.max(0.01, ...data.list.map(val));
  const sum = (k) => data.list.reduce((a, d) => a + (d[k] || 0), 0);
  const n = data.list.length || 1;
  const p = pick != null ? data.list[pick] : null;
  return (
    <>
      <div className="page-head">
        <h2>History</h2>
        <Chips label="How far back" small value={days} onChange={setDays} options={[{ value: 7, label: '7 days' }, { value: 30, label: '30 days' }, { value: 90, label: '90 days' }]} />
      </div>
      {!data.dashboard ? (
        <div className="card en-empty"><Icon name="chart" size={28} /><h2>Home Assistant's Energy dashboard isn't set up</h2>
          <p className="fine">History comes from the Energy dashboard's figures. In Home Assistant, go to Settings → Dashboards → Energy and add your electricity (the Octopus "current accumulative consumption" sensor, with its cost) and gas, and each day appears here.</p></div>
      ) : (
        <>
          <div className="en-stats">
            <section className="card en-stat"><h3><Icon name="bolt" size={16} />Electricity</h3><p className="num">{costs ? money(sum('elecCost'), cur) : kwh(sum('elecKwh'))}</p><p className="fine">{costs ? `${kwh(sum('elecKwh'))} · ${money(sum('elecCost') / n, cur)} a day` : `${kwh(sum('elecKwh') / n)} a day`}</p></section>
            {data.gasUnit && <section className="card en-stat"><h3><Icon name="flame" size={16} />Gas</h3><p className="num">{data.gasCosts ? money(sum('gasCost'), cur) : `${Math.round(sum('gasKwh'))} ${data.gasUnit}`}</p><p className="fine">{data.gasCosts ? `${Math.round(sum('gasKwh'))} ${data.gasUnit} · ${money(sum('gasCost') / n, cur)} a day` : 'No gas cost in the Energy dashboard'}</p></section>}
            {costs && <section className="card en-stat"><h3><Icon name="pound" size={16} />Both</h3><p className="num">{money(sum('elecCost') + sum('gasCost'), cur)}</p><p className="fine">over {n} {n === 1 ? 'day' : 'days'}</p></section>}
          </div>
          <section className="card en-days" aria-labelledby="en-days-h">
            <div className="en-chart-head">
              <h2 id="en-days-h">{costs ? 'Cost each day' : 'Electricity each day'}</h2>
              <button type="button" className="btn btn-quiet btn-small" onClick={() => setTable((t) => !t)} aria-expanded={table}>{table ? 'Show the chart' : 'Show as a table'}</button>
            </div>
            {!table ? (
              <>
                <p className="en-tip" aria-live="polite">{p ? <><strong>{dayWord(p.day, tz)}</strong>{costs ? ` · ${money(val(p), cur)}` : ''} · electricity {costs && p.elecCost != null ? `${money(p.elecCost, cur)}, ` : ''}{kwh(p.elecKwh)}{data.gasUnit ? ` · gas ${p.gasCost != null ? `${money(p.gasCost, cur)}, ` : ''}${p.gasKwh != null ? `${Math.round(p.gasKwh * 10) / 10} ${data.gasUnit}` : '–'}` : ''}</> : 'Hover over or tap a day'}</p>
                <div className="en-daybars" role="img" aria-label={`${costs ? 'Cost' : 'Electricity used'} each day for the last ${n} days`} onPointerLeave={() => setPick(null)}>
                  {data.list.map((d, i) => (
                    <button type="button" key={d.day} className={`en-daybar${i === pick ? ' en-on' : ''}`} onPointerEnter={() => setPick(i)} onFocus={() => setPick(i)} onClick={() => setPick(i)} aria-label={`${dayWord(d.day, tz)}: ${costs ? money(val(d), cur) : kwh(d.elecKwh)}`}>
                      {costs && data.gasCosts ? (
                        <>
                          <span className="en-seg en-seg-gas" style={{ height: `${((d.gasCost || 0) / max) * 100}%` }} />
                          <span className="en-seg en-seg-elec" style={{ height: `${((d.elecCost || 0) / max) * 100}%` }} />
                        </>
                      ) : <span className="en-seg en-seg-elec" style={{ height: `${(val(d) / max) * 100}%` }} />}
                    </button>
                  ))}
                </div>
                {costs && data.gasCosts && <ul className="en-legend"><li><span className="en-swatch en-sw-elec" />Electricity</li><li><span className="en-swatch en-sw-gas" />Gas</li></ul>}
              </>
            ) : (
              <div className="en-table-wrap">
                <table className="en-table">
                  <thead><tr><th scope="col">Day</th><th scope="col">Electricity</th>{costs && <th scope="col">Cost</th>}{data.gasUnit && <th scope="col">Gas</th>}{data.gasCosts && <th scope="col">Cost</th>}</tr></thead>
                  <tbody>{[...data.list].reverse().map((d) => (
                    <tr key={d.day}><td>{dayWord(d.day, tz)}</td><td className="num">{kwh(d.elecKwh)}</td>{costs && <td className="num">{money(d.elecCost, cur)}</td>}{data.gasUnit && <td className="num">{d.gasKwh != null ? `${Math.round(d.gasKwh * 10) / 10} ${data.gasUnit}` : '–'}</td>}{data.gasCosts && <td className="num">{money(d.gasCost, cur)}</td>}</tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
          {data.devices.length > 0 && (
            <section className="card en-devices" aria-labelledby="en-dev-h">
              <h2 id="en-dev-h">What used the most</h2>
              <p className="fine">From the devices in your Energy dashboard, over the same {n} days.</p>
              <ul>
                {data.devices.map((d) => (
                  <li key={d.stat}><span className="en-dev-name">{d.name}</span><span className="en-dev-bar"><span style={{ width: `${(d.kwh / data.devices[0].kwh) * 100}%` }} /></span><span className="num">{kwh(d.kwh)}{data.totalElec ? <small> · {Math.round((d.kwh / data.totalElec) * 100)}%</small> : null}</span></li>
                ))}
              </ul>
            </section>
          )}
        </>
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
  const icon = { plan: 'plug', ev: 'car', alert: 'bell', manual: 'bolt' };
  return (
    <>
      <div className="page-head"><h2>Activity</h2></div>
      {!items && <p className="fine pad">Loading…</p>}
      {items && !items.length && <p className="fine pad">Nothing yet. Plans switching things, the car's charging and phone alerts show here.</p>}
      <ul className="cam-events">
        {items?.map((e) => (
          <li key={e.id} className={`cam-ev en-ev-${e.kind}`}>
            <span className="cam-thumb cam-thumb-none wifi-ev-icon"><Icon name={icon[e.kind] || 'list'} size={20} /></span>
            <div className="cam-ev-text">
              <span>{e.text}</span>
              <small>{when(e.at, tz)}{e.kind === 'manual' ? ' · from here' : e.kind === 'plan' ? ' · plan' : e.kind === 'ev' ? ' · car' : ''}</small>
            </div>
          </li>
        ))}
      </ul>
      {more && <button type="button" className="btn btn-quiet" onClick={() => load(items[items.length - 1].at)}>Show older</button>}
    </>
  );
}

// ---------- settings ----------

function Settings({ state, run, arg }) {
  const { item, shown } = settingsPage('energy', arg);
  const show = (id) => shown === id;
  const [view, setView] = useState(null);
  const [saved, setSaved] = useState(null);
  const [err, setErr] = useState(null);
  const [testing, setTesting] = useState(false);
  const load = useCallback(() => api('GET', 'settings').then(setView).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const put = async (body, what) => {
    setErr(null);
    try { const v = await api('PUT', 'settings', body); setView(v); setSaved(what); setTimeout(() => setSaved(null), 2500); run(() => api('GET', 'state')).catch(() => {}); } catch (e) { setErr(e.message); }
  };
  if (!view) return <SettingsFrame part="energy" item={item} shown={shown}><p className="fine pad">{err || 'Loading…'}</p></SettingsFrame>;
  const s = view.settings;
  const A = s.alerts;
  return (
    <SettingsFrame part="energy" item={item} shown={shown}>
      {err && <Notice tone="error">{err}</Notice>}

      {show('prices') && <section className="card settings-section" aria-labelledby="en-pr-h">
        <h3 id="en-pr-h">Cheap and peak prices {saved === 'bands' && <span className="saved-note" role="status">Saved</span>}</h3>
        <p className="fine">How prices are coloured on the chart and the dashboard card, and what "cheap" means for phone alerts.</p>
        <Chips label="Bands" value={s.bands.mode} onChange={(m) => put({ bands: { mode: m } }, 'bands')}
          options={[{ value: 'auto', label: 'Worked out from the prices' }, { value: 'fixed', label: 'Set by hand' }]} />
        <p className="fine">{s.bands.mode === 'auto'
          ? `With two rates (like Intelligent Octopus Go) the lower is cheap and the other standard. With Agile, the cheapest quarter of the day is cheap and the dearest seventh peak.${state?.limits?.cheap != null ? ` Now: cheap is ${pence(state.limits.cheap)} or less${state.limits.peak != null ? `, peak ${pence(state.limits.peak)} or more` : ''}.` : ''}`
          : 'Prices at or below the first are cheap; at or above the second, peak.'}</p>
        {s.bands.mode === 'fixed' && <BandInputs bands={s.bands} onSave={(b) => put({ bands: b }, 'bands')} />}
      </section>}

      {show('alerts') && <section className="card settings-section" aria-labelledby="en-al-h">
        <h3 id="en-al-h">Phone alerts {saved === 'alerts' && <span className="saved-note" role="status">Saved</span>}</h3>
        <p className="fine">Which phones to tell (from Home Assistant's notify services: the Home Assistant app on each phone is listed first).</p>
        <div className="cam-checks">
          {view.phones.map((ph) => (
            <label key={ph.service}>
              <input type="checkbox" checked={A.notify.includes(ph.service)} onChange={(e) => put({ alerts: { notify: e.target.checked ? [...A.notify, ph.service] : A.notify.filter((x) => x !== ph.service) } }, 'alerts')} />
              <span>{ph.name}</span><small>{ph.service}</small>
            </label>
          ))}
          {!view.phones.length && <p className="fine">No phones found. Install the Home Assistant app on a phone and sign in, and it appears here.</p>}
        </div>
        <CheapBelow value={A.cheapBelow} onSave={(v) => put({ alerts: { cheapBelow: v } }, 'alerts')} />
        <Toggle label="Tomorrow's prices when they come in" checked={A.tomorrow} onChange={(v) => put({ alerts: { tomorrow: v } }, 'alerts')}
          description="For prices that change each day (Agile, Tracker): the cheapest 3 hours and the dearest time, at about 4pm. Not sent for two-rate tariffs, where every day's the same." />
        <Toggle label="When a plan switches something on" checked={A.plans} onChange={(v) => put({ alerts: { plans: v } }, 'alerts')} />
        <div><button type="button" className="btn btn-quiet" disabled={!A.notify.length || testing} onClick={async () => { setTesting(true); setErr(null); try { await api('POST', 'alerts/test'); } catch (e) { setErr(e.message); } setTesting(false); }}>{testing ? 'Sending…' : 'Send a test alert'}</button></div>
      </section>}

      {show('sources') && <section className="card settings-section" aria-labelledby="en-src-h">
        <h3 id="en-src-h">Where the figures come from {saved === 'src' && <span className="saved-note" role="status">Saved</span>}</h3>
        <h4 className="en-h4">Octopus Energy integration</h4>
        {view.meters.length ? (
          <>
            <p className="fine">Prices, today's cost (with a Home Mini) and the car.</p>
            {view.meters.length > 1 ? (
              <Field label="Electricity meter" htmlFor="en-meter">
                <select id="en-meter" value={s.meter || view.meters[0].key} onChange={(e) => put({ meter: e.target.value }, 'src')}>
                  {view.meters.map((m) => <option key={m.key} value={m.key}>{m.key.split('_').pop()} ({m.tariff || 'tariff unknown'})</option>)}
                </select>
              </Field>
            ) : <p className="fine">Electricity meter {view.meters[0].key.split('_').pop()}: {view.meters[0].tariff || view.meters[0].code || 'tariff unknown'}.</p>}
            {view.gasMeters.length > 0 && <p className="fine">Gas meter {view.gasMeters[0].key.split('_').pop()}.</p>}
            <p className="fine">{view.ev ? 'Intelligent Octopus: the car\'s charging is shown on the Today page.' : 'No Intelligent Octopus car or charger found.'}</p>
          </>
        ) : <p className="fine">Not found. Add the Octopus Energy integration (HACS, by BottlecapDave) for prices, today's cost and the car.</p>}
        <h4 className="en-h4">Home Assistant's Energy dashboard</h4>
        {view.dashboard.electricity.length ? (
          <ul className="en-src-list">
            {view.dashboard.electricity.map((e) => <li key={e.stat}><Icon name="bolt" size={16} />{e.name}{e.cost ? ', with its cost' : ', no cost set'}</li>)}
            {view.dashboard.gas.map((e) => <li key={e.stat}><Icon name="flame" size={16} />{e.name}{e.cost ? ', with its cost' : ', no cost set'}</li>)}
            {view.dashboard.devices > 0 && <li><Icon name="plug" size={16} />{view.dashboard.devices} {view.dashboard.devices === 1 ? 'device' : 'devices'}, for What used the most</li>}
          </ul>
        ) : <p className="fine">Not set up. In Home Assistant: Settings → Dashboards → Energy. It's what the History page uses, for any supplier.</p>}
        <div><button type="button" className="btn btn-quiet" onClick={() => run(() => api('POST', 'refresh')).then(load).catch(() => {})}>Look again</button></div>
      </section>}

      {show('card') && <section className="card settings-section" aria-labelledby="en-card-h">
        <h3 id="en-card-h">Dashboard card {saved === 'card' && <span className="saved-note" role="status">Saved</span>}</h3>
        <p className="fine">The Home Control card on a Home Assistant dashboard, with <code>show: energy</code>.</p>
        <Toggle label="The prices chart" checked={s.card.chart} onChange={(v) => put({ card: { chart: v } }, 'card')} />
        <Toggle label="The car" checked={s.card.ev} onChange={(v) => put({ card: { ev: v } }, 'card')} description="Its charging, with a bump charge button." />
        <Toggle label="Plans" checked={s.card.plans} onChange={(v) => put({ card: { plans: v } }, 'card')} description="When each runs next." />
        <pre className="en-code">{'type: custom:home-control-card\nshow: energy'}</pre>
      </section>}
    </SettingsFrame>
  );
}

function BandInputs({ bands, onSave }) {
  const [v, setV] = useState({ cheap: bands.cheap, peak: bands.peak });
  useEffect(() => { setV({ cheap: bands.cheap, peak: bands.peak }); }, [bands.cheap, bands.peak]);
  const dirty = Number(v.cheap) !== bands.cheap || Number(v.peak) !== bands.peak;
  return (
    <div className="en-band-inputs">
      <div className="field-pair">
        <Field label="Cheap at or below (p)" htmlFor="en-b-c"><input id="en-b-c" type="number" step="0.5" inputMode="decimal" value={v.cheap} onChange={(e) => setV({ ...v, cheap: e.target.value })} /></Field>
        <Field label="Peak at or above (p)" htmlFor="en-b-p"><input id="en-b-p" type="number" step="0.5" inputMode="decimal" value={v.peak} onChange={(e) => setV({ ...v, peak: e.target.value })} /></Field>
      </div>
      {dirty && <button type="button" className="btn btn-primary" onClick={() => onSave({ cheap: Number(v.cheap), peak: Number(v.peak) })}>Save</button>}
    </div>
  );
}

function CheapBelow({ value, onSave }) {
  const [on, setOn] = useState(value != null);
  const [v, setV] = useState(value ?? 10);
  useEffect(() => { setOn(value != null); if (value != null) setV(value); }, [value]);
  return (
    <div className="en-cheap-below">
      <Toggle label="When electricity gets cheap" checked={on} onChange={(x) => { setOn(x); onSave(x ? Number(v) : null); }}
        description="When the price falls to this or below (once each time it does). At 0p or less, Octopus is paying you to use it." />
      {on && (
        <div className="en-inline-save">
          <Field label="At or below (pence per kWh)" htmlFor="en-cb"><input id="en-cb" type="number" step="0.5" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} /></Field>
          {Number(v) !== value && <button type="button" className="btn btn-primary" onClick={() => onSave(Number(v))}>Save</button>}
        </div>
      )}
    </div>
  );
}
