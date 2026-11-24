import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, deg, fmtTime } from './lib.js';
import { useScrub } from '../scrub.js';

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
const list = (a) => (a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const NEXT_WHY = {
  cooling: (n) => `as it cools to ${deg(n.threshold)}`,
  preheat: (n) => `warming for ${n.readyBy}`,
  schedule: (n) => `up to ${deg(n.target)}`,
  change: (n) => `back to ${deg(n.target)}`,
};

/** When the boiler next fires (predicted from each room), or while it's on, about when it'll be done. */
function NextHeat({ state }) {
  const b = state.boiler;
  const tz = state.timeZone;
  if (!b.entity) return null;
  const rooms = state.zones.filter((z) => z.enabled);
  if (b.reachable === false) {
    // Hive (or whatever runs the boiler) not working: nothing can fire, so no times to give
    const want = rooms.filter((z) => z.blocked).map((z) => z.name);
    return (
      <section className="stat" aria-label="Next heat">
        <h2>Next heat</h2>
        <p className="stat-num num">–</p>
        <p className="stat-sub">{want.length ? `${list(want)} ${want.length === 1 ? 'wants' : 'want'} heat, but the boiler can't be reached in Home Assistant` : 'Not until the boiler can be reached in Home Assistant again'}</p>
      </section>
    );
  }
  if (b.on) {
    const heating = rooms.filter((z) => z.calling).map((z) => z.name);
    return (
      <section className="stat" aria-label="Boiler on until">
        <h2>Boiler on until</h2>
        <p className="stat-num num">{b.until ? fmtTime(b.until, tz) : '–'}</p>
        <p className="stat-sub">{heating.length ? `${b.until ? 'About then: ' : ''}${list(heating)} warming${b.until ? '' : '; learning how fast'}` : 'Finishing its minimum run'}</p>
      </section>
    );
  }
  const up = rooms.filter((z) => z.next?.at).sort((x, y) => x.next.at - y.next.at);
  const learning = rooms.some((z) => z.next && !z.next.at && z.next.basis === 'none');
  const [first, second] = up;
  return (
    <section className="stat" aria-label="Next heat">
      <h2>Next heat</h2>
      <p className="stat-num num">{first ? fmtTime(first.next.at, tz) : '–'}</p>
      <p className="stat-sub">
        {first
          ? <>About then: {first.name} {NEXT_WHY[first.next.reason]?.(first.next) || ''}{second ? <>, then {second.name} {fmtTime(second.next.at, tz)}</> : ''}</>
          : learning ? 'Learning how fast each room cools' : 'Not needed in the next 24 hours'}
      </p>
    </section>
  );
}
export function SideCards({ state, today }) {
  const ex = state.extras || {};
  const outsideSeries = (today?.outside?.series || []).filter((v) => v != null);
  const lo = outsideSeries.length ? Math.min(...outsideSeries) : null;
  const hi = outsideSeries.length ? Math.max(...outsideSeries) : null;
  return (
    <div className="side-cards">
      <section className="stat" aria-label="Gas cost">
        <h2>Gas today</h2>
        {ex.cost && ex.cost.today == null && ex.cost.lastDay != null ? (
          <>
            <p className="stat-num num">{money(ex.cost.lastDay, ex.cost.unit)}</p>
            <p className="stat-sub">The last full day from your smart meter (today's comes in tomorrow)</p>
          </>
        ) : ex.cost ? (
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
            <p className="stat-sub">{state.boiler.reachable === false ? 'Can\'t be reached now' : state.boiler.on ? 'Firing now' : 'Resting now'}{today?.boilerFiresToday ? ` · fired ${today.boilerFiresToday === 1 ? 'once' : today.boilerFiresToday === 2 ? 'twice' : `${today.boilerFiresToday} times`}` : ''}</p>
          </>
        ) : <p className="stat-sub"><a href="#/settings/boiler">Choose your boiler in Settings</a></p>}
      </section>
      <NextHeat state={state} />
      <section className="stat" aria-label="Outside">
        <h2>Outside</h2>
        {ex.outside ? (
          <>
            <p className="stat-num num">{deg(ex.outside.now)}</p>
            <p className="stat-sub">{lo != null ? `Between ${deg(lo, 0)} and ${deg(hi, 0)} in the last day` : 'Now'}</p>
            <OutsideSpark today={today} now={ex.outside.now} tz={state.timeZone} />
          </>
        ) : <p className="stat-sub">No outside temperature found. <a href="#/settings/sources">Choose one in Settings</a></p>}
      </section>
    </div>
  );
}

// The last 24 hours outside, under the Outside card's number (like each room card's day graph).
function OutsideSpark({ today, now, tz }) {
  const [hv, setHv] = useState(null);
  const moveRef = useRef(null);
  const scrub = useScrub((e) => moveRef.current?.(e), () => setHv(null));
  const d = useMemo(() => {
    const series = today?.outside?.series;
    if (!series || !today.times?.length) return null;
    const pts = [];
    today.times.forEach((t, i) => { if (series[i] != null) pts.push({ t, v: series[i] }); });
    const end = Date.now();
    if (now != null && (!pts.length || end > pts[pts.length - 1].t)) pts.push({ t: end, v: now });
    if (pts.length < 2) return null;
    const start = end - 24 * 3600000;
    const vals = pts.map((p) => p.v);
    let lo = Math.min(...vals); let hi = Math.max(...vals);
    if (hi - lo < 3) { const mid = (hi + lo) / 2; lo = mid - 1.5; hi = mid + 1.5; }
    const x = (t) => Math.max(0, ((t - start) / (end - start)) * 1440);
    const y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * 34;
    const path = pts.filter((p) => p.t >= start).map((p, k) => `${k ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    // midnight, as a faint line, so the day can be read
    const midnight = today.dayStart && today.dayStart > start ? today.dayStart : null;
    return { pts: pts.filter((p) => p.t >= start), path, x, y, start, end, midnight };
  }, [today, now]);
  if (!d) return null;
  const clockAt = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  // midnight's label only where it won't run into the start time or "now" (its line is always drawn)
  const midRaw = d.midnight ? d.x(d.midnight) / 1440 : null;
  const midF = midRaw != null && midRaw > 0.22 && midRaw < 0.82 ? midRaw : null;
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    const t = d.start + f * (d.end - d.start);
    let best = d.pts[0];
    for (const p of d.pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHv({ ...best, f: d.x(best.t) / 1440 });
  };
  moveRef.current = onMove;
  return (
    <div className="spark out-spark scrub-area">
      <div className="spark-plot scrub" {...scrub}>
        <svg viewBox="0 0 1440 40" preserveAspectRatio="none" role="img" aria-label="Outside temperature over the last 24 hours">
          {d.midnight && <line className="out-midnight" x1={d.x(d.midnight)} x2={d.x(d.midnight)} y1="0" y2="40" />}
          <path className="spark-line out-line" d={d.path} />
          {hv && <line className="spark-cross" x1={hv.f * 1440} x2={hv.f * 1440} y1="0" y2="40" />}
        </svg>
        {hv && (
          <div className="spark-tip" style={{ left: `${Math.min(Math.max(hv.f, 0.18), 0.82) * 100}%` }} role="status">
            {clockAt(hv.t)} · <b>{deg(hv.v)}</b>
          </div>
        )}
      </div>
      <div className="out-axis" aria-hidden="true"><span>{clockAt(d.start)}</span>{midF != null && <span style={{ left: `${midF * 100}%` }} className="out-axis-mid">00:00</span>}<span>now</span></div>
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
const RANGE_KEY = 'hc-chart-range';
const HOUR = 3600000; const DAYMS = 24 * HOUR;
// how far back the chart goes; "Last 24 hours" is the Rooms page's own, kept fresh with it
const RANGES = [
  { id: '6h', hours: 6, label: 'Last 6 hours' },
  { id: '12h', hours: 12, label: 'Last 12 hours' },
  { id: '24h', hours: 24, label: 'Last 24 hours' },
  { id: '2d', hours: 48, label: 'Last 2 days' },
  { id: '3d', hours: 72, label: 'Last 3 days' },
  { id: '7d', hours: 168, label: 'Last 7 days' },
  { id: '14d', hours: 336, label: 'Last 14 days' },
  { id: '30d', hours: 720, label: 'Last 30 days' },
  { id: '90d', hours: 2160, label: 'Last 90 days' },
  { id: '365d', hours: 8760, label: 'Last year' },
  { id: 'dates', label: 'Choose dates…' },
];
const isoDay = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
// local midnight of a 'YYYY-MM-DD' day in the house's time zone
function dayStartMs(day, tz) {
  const [y, mo, d] = day.split('-').map(Number);
  let t = Date.UTC(y, mo - 1, d);
  for (let k = 0; k < 2; k++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    t -= local - Date.UTC(y, mo - 1, d);
  }
  return t;
}
const dayLabel = (ms, tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(ms));
const hmText = (mins) => { const m = Math.round(mins); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`; };
// minutes of [a, b] intervals inside from..to
const minutesIn = (list, from, to) => (list || []).reduce((m, [a, b]) => m + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0) / 60000;

/** The chart's figures for a range: the Rooms page's own for the last 24 hours, otherwise /api/history. */
function useRangeData(range, today) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const key = range.id === 'dates' ? `${range.from}|${range.to}` : range.id;
  useEffect(() => {
    if (range.id === '24h' || (range.id === 'dates' && !(range.from && range.to))) { setData(null); setError(null); return undefined; }
    let stop = false;
    const load = async () => {
      setLoading(true);
      try {
        const q = range.id === 'dates' ? `history?from=${range.from}&to=${range.to}` : `history?hours=${range.hours}`;
        const d = await api(q);
        if (stop) return;
        if (d.error) setError(d.error); else { setData(d); setError(null); }
      } catch (e) { if (!stop) setError(e.message); }
      if (!stop) setLoading(false);
    };
    setData(null);
    load();
    // the last few hours or days: kept up to date (chosen dates don't change)
    const t = range.id === 'dates' ? null : setInterval(load, range.hours <= 72 ? 120000 : 600000);
    return () => { stop = true; clearInterval(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (range.id === '24h') return { data: today, error: null, loading: !today };
  return { data, error, loading };
}

/** Choose how far back: a list, and two dates for "Choose dates…". */
function RangePicker({ range, setRange, tz }) {
  const today = isoDay(Date.now(), tz);
  const [from, setFrom] = useState(range.fromDay || isoDay(Date.now() - 7 * DAYMS, tz));
  const [to, setTo] = useState(range.toDay || today);
  const choose = (id) => {
    if (id === 'dates') { setRange({ id: 'dates', fromDay: from, toDay: to, from: dayStartMs(from, tz), to: Math.min(Date.now(), dayStartMs(to, tz) + DAYMS) }); return; }
    setRange(RANGES.find((r) => r.id === id));
  };
  const show = () => {
    if (!from || !to) return;
    const [a, b] = from <= to ? [from, to] : [to, from];
    setRange({ id: 'dates', fromDay: a, toDay: b, from: dayStartMs(a, tz), to: Math.min(Date.now(), dayStartMs(b, tz) + DAYMS) });
  };
  return (
    <div className="range-pick">
      <label className="range-select">
        <span className="sr-only">How far back</span>
        <select value={range.id} onChange={(e) => choose(e.target.value)}>
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </label>
      {range.id === 'dates' && (
        <div className="range-dates">
          <label><span>From</span><input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></label>
          <label><span>To</span><input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></label>
          {(from !== range.fromDay || to !== range.toDay) && <button type="button" className="btn primary" onClick={show}>Show</button>}
        </div>
      )}
    </div>
  );
}
const METRIC_KEY = 'hc-chart-metric';
const ALL = 'all';
const METRICS = [
  { id: 'temp', label: 'Temperature', title: 'Temperature' },
  { id: 'target', label: 'Target', title: 'Target' },
  { id: 'diff', label: 'vs target', title: 'Above or below target' },
  { id: 'rh', label: 'Humidity', title: 'Humidity' },
];
const VIEW_KEY = 'hc-chart-view'; // one room: its temperatures, or its humidity
const pctText = (v) => (v == null ? '–' : `${Math.round(v)}%`);
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
      : metric === 'rh' ? (r.humidity || r.temps.map(() => null))
      : r.temps.map((v, i) => (v == null || r.targets[i] == null ? null : Math.round((v - r.targets[i]) * 10) / 10)),
  }));
}

export function TodayChart({ state, today: day, error: dayError }) {
  const tz0 = state.timeZone;
  const [range, setRangeState] = useState(() => {
    try { const r = JSON.parse(recall(RANGE_KEY) || 'null'); if (r && RANGES.some((x) => x.id === r.id)) return r.id === 'dates' ? r : RANGES.find((x) => x.id === r.id); } catch { /* none */ }
    return RANGES.find((x) => x.id === '24h');
  });
  const setRange = (r) => { setRangeState(r); setHover(null); remember(RANGE_KEY, JSON.stringify(r.id === 'dates' ? r : { id: r.id })); };
  const { data: today, error, loading } = useRangeData(range, day);
  const err = range.id === '24h' ? dayError : error;
  const rangeTitle = range.id === 'dates'
    ? `${dayLabel(range.from, tz0, { day: 'numeric', month: 'short' })} – ${dayLabel(range.to - 1, tz0, { day: 'numeric', month: 'short', year: isoDay(range.from, tz0).slice(0, 4) !== isoDay(Date.now(), tz0).slice(0, 4) ? 'numeric' : undefined })}`
    : range.label;
  const rooms = today?.rooms || [];
  const [roomId, setRoomId] = useState(() => recall(ROOM_KEY) || ALL);
  const [metric0, setMetric] = useState(() => (METRICS.some((m) => m.id === recall(METRIC_KEY)) ? recall(METRIC_KEY) : 'temp'));
  const [focus, setFocus] = useState(null);
  const isAll = roomId === ALL && rooms.length > 1;
  const room = isAll ? null : rooms.find((r) => r.id === roomId) || rooms[0];
  // humidity, where any room has it (a room's own, or a measure for All rooms)
  const anyHumid = rooms.some((r) => r.humidity);
  const metric = metric0 === 'rh' && !anyHumid ? 'temp' : metric0;
  const [view0, setView] = useState(() => (recall(VIEW_KEY) === 'rh' ? 'rh' : 'temp'));
  const rhMode = !isAll && !!room?.humidity && view0 === 'rh';
  const pctAxis = rhMode || (isAll && metric === 'rh');
  const series = useMemo(() => (isAll ? roomSeries(rooms, metric) : []), [isAll, rooms, metric]);
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const chartMove = useRef(null);
  const scrub = useScrub((e) => chartMove.current?.(e), () => setHover(null));
  const [table, setTable] = useState(false);
  const tz = state.timeZone;
  const span = today ? today.to - today.from : DAYMS;
  const long = span > 26 * HOUR;
  const daily = (today?.step || 0) >= DAYMS;
  // a moment on the chart: 14:05 for a day, "Sat 8 Nov, 14:00" for longer, "Sat 8 Nov" for days
  const when = (t) => (!long ? clock(t, tz) : daily ? dayLabel(t, tz, { weekday: 'short', day: 'numeric', month: 'short' }) : `${dayLabel(t, tz, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(t, tz)}`);
  const fmt = metric === 'diff' && isAll ? signed : isAll && metric === 'rh' ? pctText : (v) => deg(v);
  const mInfo = METRICS.find((m) => m.id === metric);

  const pick = (id) => { setRoomId(id); setHover(null); setFocus(null); remember(ROOM_KEY, id); };
  // "Its heating history" on a room's page: that room, and the chart brought into view
  const cardRef = useRef(null);
  useEffect(() => {
    const on = (e) => {
      if (e.detail?.room) pick(e.detail.room);
      setTimeout(() => cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    };
    window.addEventListener('hc-history', on);
    return () => window.removeEventListener('hc-history', on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pickMetric = (id) => { setMetric(id); setHover(null); remember(METRIC_KEY, id); };
  const pickView = (id) => { setView(id); setHover(null); remember(VIEW_KEY, id); };

  const geo = useMemo(() => {
    if (!today || (!room && !isAll) || !width) return null;
    const H = 240;
    const m = { l: 34, r: 10, t: 10, b: 24 };
    const n = today.times.length;
    const outside = today.outside?.series || [];
    const vals = (isAll ? series.flatMap((s) => s.values)
      : rhMode ? [...room.humidity, ...(room.coldSpot || []), 80]
        : [...room.temps, ...room.targets, ...outside]).filter((v) => v != null);
    if (!vals.length) return null;
    let lo;
    let hi;
    if (pctAxis) {
      // humidity: in tens, at least 20% tall, never past 0 or 100
      lo = Math.max(0, Math.floor((Math.min(...vals) - 3) / 10) * 10);
      hi = Math.min(100, Math.ceil((Math.max(...vals) + 3) / 10) * 10);
      if (hi - lo < 20) { if (hi + 10 <= 100) hi += 10; if (hi - lo < 20) lo = Math.max(0, hi - 20); }
    } else if (isAll && metric === 'diff') {
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
    const stepDeg = pctAxis ? (span <= 30 ? 5 : 10) : span <= 5 ? 1 : span > 14 ? 4 : 2;
    const yTicks = [];
    for (let v = Math.ceil(lo / stepDeg) * stepDeg; v <= hi; v += stepDeg) yTicks.push(v);
    let xTicks;
    if (!long) {
      xTicks = today.times.map((t, i) => ({ t, i, label: clock(t, tz) })).filter(({ t }) => {
        const hhmm = clock(t, tz);
        return hhmm.endsWith(':00') && Number(hhmm.slice(0, 2)) % (width < 520 ? 6 : 3) === 0;
      });
    } else {
      // days (at midnight), thinned to fit; over four months, the first of each month
      const fits = Math.max(2, Math.floor((width - m.l - m.r) / (span > 20 * DAYMS ? 56 : 62)));
      let marks = today.times.map((t, i) => ({ t, i })).filter(({ t }) => clock(t, tz) === '00:00');
      if (span > 120 * DAYMS) marks = marks.filter(({ t }) => dayLabel(t, tz, { day: 'numeric' }) === '1').map((x) => ({ ...x, label: dayLabel(x.t, tz, { month: 'short' }) }));
      else {
        const every = Math.ceil(marks.length / fits);
        marks = marks.filter((_, k) => k % every === 0).map((x) => ({ ...x, label: dayLabel(x.t, tz, span > 16 * DAYMS ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' }) }));
      }
      xTicks = marks;
    }
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
        calls: (r.calls || []).filter(([a, b]) => b > today.from && a < today.to + (today.step || 0)),
      }));
      lanes = { top: H + 6, rows, h: 22 + rows.length * LANE };
    }
    const total = H + (lanes ? lanes.h : 0);
    return { H, total, m, n, x, y, tx, yTicks, xTicks, outside, labels, lanes };
  }, [today, room, rooms, isAll, series, metric, width, tz, rhMode, pctAxis]);

  const head = (
    <div className="chart-head">
      <h2>{rangeTitle}</h2>
      {today && !err && <button className="btn link" onClick={() => setTable((v) => !v)}>{table ? 'Show chart' : 'Show as table'}</button>}
    </div>
  );
  const picker = <RangePicker range={range} setRange={setRange} tz={tz0} />;
  if (err) return <section className="chart-card" ref={cardRef}>{head}{picker}<p className="stat-sub">{err}</p></section>;
  if (!today) return <section className="chart-card" ref={cardRef}>{head}{picker}<p className="stat-sub">{range.id === 'dates' && !(range.from && range.to) ? 'Choose the dates.' : loading ? `Loading ${rangeTitle.toLowerCase().replace(/^last/, 'the last')}…` : ''}</p></section>;
  if (!room && !isAll) return null;
  // the range's totals: how long it heated, the boiler, the average temperatures
  const end = today.end ?? today.to + (today.step || 0);
  const avg = (vals) => { const v = (vals || []).filter((x) => x != null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; };
  const boilerMins = minutesIn(today.boilerRuns, today.from, end);
  const sums = isAll
    ? [state.boiler.entity && `Boiler ${hmText(boilerMins)}`, ...rooms.map((r) => `${r.name} ${hmText(minutesIn(r.calls, today.from, end))}`)].filter(Boolean)
    : [`Heated ${hmText(minutesIn(room.calls, today.from, end))}`, avg(room.temps) != null && `averaging ${deg(avg(room.temps))}`, avg(room.humidity) != null && `humidity ${pctText(avg(room.humidity))}`, state.boiler.entity && `boiler ${hmText(boilerMins)}`];
  const outAvg = avg(today.outside?.series);
  const fromDay = (t) => dayLabel(t, tz, { day: 'numeric', month: 'short' });

  const { H, total, m, x, y, tx, yTicks, xTicks, outside, labels, lanes } = geo || { H: 240, total: 240, m: { l: 0, r: 0, t: 0, b: 0 }, x: () => 0, y: () => 0, tx: () => 0, yTicks: [], xTicks: [], outside: [], labels: [], lanes: null };
  const onMove = (e) => {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - m.l) / (width - m.l - m.r)) * (geo.n - 1));
    if (i < 0 || i >= geo.n) return setHover(null);
    setHover(i);
  };
  chartMove.current = onMove;
  const firingAt = (t) => today.boilerRuns.some(([a, b]) => t >= a && t <= b + (long ? (today.step || 0) - 1 : 0));
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
    heat: !isAll && room ? minutesIn(room.calls, today.times[hover], today.times[hover] + (today.step || 0)) : 0,
    ...(isAll
      ? {
        rows: series.map((s, k) => ({ ...s, v: s.values[hover], calling: !!callAt(rooms[k], today.times[hover]) }))
          .filter((r, k) => metric !== 'rh' || rooms[k].humidity).sort((a, b) => (b.v ?? -1e9) - (a.v ?? -1e9)),
        why: whyFiring(today.times[hover]),
      }
      : { temp: room.temps[hover], target: room.targets[hover], out: outside[hover], rh: room.humidity?.[hover], cold: room.coldSpot?.[hover] }),
  } : null;
  // table rows: every hour for a day, every 3 hours, 12 hours or day for longer (with the time heated in each)
  const rowMs = !long ? HOUR : span <= 3.6 * DAYMS ? 3 * HOUR : span <= 16 * DAYMS ? 12 * HOUR : DAYMS;
  const rowEvery = Math.max(1, Math.round(rowMs / (today.step || 300000)));
  const tipW = isAll ? 210 : long ? 190 : 160;
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
  const shownSeries = isAll && metric === 'rh' ? series.filter((_, k) => rooms[k].humidity) : series;

  return (
    <section className="chart-card" ref={cardRef} aria-label={`${rangeTitle} in ${title}`}>
      {head}
      {picker}
      <p className="range-sum">{sums.filter(Boolean).join(' · ')}{outAvg != null ? ` · outside ${deg(outAvg)} on average` : ''}{loading ? ' · updating…' : ''}</p>
      {today.dailyUntil && <p className="chart-explain">Before {fromDay(today.dailyUntil)}, from each day's figures: its average temperature and how long it heated (Home Control keeps every half hour from then).</p>}
      {!today.dailyUntil && today.asked && today.from > today.asked + (today.step || 0) && <p className="chart-explain">Home Control has kept this history since {fromDay(today.from)}, so the chart starts there.</p>}
      <nav className="room-picker" aria-label="Room to chart">
        {rooms.length > 1 && <button className="chip" aria-pressed={isAll} onClick={() => pick(ALL)}>All rooms</button>}
        {rooms.map((r) => <button key={r.id} className="chip" aria-pressed={!isAll && r.id === room.id} onClick={() => pick(r.id)}>{r.name}</button>)}
      </nav>

      {isAll && (
        <div className="metric-row">
          <div className="seg" role="group" aria-label="What to show for each room">
            {METRICS.filter((mm) => mm.id !== 'rh' || anyHumid).map((mm) => <button key={mm.id} aria-pressed={metric === mm.id} onClick={() => pickMetric(mm.id)}>{mm.label}</button>)}
          </div>
          {metric === 'diff' && <p className="metric-note">Above the 0° line: warmer than its target. Below: cooler.</p>}
          {metric === 'rh' && <p className="metric-note">Rooms with a humidity sensor. 40 to 60% is comfortable.</p>}
        </div>
      )}
      {!isAll && room.humidity && (
        <div className="metric-row">
          <div className="seg" role="group" aria-label="What to show">
            <button aria-pressed={!rhMode} onClick={() => pickView('temp')}>Temperature</button>
            <button aria-pressed={rhMode} onClick={() => pickView('rh')}>Humidity</button>
          </div>
          {rhMode && <p className="metric-note">{room.coldSpot ? 'The coldest spots (corners, round the windows) worked out from the room and outside temperatures. Mould grows where they stay over 80%.' : '40 to 60% is comfortable.'}</p>}
        </div>
      )}

      {isAll ? (
        <div className="legend-row" aria-hidden={table}>
          {shownSeries.map((s) => (
            <button key={s.id} className={`legend-btn${dim(s.id)}`} aria-pressed={focus === s.id}
              onClick={() => setFocus((f) => (f === s.id ? null : s.id))} title={focus === s.id ? 'Show every room' : `Highlight ${s.name}`}>
              <i className="sw sw-line" style={{ '--c': s.color }} />{s.name}
            </button>
          ))}
          {state.boiler.entity && <span><i className="sw sw-fire" />Boiler firing</span>}
        </div>
      ) : rhMode ? (
        <div className="legend-row" aria-hidden={table}>
          <span><i className="sw sw-hum" />Humidity</span>
          {room.coldSpot && <span><i className="sw sw-cold" />Coldest spots</span>}
          {room.coldSpot && <span><i className="sw sw-mould" />80%</span>}
          <span><i className="sw sw-heat-sm" />{room.name} heating</span>
        </div>
      ) : (
        <div className="legend-row" aria-hidden={table}>
          <span><i className="sw sw-room" />In the room</span>
          <span><i className="sw sw-target" />Target</span>
          {today.outside && <span><i className="sw sw-out" />Outside</span>}
          <span><i className="sw sw-heat-sm" />{room.name} heating</span>
        </div>
      )}

      {table ? (
        <div className="table-wrap">
          <table className="data-table">
            {isAll ? (
              <>
                <caption className="sr-only">{mInfo.title} in each room</caption>
                <thead><tr><th>Time</th>{shownSeries.map((s) => <th key={s.id}>{s.name}</th>)}<th>Boiler</th></tr></thead>
                <tbody>
                  {today.times.map((t, i) => ({ t, i })).filter(({ i }) => i % rowEvery === 0).reverse().map(({ t, i }) => (
                    <tr key={t}><td>{when(t)}</td>{shownSeries.map((s) => <td key={s.id}>{fmt(s.values[i])}</td>)}<td>{long ? hmText(minutesIn(today.boilerRuns, t, t + rowMs)) : firingAt(t) ? (whyFiring(t)?.text || 'Firing') : ''}</td></tr>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead><tr><th>Time</th><th>In the room</th><th>Target</th>{today.outside && <th>Outside</th>}{room.humidity && <th>Humidity</th>}{room.coldSpot && <th>Coldest spots</th>}<th>Heating</th></tr></thead>
                <tbody>
                  {today.times.map((t, i) => ({ t, i })).filter(({ i }) => i % rowEvery === 0).reverse().map(({ t, i }) => (
                    <tr key={t}><td>{when(t)}</td><td>{deg(room.temps[i])}</td><td>{deg(room.targets[i])}</td>{today.outside && <td>{deg(outside[i])}</td>}{room.humidity && <td>{pctText(room.humidity[i])}</td>}{room.coldSpot && <td>{pctText(room.coldSpot[i])}</td>}<td>{long ? hmText(minutesIn(room.calls, t, t + rowMs)) : minutesIn(room.calls, t, t + rowMs) > 0 ? 'Heating' : ''}</td></tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      ) : (
        <div className="chart scrub-area" ref={ref}>
          {geo && <svg width={width} height={total} role="img" className="scrub"
            aria-label={isAll ? `${mInfo.title} in each room, ${rangeTitle.toLowerCase()}, with when each room called for heat` : rhMode ? `${room.name}: humidity${room.coldSpot ? ' and at its coldest spots' : ''}, and when it heated, ${rangeTitle.toLowerCase()}` : `${room.name}: temperature, target, outside and when it heated, ${rangeTitle.toLowerCase()}`}
            {...scrub}>
            {isAll && today.boilerRuns.map(([a, b], k) => (
              <rect key={k} className="fire-band" x={tx(Math.max(a, today.from))} y={m.t} width={Math.max(1.5, tx(Math.min(b, today.to)) - tx(Math.max(a, today.from)))} height={(lanes ? total - 4 : H - m.b) - m.t} />
            ))}
            {!isAll && (room.calls || []).filter(([a, b]) => b > today.from && a < today.to).map(([a, b], k) => {
              const x0 = tx(Math.max(a, today.from)); const w = Math.max(1.5, tx(Math.min(b, today.to)) - x0);
              return (
                <g key={k}>
                  <rect className="spark-heat" x={x0} y={m.t} width={w} height={H - m.b - m.t} />
                  <rect className="spark-heat-edge" x={x0} y={H - m.b - 3} width={w} height="3" />
                </g>
              );
            })}
            {yTicks.map((v) => (
              <g key={v}>
                <line className={`grid${isAll && metric === 'diff' && v === 0 ? ' zero' : ''}`} x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} />
                <text className="axis" x={m.l - 6} y={y(v) + 4} textAnchor="end">{pctAxis ? `${v}%` : isAll && metric === 'diff' ? (v === 0 ? '0°' : `${v > 0 ? '+' : '−'}${Math.abs(v)}°`) : `${v}°`}</text>
              </g>
            ))}
            {xTicks.map(({ t, i, label }) => <text key={t} className="axis" x={x(i)} y={H - 6} textAnchor="middle">{label}</text>)}

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
            ) : rhMode ? (
              <>
                {room.coldSpot && <line className="ln-mould" x1={m.l} x2={width - m.r} y1={y(80)} y2={y(80)} />}
                {room.coldSpot && <path className="ln ln-cold" d={linePath(room.coldSpot, x, y)} />}
                <path className="ln ln-hum" d={linePath(room.humidity, x, y)} />
                {hv && (
                  <g>
                    <line className="cross" x1={x(hover)} x2={x(hover)} y1={m.t} y2={H - m.b} />
                    {hv.cold != null && <circle className="dot dot-cold" cx={x(hover)} cy={y(hv.cold)} r="4" />}
                    {hv.rh != null && <circle className="dot dot-hum" cx={x(hover)} cy={y(hv.rh)} r="4.5" />}
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
              <b>{when(hv.t)}{isAll ? ` · ${mInfo.title.toLowerCase()}` : ''}</b>
              {isAll ? hv.rows.map((r) => (
                <span key={r.id} className={dim(r.id).trim()}><i className="sw sw-line" style={{ '--c': r.color }} />{r.name}{r.calling && <i className="tip-heat" title="calling for heat" aria-label="calling for heat" />} <em>{fmt(r.v)}</em></span>
              )) : rhMode ? (
                <>
                  <span><i className="sw sw-hum" />Humidity <em>{pctText(hv.rh)}</em></span>
                  {room.coldSpot && <span><i className="sw sw-cold" />Coldest spots <em>{pctText(hv.cold)}</em></span>}
                  <span><i className="sw sw-room" />In the room <em>{deg(hv.temp)}</em></span>
                  {today.outside && <span><i className="sw sw-out" />Outside <em>{deg(hv.out)}</em></span>}
                  {long ? (hv.heat > 0 && <span><i className="sw sw-heat-sm" />Heated <em>{hmText(hv.heat)}</em></span>) : hv.heat > 0 && <span><i className="sw sw-heat-sm" />Heating</span>}
                </>
              ) : (
                <>
                  <span><i className="sw sw-room" />In the room <em>{deg(hv.temp)}</em></span>
                  <span><i className="sw sw-target" />Target <em>{deg(hv.target)}</em></span>
                  {today.outside && <span><i className="sw sw-out" />Outside <em>{deg(hv.out)}</em></span>}
                  {hv.rh != null && <span><i className="sw sw-hum" />Humidity <em>{pctText(hv.rh)}</em></span>}
                  {long ? (hv.heat > 0 && <span><i className="sw sw-heat-sm" />Heated <em>{hmText(hv.heat)}</em></span>) : hv.heat > 0 && <span><i className="sw sw-heat-sm" />Heating</span>}
                </>
              )}
              {isAll && hv.why && (
                <span className="tip-why"><i className={`sw ${hv.why.fire ? 'sw-fire' : 'sw-heat-sm'}`} />{hv.why.text}</span>
              )}
              {hv.fire && !(isAll && hv.why) && <span><i className="sw sw-fire" />{long ? `Boiler ${hmText(minutesIn(today.boilerRuns, hv.t, hv.t + (today.step || 0)))}` : 'Boiler firing'}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
