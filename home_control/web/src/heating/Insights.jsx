import { useCallback, useEffect, useRef, useState } from 'react';
import { api, deg, fmtTime } from './lib.js';

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
  // always-open radiators (no TRV of their own) heated by other rooms' calls more than their own
  const openRooms = rooms.filter((r) => r.open && r.othersHours > 0);

  return (
    <>
      {!data.sources.cost && <div className="banner info">No gas cost sensor found, so costs are missing. Choose one in <a href="#/settings/sources">Settings</a>.</div>}

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
        {(slowest || overshooter || busiest || openRooms.length > 0) && (
          <ul className="callouts">
            {slowest && <li><b>Slowest to warm:</b> {slowest.name}, about {slowest.warmRate.toFixed(1)}° an hour. If that seems slow, bleed its radiator and check nothing blocks the valve.</li>}
            {overshooter && overshooter.overshoot > 0.2 && <li><b>Overshoots most:</b> {overshooter.name}, by {overshooter.overshoot.toFixed(1)}° on average. It's learning to stop earlier.</li>}
            {busiest && <li><b>Most heating:</b> {busiest.name}, {hours(busiest.heatingHours)} in the last 7 days.</li>}
            {openRooms.map((r) => (
              <li key={`open-${r.id}`}><b>Always-open radiator:</b> {r.name} has no TRV of its own, so it also got {hours(r.othersHours)} of heat when other rooms called{r.avgTemp != null ? `, which helps explain its ${deg(r.avgTemp)} average` : ''}. Its learning ignores those times.</li>
            ))}
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
                  <td data-label="Heating, 7 days">{hours(r.heatingHours)}{r.open && r.othersHours > 0 && <small className="cell-note">+ {hours(r.othersHours)} with other rooms</small>}</td>
                  <td data-label="Average">{r.avgTemp != null ? deg(r.avgTemp) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.trackedDays < 7 && <p className="chart-explain" style={{ marginTop: 8 }}>Heating time and averages fill in as the app records them ({data.trackedDays} of 7 days so far).</p>}
      </section>

      <RoomHeat />
      <PredictionCheck tz={state.timeZone} />
    </>
  );
}

// ---------- how each room holds its heat ----------
const perHour = (v) => (v == null ? '–' : `${v.toFixed(v < 1 ? 2 : 1).replace(/0$/, '')}°/h`);
const HOLD = { good: 'Holds heat well', average: 'About average', poor: 'Loses heat quickly' };

function RoomHeat() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let gone = false;
    const load = () => api('insights/rooms').then((d) => { if (!gone) { setData(d); setErr(null); } }).catch((e) => !gone && setErr(e.message));
    load();
    const t = setInterval(load, 20 * 60000);
    return () => { gone = true; clearInterval(t); };
  }, []);

  const head = <div className="chart-head"><h2>How each room holds its heat</h2></div>;
  if (err || data?.error) return <section className="chart-card">{head}<p className="chart-explain">Couldn't work these out: {err || data.error}</p></section>;
  if (!data) return <section className="chart-card">{head}<p className="chart-explain">Going through the last week of temperatures…</p></section>;

  const rooms = data.rooms || [];
  const measured = rooms.filter((r) => r.loss.k != null);
  const best = measured.length > 1 ? [...measured].sort((a, b) => a.loss.k - b.loss.k)[0] : null;
  const worst = measured.length > 1 ? [...measured].sort((a, b) => b.loss.k - a.loss.k)[0] : null;
  const weather = rooms.filter((r) => r.warm.mild && r.warm.cold)
    .sort((a, b) => (b.warm.mild.rate - b.warm.cold.rate) - (a.warm.mild.rate - a.warm.cold.rate))[0];
  const maxHold = Math.max(0, ...measured.map((r) => r.loss.holdHours || 0));
  const faster = rooms.filter((r) => r.lossTrend?.elevated);

  return (
    <section className="chart-card">
      {head}
      <p className="chart-explain">
        From the last {data.days >= 7 ? 'week' : `${data.days} days`} of temperatures{data.outside ? ` (${deg(data.outside.min)} to ${deg(data.outside.max)} outside)` : ''}: how fast each room warms, how much colder days slow that down, and how quickly it cools once the heating's off. Cooling is only measured when a room has had no heat at all for 45 minutes, so leftover radiator heat doesn't count.
      </p>
      {data.callsFrom > data.from + 86400000 && <p className="chart-explain">Warm-ups count from {dayLabel(new Date(data.callsFrom).toISOString().slice(0, 10), { weekday: 'short', day: 'numeric', month: 'short' })}, when Home Control started recording each room's heat-ups; heat loss uses the whole week.</p>}
      {!data.outsideEntity && <p className="chart-explain">No outside temperature found, so heat loss can't be worked out. Choose one in <a href="#/settings/sources">Settings</a>.</p>}
      {(best || worst || weather || faster.length > 0) && (
        <ul className="callouts">
          {faster.map((r) => <li key={r.id}><b>Losing heat faster than usual:</b> {r.name}, at least {r.lossTrend.percent}% faster over the last two days than its usual, allowing for the weather{r.lossTrend.windMatched ? ` (compared with its days as windy, about ${Math.round(r.lossTrend.wind / 1.609344)} mph)` : ''}. Check for a window or trickle vent left open, or a new draught.{r.lossTrend.dismissed && <span className="muted"> Dismissed from Needs attention until it's back to normal.</span>}</li>)}
          {best && <li><b>Holds its heat best:</b> {best.name}. From 20° on a 5° night it takes about {hours(best.loss.holdHours)} to fall to 17°.</li>}
          {worst && worst !== best && <li><b>Loses heat fastest:</b> {worst.name}, about {perHour(worst.loss.at10)} when it's 10° colder outside{best && worst.loss.k / best.loss.k >= 1.3 ? `, ${(worst.loss.k / best.loss.k).toFixed(1)} times as fast as ${best.name}` : ''}. Worth checking for draughts, a window or trickle vent left open, and whether its radiator is big enough for the room.</li>}
          {weather && weather.warm.mild.rate - weather.warm.cold.rate >= 0.2 && <li><b>Cold days slow it most:</b> {weather.name} warms {perHour(weather.warm.mild.rate)} at {deg(weather.warm.mild.outside)} outside but {perHour(weather.warm.cold.rate)} at {deg(weather.warm.cold.outside)}. <a href="#/settings/early">Starting heating early</a> allows for this.</li>}
        </ul>
      )}
      <div className="table-wrap">
        <table className="data-table league heatfit">
          <thead><tr><th>Room</th><th>Warms up</th><th>Cools, 10° colder outside</th><th>20° → 17° on a 5° night</th><th>Heating per cold degree</th><th>Holds heat</th></tr></thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td data-label="Room">{r.name}</td>
                <td data-label="Warms up"><span className="cv">
                  {r.warm.mild && r.warm.cold
                    ? <>{perHour(r.warm.mild.rate)} at {deg(r.warm.mild.outside)}<small className="cell-note">{perHour(r.warm.cold.rate)} at {deg(r.warm.cold.outside)} outside</small></>
                    : r.warm.rate != null ? <>{perHour(r.warm.rate)}<small className="cell-note">{r.warm.samples < 4 ? 'a few more heat-ups to compare weathers' : 'needs colder and milder days to compare'}</small></>
                      : <span className="muted">learning</span>}
                </span></td>
                <td data-label="Cools, 10° colder outside"><span className="cv">
                  {r.loss.k != null ? <>{perHour(r.loss.at10)}<small className="cell-note">{perHour(r.loss.cold.rate)} for a 20° room on a 0° day</small></> : <span className="muted">learning</span>}
                </span></td>
                <td data-label="20° → 17° on a 5° night">
                  {r.loss.holdHours != null
                    ? <span className="hold"><span className="hold-bar" style={{ width: `${Math.max(6, (r.loss.holdHours / (maxHold || 1)) * 100)}%` }} /><span>{hours(r.loss.holdHours)}</span></span>
                    : <span className="muted">learning</span>}
                </td>
                <td data-label="Heating per cold degree"><span className="cv">
                  {r.perColdDegree != null ? <>{r.perColdDegree} min{r.open && <small className="cell-note">with other rooms' heat</small>}</> : '–'}
                </span></td>
                <td data-label="Holds heat">{r.rating ? <span className={`hold-chip hold-${r.rating}`}>{HOLD[r.rating]}</span> : <span className="muted">learning</span>}{r.lossTrend?.elevated && <small className="cell-note"><span className="hold-chip hold-faster">{r.lossTrend.percent}%+ faster lately</span></small>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="chart-explain" style={{ marginTop: 8 }}>
        <b>Heating per cold degree</b> is minutes of heating a day for each degree the day's average outside fell below 15.5°: lower means the room needs less heat for the weather. {measured.length < rooms.length ? 'Rooms still learning need a few more stretches with the heating off (overnight is ideal).' : ''}
      </p>
    </section>
  );
}

// ---------- how good the predictions are ----------
const signed = (m) => (m == null ? '–' : m === 0 ? 'on time' : `${Math.abs(m)} min ${m > 0 ? 'later' : 'earlier'}`);

function PredictionCheck({ tz }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let gone = false;
    const load = () => api('insights/predictions').then((d) => { if (!gone) setData(d); }).catch(() => {});
    load();
    const t = setInterval(load, 5 * 60000);
    return () => { gone = true; clearInterval(t); };
  }, []);
  if (!data) return null;
  const head = <div className="chart-head"><h2>How good the predictions are</h2></div>;
  const intro = <p className="chart-explain">Each room's next heat is predicted from how fast it cools, the weather forecast and its schedule. Here's how those predictions, made an hour and 15 minutes ahead, compared with when each room really started heating over the last {data.days} days. Rooms that keep starting earlier or later than predicted are corrected as it goes.</p>;
  const rooms = data.rooms.filter((r) => r.h60.samples || r.m15.samples || r.h60.didntHappen || r.h60.notForeseen);
  if (!rooms.length) {
    return <section className="chart-card">{head}{intro}<p className="chart-explain">Nothing to compare yet: the first results come in after each room's next heat-up{data.pending ? ` (${data.pending} prediction${data.pending === 1 ? '' : 's'} waiting)` : ''}.</p></section>;
  }
  const a = data.all.h60;
  const clock = (t) => (t ? fmtTime(t, tz, true) : '–');
  return (
    <section className="chart-card">
      {head}
      {intro}
      {a.samples > 0 && (
        <ul className="callouts">
          <li><b>An hour ahead:</b> usually within {a.typical} min{a.within15 != null ? `, ${a.within15}% within a quarter of an hour` : ''}{a.bias ? `; rooms tend to start ${signed(a.bias)} than predicted` : ''}.</li>
          {data.all.m15.samples > 0 && <li><b>15 minutes ahead:</b> usually within {data.all.m15.typical} min.</li>}
        </ul>
      )}
      <div className="table-wrap">
        <table className="data-table league heatfit">
          <thead><tr><th>Room</th><th>An hour ahead</th><th>15 min ahead</th><th>Didn't happen</th><th>Correction</th></tr></thead>
          <tbody>
            {rooms.map((r) => (
              <tr key={r.id}>
                <td data-label="Room">{r.name}</td>
                <td data-label="An hour ahead"><span className="cv">{r.h60.samples ? <>within {r.h60.typical} min<small className="cell-note">{r.h60.samples} heat-up{r.h60.samples === 1 ? '' : 's'}{r.h60.bias ? `, usually ${signed(r.h60.bias)}` : ''}{r.h60.notForeseen ? `, ${r.h60.notForeseen} not foreseen` : ''}</small></> : <span className="muted">none yet</span>}</span></td>
                <td data-label="15 min ahead"><span className="cv">{r.m15.samples ? <>within {r.m15.typical} min<small className="cell-note">{r.m15.samples} heat-up{r.m15.samples === 1 ? '' : 's'}</small></> : <span className="muted">none yet</span>}</span></td>
                <td data-label="Didn't happen">{r.h60.didntHappen || '–'}</td>
                <td data-label="Correction"><span className="cv">{r.corrections < 3
                  ? <span className="muted">{`after ${3 - r.corrections} more heat-up${3 - r.corrections === 1 ? '' : 's'}`}</span>
                  : Math.abs(r.scale - 1) < 0.03 ? 'none needed' : <>cools {Math.round(Math.abs(1 - r.scale) * 100)}% {r.scale > 1 ? 'faster' : 'slower'}<small className="cell-note">than measured</small></>}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.latest.length > 0 && (
        <>
          <p className="chart-explain" style={{ marginTop: 12 }}>Latest, predicted an hour ahead:</p>
          <ul className="pred-latest">
            {data.latest.slice(0, 8).map((e, i) => (
              <li key={i}>
                <span>{e.room}: {e.predicted ? `predicted ${clock(e.predicted)}` : 'not foreseen'}{e.actual ? `, started ${clock(e.actual)}` : ', didn\'t need heat then'}</span>
                <span className={`num pred-err ${e.error == null ? '' : Math.abs(e.error) <= 15 ? 'pred-good' : 'pred-off'}`}>{e.error == null ? '' : signed(e.error)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="chart-explain" style={{ marginTop: 8 }}><b>Didn't happen</b>: predicted an hour ahead, but the room didn't need heat within two hours of then (it stayed warmer than expected). <b>Correction</b>: once a room has three heat-ups to go on, how much faster or slower it really cools than measured, allowed for in its predictions. Heat-ups someone asked for (a boost or a hold), and rooms started early with another room, aren't counted.</p>
    </section>
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
