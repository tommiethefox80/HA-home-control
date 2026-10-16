import { useMemo, useState } from 'react';
import { deg } from './lib.js';

// A small "today" graph for a room card: the room's temperature since midnight, with shading
// where this room was calling for heat. It uses the same 00:00–24:00 scale as the schedule
// ribbon underneath, so the line ends right above the ribbon's "now" marker.
const DAY = 86400000;
const H = 40;
const clock = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
export const hm = (mins) => (mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`);

const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

// show: { spark, fires } from Settings → Room cards. Either can be off; with both off nothing shows.
// next: when the room next needs heat (from the app's prediction): its expected temperature from now
// is drawn dashed to the end of the day, with a mark where it should start heating (or, while it's
// heating, where it should be done).
export default function DaySpark({ room, today, tz, current, next = null, show = { spark: true, fires: true } }) {
  const [hv, setHv] = useState(null);
  const d = useMemo(() => {
    if (!room || !today?.dayStart) return null;
    const start = today.dayStart;
    const pts = [];
    today.times.forEach((t, i) => { if (t >= start && room.temps[i] != null) pts.push({ t, v: room.temps[i] }); });
    // finish on the live reading so the line meets the ribbon's "now" marker and matches the big number
    const now = Date.now();
    if (current != null && now > start && now < start + DAY && (!pts.length || now > pts[pts.length - 1].t)) pts.push({ t: now, v: current });
    if (pts.length < 2) return null;
    const vals = pts.map((p) => p.v);
    // what's expected from now until midnight
    const end = start + DAY;
    const fore = now < end && pts.length ? [pts[pts.length - 1], ...(next?.path || []).filter(([t]) => t > now && t <= end).map(([t, v]) => ({ t, v, predicted: true }))] : [];
    const markAt = next?.at || next?.until;
    const mark = markAt && markAt > now && markAt <= end && fore.length > 1 ? { t: markAt, v: fore[fore.length - 1].v, fire: !!next.at } : null;
    const all = [...vals, ...fore.map((p) => p.v)];
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < 3) { const mid = (hi + lo) / 2; lo = mid - 1.5; hi = mid + 1.5; }
    const x = (t) => ((t - start) / DAY) * 1440; // viewBox x is minutes of the day
    const y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * (H - 9);
    const path = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const calls = (room.calls || []).map(([a, b]) => [Math.max(a, start), b]).filter(([a, b]) => b > a);
    const forePath = fore.length > 1 ? fore.map((p, k) => `${k ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('') : null;
    return { start, pts: [...pts, ...fore.slice(1)], path, forePath, mark, calls, x, y, lo: Math.min(...vals), hi: Math.max(...vals) };
  }, [room, today, current, next]);

  const showSpark = show.spark !== false;
  const showFires = show.fires !== false;
  if (!room || (!showSpark && !showFires) || (showSpark && !d && !showFires)) return null;
  const heated = room.heatedToday || 0;
  const fired = room.firedToday || 0;
  const since = today?.firesSince ? ` since ${clock(today.firesSince, tz)}` : '';
  // an always-open radiator (no TRV of its own) also gets heat when the boiler runs for other rooms
  const others = room.open && room.withOthers?.minutes ? room.withOthers : null;
  const withOthers = others && (others.times
    ? <><b>{times(others.times)}</b> with other rooms ({hm(others.minutes)})</>
    : <><b>{hm(others.minutes)}</b> with other rooms</>);
  const summary = showFires
    ? (fired ? <>Fired <b>{times(fired)}</b>{since} · <b>{hm(heated)}</b>{withOthers ? <>, and {withOthers}</> : ' today'}</>
      : withOthers ? <>Not fired itself{since} · heated {withOthers}</>
      : heated ? <>Heated <b>{hm(heated)}</b> today</>
      : <>Not fired today{since}</>)
    : (heated || others ? <>Heated <b>{hm(heated + (others?.minutes || 0))}</b> today{others ? ', with other rooms too' : ''}</> : 'Not heated today');
  if (!showSpark || !d) {
    return <div className="spark spark-text"><span className="spark-label"><i className="sw-heat" aria-hidden="true" /><span>{summary}</span></span></div>;
  }
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    const t = d.start + f * DAY;
    let best = d.pts[0];
    for (const p of d.pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHv({ ...best, f: (best.t - d.start) / DAY, heating: !best.predicted && d.calls.some(([a, b]) => best.t >= a && best.t <= b) });
  };

  return (
    <div className="spark">
      <div className="spark-head">
        <span className="spark-label"><i className="sw-heat" aria-hidden="true" /><span>{summary}</span></span>
        <span className="num">{deg(d.lo)}–{deg(d.hi)}</span>
      </div>
      <div className="spark-plot" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHv(null)}>
        <svg viewBox={`0 0 1440 ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`${room.name} today: between ${deg(d.lo)} and ${deg(d.hi)}, ${heated ? `heated for ${hm(heated)}` : 'not heated yet'}${showFires && fired ? `, fired ${times(fired)}` : ''}`}>
          {d.calls.map(([a, b], k) => (
            <g key={k}>
              <rect className="spark-heat" x={d.x(a)} y="0" width={Math.max(3, d.x(b) - d.x(a))} height={H} />
              <rect className="spark-heat-edge" x={d.x(a)} y={H - 3} width={Math.max(3, d.x(b) - d.x(a))} height="3" />
            </g>
          ))}
          <path className="spark-line" d={d.path} />
          {d.forePath && <path className="spark-fore" d={d.forePath} />}
          {hv && <line className="spark-cross" x1={hv.f * 1440} x2={hv.f * 1440} y1="0" y2={H} />}
        </svg>
        {d.mark && (
          <span className={`spark-mark${d.mark.fire ? ' fire' : ''}`} style={{ left: `${(d.x(d.mark.t) / 1440) * 100}%`, top: `${d.y(d.mark.v)}px` }}
            title={`${d.mark.fire ? 'Should start heating' : 'Should be warm'} about ${clock(d.mark.t, tz)}`} />
        )}
        {hv && (
          <div className="spark-tip" style={{ left: `${Math.min(Math.max(hv.f, 0.14), 0.86) * 100}%` }} role="status">
            {clock(hv.t, tz)} · <b>{deg(hv.v)}</b>{hv.predicted ? ' · expected' : hv.heating ? ' · heating' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
