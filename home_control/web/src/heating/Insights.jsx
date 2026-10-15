import { useCallback, useEffect, useRef, useState } from 'react';
import { api, deg } from './lib.js';

// ---------- formatting ----------
const sym = (u) => ({ GBP: '£', EUR: '€', USD: '$' }[u] ?? '');
const money = (v, u) => (v == null ? '–' : `${sym(u)}${v.toFixed(2)}${sym(u) ? '' : ` ${u}`}`);
const perDeg = (v, u) => (v == null ? '–' : u === 'GBP' && v < 1 ? `${Math.round(v * 100)}p` : money(v, u));
const hours = (h) => (h == null ? '–' : h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`);
const dayLabel = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', opts);
function change(cur, prev, { lowerIsBetter = true, unit = '' } = {}) {
  if (cur == null || prev == null || prev === 0) return null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (Math.abs(pct) < 2) return { text: 'about the same as the week before', tone: 'flat' };
  const better = lowerIsBetter ? pct < 0 : pct > 0;
  return { text: `${Math.abs(pct)}% ${pct < 0 ? 'less' : 'more'} than the week before${unit}`, tone: better ? 'good' : 'bad' };
}

function useWidth() {
  const [w, setW] = useState(0);
  const ro = useRef(null);
  const ref = useCallback((el) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    ro.current = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.current.observe(el);
  }, []);
  return [ref, w];
}

// ---------- a simple daily bar chart with hover details ----------
function DailyBars({ days, value, format, colorVar, label, avg, tip }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const H = 190;
  const m = { l: 44, r: 8, t: 10, b: 24 };
  const vals = days.map(value).filter((v) => v != null);
  const max = vals.length ? Math.max(...vals) : 1;
  const step = niceStep(max / 4);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const n = days.length;
  const bw = width ? (width - m.l - m.r) / n : 0;
  const y = (v) => m.t + (1 - v / top) * (H - m.t - m.b);
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - m.l) / bw);
    setHover(i >= 0 && i < n ? i : null);
  };
  const h = hover != null ? days[hover] : null;
  return (
    <div className="chart" ref={ref} style={{ minHeight: H }}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={label} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
              <text className="axis" x={m.l - 6} y={y(v) + 4} textAnchor="end">{format(v, true)}</text>
            </g>
          ))}
          {days.map((d, i) => {
            const v = value(d);
            const x = m.l + i * bw + Math.max(1, bw * 0.12);
            const w = Math.max(2, bw * 0.76);
            if (v == null) return <rect key={d.date} className="bar-missing" x={x} y={H - m.b - 3} width={w} height={3} rx="1.5" />;
            const top0 = y(v);
            return (
              <rect key={d.date} className={`bar${d.partial ? ' partial' : ''}${hover === i ? ' hot' : ''}`} style={{ '--bar': `var(${colorVar})` }}
                x={x} y={top0} width={w} height={Math.max(0, H - m.b - top0)} rx={Math.min(4, w / 2)} />
            );
          })}
          {avg != null && <line className="avg-line" x1={m.l} x2={width - m.r} y1={y(avg)} y2={y(avg)} />}
          {days.map((d, i) => (i % Math.ceil(n / (width < 520 ? 4 : 8)) === 0 || i === n - 1) && (
            <text key={d.date} className="axis" x={m.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">{i === n - 1 ? 'Today' : dayLabel(d.date, { day: 'numeric', month: 'short' })}</text>
          ))}
        </svg>
      )}
      {h && (
        <div className="tip" style={{ left: Math.min(Math.max(m.l + hover * bw - 70, 4), width - 184), width: 180 }} role="status">
          <b>{hover === n - 1 ? 'Today so far' : dayLabel(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b>
          {tip(h)}
        </div>
      )}
    </div>
  );
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// ---------- page ----------
export default function Insights({ state }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () => api('insights').then((d) => { if (!stop) { setData(d); setError(null); } }).catch((e) => !stop && setError(e.message));
    load();
    const t = setInterval(load, 5 * 60000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  if (error) return <div className="banner">Couldn't load insights: {error}</div>;
  if (!data) return <p className="mode-note">Gathering the last 30 days…</p>;

  const u = data.unit;
  const tw = data.thisWeek, lw = data.lastWeek;
  // only compare weeks when both have enough recorded days; otherwise say what's missing
  const ok = (a, b) => a >= 5 && b >= 5;
  const costChange = change(tw.cost, lw.cost);
  const effChange = ok(tw.costPerDDDays, lw.costPerDDDays) ? change(tw.costPerDD, lw.costPerDD) : null;
  const boilerChange = ok(tw.boilerDays, lw.boilerDays) ? change(tw.boilerHours, lw.boilerHours) : null;
  const effNote = tw.costPerDD == null ? 'Needs outside temperatures'
    : `The week before only has ${lw.costPerDDDays} day${lw.costPerDDDays === 1 ? '' : 's'} with outside temperatures to compare`;
  const boilerNote = tw.boilerHours == null ? 'Not recorded yet' : `The week before only has ${lw.boilerDays} recorded day${lw.boilerDays === 1 ? '' : 's'}`;
  const ddDays = data.days.filter((d) => d.costPerDD != null && !d.partial);
  const avgPerDD = ddDays.length ? ddDays.reduce((a, d) => a + d.costPerDD, 0) / ddDays.length : null;
  const rooms = data.rooms;
  const pick = (f, cmp) => rooms.filter((r) => f(r) != null).sort((a, b) => cmp(f(a), f(b)))[0];
  const slowest = pick((r) => r.warmRate, (a, b) => a - b);
  const overshooter = pick((r) => r.overshoot, (a, b) => b - a);
  const busiest = pick((r) => (r.heatingHours > 0 ? r.heatingHours : null), (a, b) => b - a);

  return (
    <>
      {!data.sources.cost && <div className="banner info">No gas cost sensor found, so costs are missing. Choose one in <a href="#/settings">Settings</a>.</div>}

      <div className="side-cards insights-cards">
        <section className="stat">
          <h2>Gas, last 7 days</h2>
          <p className="stat-num num">{money(tw.cost, u)}</p>
          <p className={`stat-sub tone-${costChange?.tone || 'flat'}`}>{costChange ? costChange.text : lw.cost != null ? `${money(lw.cost, u)} the week before` : 'Not enough history yet'}</p>
        </section>
        <section className="stat">
          <h2>Per cold degree</h2>
          <p className="stat-num num">{perDeg(tw.costPerDD, u)}</p>
          <p className={`stat-sub tone-${effChange?.tone || 'flat'}`}>
            {effChange ? effChange.text : effNote}
            {effChange && tw.costPerDDDays < 7 ? ` (from ${tw.costPerDDDays} of 7 days)` : ''}
          </p>
        </section>
        <section className="stat">
          <h2>Boiler, last 7 days</h2>
          <p className="stat-num num">{hours(tw.boilerHours)}</p>
          <p className={`stat-sub tone-${boilerChange?.tone || 'flat'}`}>{boilerChange ? boilerChange.text : boilerNote}</p>
        </section>
      </div>

      <section className="chart-card">
        <div className="chart-head">
          <h2>Gas cost per day</h2>
          <button className="btn link" onClick={() => setTable((v) => !v)}>{table ? 'Show charts' : 'Show as table'}</button>
        </div>
        {table ? <DaysTable data={data} /> : (
          <>
            <div className="legend-row"><span><i className="sw sw-bar" style={{ '--bar': 'var(--c-room)' }} />Cost</span><span><i className="sw sw-bar partial" style={{ '--bar': 'var(--c-room)' }} />Today so far</span></div>
            <DailyBars days={data.days} value={(d) => d.cost} colorVar="--c-room" label="Gas cost per day for the last 30 days"
              format={(v, axis) => (axis ? `${sym(u)}${v % 1 ? v.toFixed(2) : v}` : money(v, u))}
              tip={(d) => (<>
                <span>Cost <em>{money(d.cost, u)}</em></span>
                <span>Outside <em>{d.outside != null ? deg(d.outside) : '–'}</em></span>
                <span>Boiler <em>{hours(d.boilerHours)}</em></span>
              </>)} />
          </>
        )}
      </section>

      {!table && (
        <section className="chart-card">
          <div className="chart-head"><h2>Cost per cold degree</h2></div>
          <p className="chart-explain">
            A day's cold degrees are how far its average outside temperature fell below {data.base}° (so a 9.5° day counts 6). Dividing the gas cost by them takes the weather out, so lower really means the house is being heated more cheaply.
            {data.firstOutside && data.firstOutside !== data.days[0].date ? ` Outside temperatures start on ${dayLabel(data.firstOutside, { day: 'numeric', month: 'short' })}; earlier days can't be compared.` : ''}
          </p>
          <div className="legend-row">
            <span><i className="sw sw-bar" style={{ '--bar': 'var(--c-out)' }} />Cost per cold degree</span>
            {avgPerDD != null && <span><i className="sw sw-avg" />30-day average, {perDeg(avgPerDD, u)}</span>}
          </div>
          <DailyBars days={data.days} value={(d) => d.costPerDD} colorVar="--c-out" label="Gas cost per cold degree per day" avg={avgPerDD}
            format={(v, axis) => (axis ? (u === 'GBP' && v < 1 ? `${Math.round(v * 100)}p` : `${sym(u)}${v}`) : perDeg(v, u))}
            tip={(d) => (<>
              <span>Per cold degree <em>{perDeg(d.costPerDD, u)}</em></span>
              <span>Cold degrees <em>{d.degreeDays ?? '–'}</em></span>
              <span>Cost <em>{money(d.cost, u)}</em></span>
            </>)} />
        </section>
      )}

      <section className="chart-card">
        <div className="chart-head"><h2>Rooms compared</h2></div>
        {(slowest || overshooter || busiest) && (
          <ul className="callouts">
            {slowest && <li><b>Slowest to warm:</b> {slowest.name}, about {slowest.warmRate.toFixed(1)}° an hour. If that seems slow, bleed its radiator and check nothing blocks the valve.</li>}
            {overshooter && overshooter.overshoot > 0.2 && <li><b>Overshoots most:</b> {overshooter.name}, by {overshooter.overshoot.toFixed(1)}° on average. It's learning to stop earlier.</li>}
            {busiest && <li><b>Most heating:</b> {busiest.name}, {hours(busiest.heatingHours)} in the last 7 days.</li>}
          </ul>
        )}
        <div className="table-wrap">
          <table className="data-table league">
            <thead><tr><th>Room</th><th>Warms up</th><th>Overshoots</th><th>Stops early</th><th>Heating, 7 days</th><th>Average</th></tr></thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.id}>
                  <td data-label="Room">{r.name}</td>
                  <td data-label="Warms up">{r.warmRate != null ? `${r.warmRate.toFixed(1)}°/h` : <span className="muted">learning</span>}</td>
                  <td data-label="Overshoots">{r.overshoot != null ? `${r.overshoot > 0.05 ? '+' : ''}${(Math.round(r.overshoot * 10) / 10).toFixed(1)}°` : <span className="muted">learning</span>}</td>
                  <td data-label="Stops early">{r.stopsEarly != null ? `${r.stopsEarly}°` : '–'}</td>
                  <td data-label="Heating, 7 days">{hours(r.heatingHours)}</td>
                  <td data-label="Average">{r.avgTemp != null ? deg(r.avgTemp) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.trackedDays < 7 && <p className="chart-explain" style={{ marginTop: 8 }}>Heating time and averages fill in as the app records them ({data.trackedDays} of 7 days so far).</p>}
      </section>
    </>
  );
}

function DaysTable({ data }) {
  const u = data.unit;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Day</th><th>Cost</th><th>Outside</th><th>Cold degrees</th><th>Per cold degree</th><th>Boiler</th></tr></thead>
        <tbody>
          {[...data.days].reverse().map((d) => (
            <tr key={d.date}>
              <td>{d.partial ? 'Today' : dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
              <td>{money(d.cost, u)}</td><td>{d.outside != null ? deg(d.outside) : '–'}</td><td>{d.degreeDays ?? '–'}</td>
              <td>{perDeg(d.costPerDD, u)}</td><td>{hours(d.boilerHours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
