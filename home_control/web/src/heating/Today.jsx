import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, deg } from './lib.js';

// ---------- data ----------
export function useToday(enabled) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let stop = false;
    const load = async () => {
      try {
        const d = await api('today');
        if (stop) return;
        if (d.error) setError(d.error); else { setData(d); setError(null); }
      } catch (e) { if (!stop) setError(e.message); }
    };
    load();
    const t = setInterval(load, 120000);
    return () => { stop = true; clearInterval(t); };
  }, [enabled]);
  return [data, error];
}

const money = (v, unit) => {
  if (v == null) return '–';
  const sym = { GBP: '£', EUR: '€', USD: '$' }[unit] ?? (unit === '£' ? '£' : '');
  return sym ? `${sym}${v.toFixed(2)}` : `${v.toFixed(2)} ${unit}`;
};
const hm = (mins) => (mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`);
const clock = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));

// ---------- side cards ----------
export function SideCards({ state, today }) {
  const ex = state.extras || {};
  const outsideSeries = (today?.outside?.series || []).filter((v) => v != null);
  const lo = outsideSeries.length ? Math.min(...outsideSeries) : null;
  const hi = outsideSeries.length ? Math.max(...outsideSeries) : null;
  return (
    <div className="side-cards">
      <section className="stat" aria-label="Gas cost">
        <h2>Gas today</h2>
        {ex.cost ? (
          <>
            <p className="stat-num num">{money(ex.cost.today, ex.cost.unit)}</p>
            <p className="stat-sub">{today?.cost?.yesterday != null ? `${money(today.cost.yesterday, ex.cost.unit)} yesterday` : 'So far today'}</p>
          </>
        ) : <p className="stat-sub">No gas cost sensor found. <a href="#/settings/sources">Choose one in Settings</a></p>}
      </section>
      <section className="stat" aria-label="Boiler today">
        <h2>Boiler today</h2>
        {state.boiler.entity ? (
          <>
            <p className="stat-num num">{today ? hm(today.boilerTodayMinutes) : '–'}</p>
            <p className="stat-sub">{state.boiler.on ? 'Firing now' : 'Resting now'}{today?.boilerFiresToday ? ` · fired ${today.boilerFiresToday === 1 ? 'once' : today.boilerFiresToday === 2 ? 'twice' : `${today.boilerFiresToday} times`}` : ''}</p>
          </>
        ) : <p className="stat-sub"><a href="#/settings/boiler">Choose your boiler in Settings</a></p>}
      </section>
      <section className="stat" aria-label="Outside">
        <h2>Outside</h2>
        {ex.outside ? (
          <>
            <p className="stat-num num">{deg(ex.outside.now)}</p>
            <p className="stat-sub">{lo != null ? `Between ${deg(lo, 0)} and ${deg(hi, 0)} in the last day` : 'Now'}</p>
          </>
        ) : <p className="stat-sub">No outside temperature found. <a href="#/settings/sources">Choose one in Settings</a></p>}
      </section>
    </div>
  );
}

// ---------- chart ----------
// Callback ref: the chart div mounts after data loads, so observe it whenever it appears.
function useWidth() {
  const [w, setW] = useState(0);
  const ro = useRef(null);
  const ref = useCallback((el) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(Math.max(260, Math.round(el.getBoundingClientRect().width)));
    ro.current = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.current.observe(el);
  }, []);
  return [ref, w];
}

function linePath(values, x, y) {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}
function stepPath(values, x, y) {
  let d = '';
  let prev = null;
  values.forEach((v, i) => {
    if (v == null) { prev = null; return; }
    if (prev == null) d += `M${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    else if (v !== prev) d += `H${x(i).toFixed(1)}V${y(v).toFixed(1)}`;
    else d += `H${x(i).toFixed(1)}`;
    prev = v;
  });
  return d;
}


const ROOM_KEY = 'hc-chart-room';
const METRIC_KEY = 'hc-chart-metric';
const ALL = 'all';
const METRICS = [
  { id: 'temp', label: 'Temperature', title: 'Temperature' },
  { id: 'target', label: 'Target', title: 'Target' },
  { id: 'diff', label: 'vs target', title: 'Above or below target' },
];
// why a room started heating, as recorded with each heat-up
const WHY = { schedule: 'schedule', preheat: 'warming early', boost: 'boost', hold: 'hold', manual: 'changed on the radiator', away: 'away', snooze: 'snooze', 'no-schedule': 'no schedule' };
const LANE = 19; // "Calling for heat" lanes under the All rooms chart: name line + bar
const SLOTS = 8; // validated categorical colours --s1…--s8; a 9th room onwards is drawn neutral, never a made-up hue
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const signed = (v) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}°`);

// One line per room for the chosen measure. Colour follows the room's place in the
// room list, so it never changes when you highlight one or switch measure.
function roomSeries(rooms, metric) {
  return rooms.map((r, k) => ({
    id: r.id,
    name: r.name,
    color: k < SLOTS ? `var(--s${k + 1})` : 'var(--ink-2)',
    values: metric === 'temp' ? r.temps
      : metric === 'target' ? r.targets
      : r.temps.map((v, i) => (v == null || r.targets[i] == null ? null : Math.round((v - r.targets[i]) * 10) / 10)),
  }));
}

export function TodayChart({ state, today, error }) {
  const rooms = today?.rooms || [];
  const [roomId, setRoomId] = useState(() => recall(ROOM_KEY) || ALL);
  const [metric, setMetric] = useState(() => (METRICS.some((m) => m.id === recall(METRIC_KEY)) ? recall(METRIC_KEY) : 'temp'));
  const [focus, setFocus] = useState(null);
  const isAll = roomId === ALL && rooms.length > 1;
  const room = isAll ? null : rooms.find((r) => r.id === roomId) || rooms[0];
  const series = useMemo(() => (isAll ? roomSeries(rooms, metric) : []), [isAll, rooms, metric]);
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const tz = state.timeZone;
  const fmt = metric === 'diff' && isAll ? signed : (v) => deg(v);
  const mInfo = METRICS.find((m) => m.id === metric);

  const pick = (id) => { setRoomId(id); setHover(null); setFocus(null); remember(ROOM_KEY, id); };
  const pickMetric = (id) => { setMetric(id); setHover(null); remember(METRIC_KEY, id); };

  const geo = useMemo(() => {
    if (!today || (!room && !isAll) || !width) return null;
    const H = 240;
    const m = { l: 34, r: 10, t: 10, b: 24 };
    const n = today.times.length;
    const outside = today.outside?.series || [];
    const vals = (isAll ? series.flatMap((s) => s.values) : [...room.temps, ...room.targets, ...outside]).filter((v) => v != null);
    if (!vals.length) return null;
    let lo;
    let hi;
    if (isAll && metric === 'diff') {
      // always include the zero line ("on target"), at least ±1° either side of it
      lo = Math.min(-1, Math.floor(Math.min(...vals) - 0.3));
      hi = Math.max(1, Math.ceil(Math.max(...vals) + 0.3));
      if (hi - lo < 4) { if (-lo > hi) lo = hi - 4; else hi = lo + 4; }
    } else {
      lo = Math.floor(Math.min(...vals) - 0.5);
      hi = Math.ceil(Math.max(...vals) + 0.5);
      if (hi - lo < 6) { const mid = (hi + lo) / 2; lo = Math.floor(mid - 3); hi = Math.ceil(mid + 3); }
    }
    const x = (i) => m.l + (i / (n - 1)) * (width - m.l - m.r);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const tx = (t) => x(((t - today.from) / (today.to - today.from)) * (n - 1));
    const span = hi - lo;
    const stepDeg = span <= 5 ? 1 : span > 14 ? 4 : 2;
    const yTicks = [];
    for (let v = Math.ceil(lo / stepDeg) * stepDeg; v <= hi; v += stepDeg) yTicks.push(v);
    const xTicks = today.times.map((t, i) => ({ t, i })).filter(({ t }) => {
      const hhmm = clock(t, tz);
      return hhmm.endsWith(':00') && Number(hhmm.slice(0, 2)) % (width < 520 ? 6 : 3) === 0;
    });
    // up to four rooms also get their name at the end of the line, nudged apart so they never overlap
    let labels = [];
    if (isAll && series.length <= 4) {
      labels = series.map((s) => {
        let i = s.values.length - 1;
        while (i >= 0 && s.values[i] == null) i--;
        return i < 0 ? null : { id: s.id, name: s.name, color: s.color, x: x(i), y: y(s.values[i]) };
      }).filter(Boolean).sort((a, b) => a.y - b.y);
      for (let k = 0; k < labels.length; k++) labels[k].ly = Math.max(labels[k].y - 8, k ? labels[k - 1].ly + 14 : m.t + 10);
      for (let k = labels.length - 1; k >= 0; k--) labels[k].ly = Math.min(labels[k].ly, k < labels.length - 1 ? labels[k + 1].ly - 14 : H - m.b - 4);
    }
    // All rooms: one lane per room showing when it called for heat, on the same time axis
    let lanes = null;
    if (isAll) {
      const rows = rooms.map((r, k) => ({
        id: r.id, name: r.name, color: series[k]?.color || 'var(--ink-2)',
        calls: (r.calls || []).filter(([a, b]) => b > today.from && a < today.to),
      }));
      lanes = { top: H + 6, rows, h: 22 + rows.length * LANE };
    }
    const total = H + (lanes ? lanes.h : 0);
    return { H, total, m, n, x, y, tx, yTicks, xTicks, outside, labels, lanes };
  }, [today, room, rooms, isAll, series, metric, width, tz]);

  if (error) return <section className="chart-card"><h2>Today</h2><p className="stat-sub">{error}</p></section>;
  if (!today) return <section className="chart-card"><h2>Today</h2><p className="stat-sub">Loading the last 24 hours…</p></section>;
  if (!room && !isAll) return null;

  const { H, total, m, x, y, tx, yTicks, xTicks, outside, labels, lanes } = geo || { H: 240, total: 240, m: { l: 0, r: 0, t: 0, b: 0 }, x: () => 0, y: () => 0, tx: () => 0, yTicks: [], xTicks: [], outside: [], labels: [], lanes: null };
  const onMove = (e) => {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - m.l) / (width - m.l - m.r)) * (geo.n - 1));
    if (i < 0 || i >= geo.n) return setHover(null);
    setHover(i);
  };
  const firingAt = (t) => today.boilerRuns.some(([a, b]) => t >= a && t <= b);
  const callAt = (r, t) => (r.calls || []).find(([a, b]) => t >= a && t <= b);
  const callersAt = (t) => rooms.map((r) => ({ r, c: callAt(r, t) })).filter((x) => x.c).sort((p, q) => p.c[0] - q.c[0])
    .map(({ r, c }) => ({ id: r.id, name: r.name, start: c[0], why: WHY[c[2]] || null }));
  // "Lounge, Office (schedule), Kitchen (boost)": rooms grouped by why they were heating, earliest first
  const callersText = (list) => {
    const groups = [];
    for (const c of list) { const g = groups.find((x) => x.why === c.why); if (g) g.names.push(c.name); else groups.push({ why: c.why, names: [c.name] }); }
    return groups.map((g) => `${g.names.join(', ')}${g.why ? ` (${g.why})` : ''}`).join(', ');
  };
  // what set the boiler off: rooms already calling when this run started; the rest joined later
  const whyFiring = (t) => {
    const callers = callersAt(t);
    const run = today.boilerRuns.find(([a, b]) => t >= a && t <= b);
    if (!run) return callers.length ? { fire: false, text: `Calling for heat: ${callersText(callers)}`, callers } : null;
    const by = callers.filter((c) => c.start <= run[0] + 60000);
    const later = callers.filter((c) => c.start > run[0] + 60000);
    if (!callers.length) return { fire: true, text: 'Boiler firing', callers };
    if (!by.length) return { fire: true, text: `Boiler firing for ${callersText(callers)}`, callers };
    return { fire: true, text: `Fired by ${callersText(by)}${later.length ? ` · then ${callersText(later)}` : ''}`, callers };
  };
  const hv = hover != null ? {
    t: today.times[hover], fire: firingAt(today.times[hover]),
    ...(isAll
      ? {
        rows: series.map((s, k) => ({ ...s, v: s.values[hover], calling: !!callAt(rooms[k], today.times[hover]) })).sort((a, b) => (b.v ?? -1e9) - (a.v ?? -1e9)),
        why: whyFiring(today.times[hover]),
      }
      : { temp: room.temps[hover], target: room.targets[hover], out: outside[hover] }),
  } : null;
  const tipW = isAll ? 210 : 160;
  const tipLeft = hover != null ? Math.min(Math.max(x(hover) - tipW / 2, 4), width - tipW - 4) : 0;
  const pathFor = isAll && metric === 'target' ? stepPath : linePath;
  // the highlighted room is drawn last so it sits on top
  const drawOrder = focus ? [...series.filter((s) => s.id !== focus), ...series.filter((s) => s.id === focus)] : series;
  const dim = (id) => (focus && focus !== id ? ' dimmed' : '');
  // Rooms often share a target, so their step lines would sit exactly on top of each other.
  // Each room's target line is nudged a couple of pixels (by its fixed place in the list) so
  // shared targets show as a striped band; exact values are in the tooltip and table.
  const nudge = (id) => (series.findIndex((s) => s.id === id) - (series.length - 1) / 2) * 2.5;
  const title = isAll ? `All rooms: ${mInfo.title.toLowerCase()}` : `the ${room.name}`;

  return (
    <section className="chart-card" aria-label={`Today in ${title}`}>
      <div className="chart-head">
        <h2>Last 24 hours</h2>
        <button className="btn link" onClick={() => setTable((v) => !v)}>{table ? 'Show chart' : 'Show as table'}</button>
      </div>
      <nav className="room-picker" aria-label="Room to chart">
        {rooms.length > 1 && <button className="chip" aria-pressed={isAll} onClick={() => pick(ALL)}>All rooms</button>}
        {rooms.map((r) => <button key={r.id} className="chip" aria-pressed={!isAll && r.id === room.id} onClick={() => pick(r.id)}>{r.name}</button>)}
      </nav>

      {isAll && (
        <div className="metric-row">
          <div className="seg" role="group" aria-label="What to show for each room">
            {METRICS.map((mm) => <button key={mm.id} aria-pressed={metric === mm.id} onClick={() => pickMetric(mm.id)}>{mm.label}</button>)}
          </div>
          {metric === 'diff' && <p className="metric-note">Above the 0° line: warmer than its target. Below: cooler.</p>}
        </div>
      )}

      {isAll ? (
        <div className="legend-row" aria-hidden={table}>
          {series.map((s) => (
            <button key={s.id} className={`legend-btn${dim(s.id)}`} aria-pressed={focus === s.id}
              onClick={() => setFocus((f) => (f === s.id ? null : s.id))} title={focus === s.id ? 'Show every room' : `Highlight ${s.name}`}>
              <i className="sw sw-line" style={{ '--c': s.color }} />{s.name}
            </button>
          ))}
          {state.boiler.entity && <span><i className="sw sw-fire" />Boiler firing</span>}
        </div>
      ) : (
        <div className="legend-row" aria-hidden={table}>
          <span><i className="sw sw-room" />In the room</span>
          <span><i className="sw sw-target" />Target</span>
          {today.outside && <span><i className="sw sw-out" />Outside</span>}
          {state.boiler.entity && <span><i className="sw sw-fire" />Boiler firing</span>}
        </div>
      )}

      {table ? (
        <div className="table-wrap">
          <table className="data-table">
            {isAll ? (
              <>
                <caption className="sr-only">{mInfo.title} in each room, every hour</caption>
                <thead><tr><th>Time</th>{series.map((s) => <th key={s.id}>{s.name}</th>)}<th>Boiler</th></tr></thead>
                <tbody>
                  {today.times.map((t, i) => ({ t, i })).filter(({ i }) => i % 12 === 0).reverse().map(({ t, i }) => (
                    <tr key={t}><td>{clock(t, tz)}</td>{series.map((s) => <td key={s.id}>{fmt(s.values[i])}</td>)}<td>{firingAt(t) ? (whyFiring(t)?.text || 'Firing') : ''}</td></tr>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead><tr><th>Time</th><th>In the room</th><th>Target</th>{today.outside && <th>Outside</th>}<th>Boiler</th></tr></thead>
                <tbody>
                  {today.times.map((t, i) => ({ t, i })).filter(({ i }) => i % 12 === 0).reverse().map(({ t, i }) => (
                    <tr key={t}><td>{clock(t, tz)}</td><td>{deg(room.temps[i])}</td><td>{deg(room.targets[i])}</td>{today.outside && <td>{deg(outside[i])}</td>}<td>{firingAt(t) ? 'Firing' : ''}</td></tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      ) : (
        <div className="chart" ref={ref}>
          {geo && <svg width={width} height={total} role="img"
            aria-label={isAll ? `${mInfo.title} in each room over the last 24 hours, with when each room called for heat` : `${room.name}: temperature, target and outside over the last 24 hours`}
            onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
            {today.boilerRuns.map(([a, b], k) => (
              <rect key={k} className="fire-band" x={tx(Math.max(a, today.from))} y={m.t} width={Math.max(1.5, tx(Math.min(b, today.to)) - tx(Math.max(a, today.from)))} height={(lanes ? total - 4 : H - m.b) - m.t} />
            ))}
            {yTicks.map((v) => (
              <g key={v}>
                <line className={`grid${isAll && metric === 'diff' && v === 0 ? ' zero' : ''}`} x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
                <text className="axis" x={m.l - 6} y={y(v) + 4} textAnchor="end">{isAll && metric === 'diff' ? (v === 0 ? '0°' : `${v > 0 ? '+' : '−'}${Math.abs(v)}°`) : `${v}°`}</text>
              </g>
            ))}
            {xTicks.map(({ t, i }) => <text key={t} className="axis" x={x(i)} y={H - 6} textAnchor="middle">{clock(t, tz)}</text>)}

            {isAll ? (
              <>
                {drawOrder.map((s) => (
                  <path key={s.id} className={`ln ln-series${dim(s.id)}${focus === s.id ? ' focused' : ''}`}
                    style={{ '--c': s.color }} d={pathFor(s.values, x, y)}
                    transform={metric === 'target' ? `translate(0 ${nudge(s.id)})` : undefined} />
                ))}
                {labels.map((l) => (
                  <g key={l.id} className={dim(l.id).trim()}>
                    <circle className="dot" cx={l.x} cy={l.y} r="3.5" style={{ fill: l.color }} />
                    <text className="end-label" x={l.x - 7} y={l.ly + 4} textAnchor="end">{l.name}</text>
                  </g>
                ))}
                {lanes && (
                  <g className="lanes">
                    <text className="lane-title" x={m.l} y={lanes.top + 10}>Calling for heat</text>
                    {lanes.rows.map((r, k) => {
                      const y0 = lanes.top + 18 + k * LANE;
                      return (
                        <g key={r.id} className={dim(r.id).trim()}>
                          <text className="lane-label" x={m.l} y={y0 + 8}>{r.name}</text>
                          <rect className="lane-track" x={m.l} y={y0 + 11} width={width - m.l - m.r} height="5" rx="2.5" />
                          {r.calls.map(([a, b], j) => {
                            const x0 = tx(Math.max(a, today.from));
                            return <rect key={j} className="lane-bar" x={x0} y={y0 + 11} width={Math.max(3, tx(Math.min(b, today.to)) - x0)} height="5" rx="2" style={{ fill: r.color }} />;
                          })}
                        </g>
                      );
                    })}
                  </g>
                )}
                {hv && (
                  <g>
                    <line className="cross" x1={x(hover)} x2={x(hover)} y1={m.t} y2={lanes ? total - 4 : H - m.b} />
                    {hv.rows.filter((r) => r.v != null).map((r) => (
                      <circle key={r.id} className={`dot${dim(r.id)}`} cx={x(hover)} cy={y(r.v)} r="4" style={{ fill: r.color }} />
                    ))}
                  </g>
                )}
              </>
            ) : (
              <>
                {today.outside && <path className="ln ln-out" d={linePath(outside, x, y)} />}
                <path className="ln ln-target" d={stepPath(room.targets, x, y)} />
                <path className="ln ln-room" d={linePath(room.temps, x, y)} />
                {hv && (
                  <g>
                    <line className="cross" x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} />
                    {hv.out != null && <circle className="dot dot-out" cx={x(hover)} cy={y(hv.out)} r="4" />}
                    {hv.target != null && <circle className="dot dot-target" cx={x(hover)} cy={y(hv.target)} r="4" />}
                    {hv.temp != null && <circle className="dot dot-room" cx={x(hover)} cy={y(hv.temp)} r="4.5" />}
                  </g>
                )}
              </>
            )}
          </svg>}
          {hv && geo && (
            <div className="tip" style={{ left: tipLeft, width: tipW }} role="status">
              <b>{clock(hv.t, tz)}{isAll ? ` · ${mInfo.title.toLowerCase()}` : ''}</b>
              {isAll ? hv.rows.map((r) => (
                <span key={r.id} className={dim(r.id).trim()}><i className="sw sw-line" style={{ '--c': r.color }} />{r.name}{r.calling && <i className="tip-heat" title="calling for heat" aria-label="calling for heat" />} <em>{fmt(r.v)}</em></span>
              )) : (
                <>
                  <span><i className="sw sw-room" />In the room <em>{deg(hv.temp)}</em></span>
                  <span><i className="sw sw-target" />Target <em>{deg(hv.target)}</em></span>
                  {today.outside && <span><i className="sw sw-out" />Outside <em>{deg(hv.out)}</em></span>}
                </>
              )}
              {isAll && hv.why && (
                <span className="tip-why"><i className={`sw ${hv.why.fire ? 'sw-fire' : 'sw-heat-sm'}`} />{hv.why.text}</span>
              )}
              {hv.fire && !(isAll && hv.why) && <span><i className="sw sw-fire" />Boiler firing</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
