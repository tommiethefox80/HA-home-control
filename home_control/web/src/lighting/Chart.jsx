// "Last 24 hours" for one group: actual brightness vs the app's target, movement as bands.
// Hand-written SVG; one y-axis (0-100 %). Colours validated with the dataviz palette checker (light and dark).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, clock, store } from './lib.js';
import { Chips } from './ui.jsx';

const H = 220;
const PAD = { l: 40, r: 12, t: 12, b: 26 };

export function Chart({ state }) {
  const groups = state.groups;
  const [groupId, setGroupId] = useState(() => {
    const saved = store.get('chartGroup');
    return groups.some((g) => g.id === saved) ? saved : groups[0]?.id;
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(null);
  const roRef = useRef(null);
  const tz = state.ctx.tz;

  useEffect(() => {
    if (!groups.some((g) => g.id === groupId) && groups[0]) setGroupId(groups[0].id);
  }, [groups, groupId]);

  useEffect(() => {
    if (!groupId) return undefined;
    let alive = true;
    const load = () => api('GET', `history/${groupId}`)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    setData(null);
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [groupId]);

  // Callback ref: the svg box mounts after data loads, so a plain useRef would miss it.
  const measure = useCallback((el) => {
    roRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  const g = groups.find((x) => x.id === groupId);
  const geo = useMemo(() => {
    if (!data || !width) return null;
    const iw = Math.max(50, width - PAD.l - PAD.r); const ih = H - PAD.t - PAD.b;
    const x = (t) => PAD.l + ((t - data.start) / (data.end - data.start)) * iw;
    const y = (v) => PAD.t + ih - (v / 100) * ih;
    const path = (key) => {
      let d = ''; let pen = false;
      for (const p of data.points) {
        const v = p[key];
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    // Step lines: lights change in jumps, so draw horizontal-then-vertical.
    const stepPath = (key) => {
      let d = ''; let prev = null;
      for (const p of data.points) {
        const v = p[key];
        if (v == null) { prev = null; continue; }
        const px = x(p.t).toFixed(1); const py = y(v).toFixed(1);
        d += prev == null ? `M${px},${py}` : `H${px}V${py}`;
        prev = v;
      }
      return d;
    };
    const ticks = [];
    const first = Math.ceil(data.start / 3600000) * 3600000;
    for (let t = first; t <= data.end; t += 3600000) {
      const hour = Number(clock(t, tz).slice(0, 2));
      if (hour % 6 === 0) ticks.push(t);
    }
    return { iw, ih, x, y, actual: stepPath('actual'), target: stepPath('target'), ticks, path };
  }, [data, width, tz]);

  const onMove = (e) => {
    if (!geo || !data) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const t = data.start + ((px - PAD.l) / geo.iw) * (data.end - data.start);
    let best = null;
    for (const p of data.points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHover(best);
  };

  if (!groups.length) return null;
  const hourly = data ? data.points.filter((p, i) => i % 12 === 0) : [];
  const fmtV = (v) => (v == null ? 'No data' : v === 0 ? 'Off' : `${v}%`);
  const inBand = (t) => data?.bands.some((b) => t >= b.from && t <= b.to);

  return (
    <section className="card chart-card" aria-labelledby="chart-title">
      <div className="row-between chart-top">
        <h2 id="chart-title">Last 24 hours</h2>
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setTable((v) => !v)} aria-pressed={table}>
          {table ? 'Show as chart' : 'Show as table'}
        </button>
      </div>
      <Chips small label="Group to show" value={groupId} onChange={(v) => { setGroupId(v); store.set('chartGroup', v); setHover(null); }}
        options={groups.map((x) => ({ value: x.id, label: x.name }))} />

      <ul className="legend" aria-label="Legend">
        <li><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" className="s-actual" /></svg>Brightness</li>
        <li><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" className="s-target" /></svg>What the app wanted</li>
        {data?.hasMotion && <li><span className="legend-band" aria-hidden="true" />Movement</li>}
      </ul>

      {error && <p className="fine">Couldn't load the history: {error}</p>}
      {!error && !data && <div className="chart-loading" role="status">Loading history</div>}

      {data && !table && (
        <div className="chart-box" ref={measure}>
          {geo && (
            <svg width={width} height={H} className="chart" role="img"
              aria-label={`${g?.name} brightness over the last 24 hours. Use Show as table for the values.`}
              onMouseMove={onMove} onMouseLeave={() => setHover(null)} onTouchStart={onMove} onTouchMove={onMove}>
              {data.bands.map((b, i) => (
                <rect key={i} className="band" x={geo.x(b.from)} y={PAD.t} width={Math.max(2, geo.x(b.to) - geo.x(b.from))} height={geo.ih} />
              ))}
              {[0, 25, 50, 75, 100].map((v) => (
                <g key={v}>
                  <line className="grid" x1={PAD.l} x2={PAD.l + geo.iw} y1={geo.y(v)} y2={geo.y(v)} />
                  <text className="axis" x={PAD.l - 6} y={geo.y(v) + 4} textAnchor="end">{v === 0 ? 'Off' : `${v}%`}</text>
                </g>
              ))}
              {geo.ticks.map((t) => (
                <text key={t} className="axis" x={geo.x(t)} y={H - 6} textAnchor="middle">{clock(t, tz)}</text>
              ))}
              <path d={geo.target} className="s-target" fill="none" />
              <path d={geo.actual} className="s-actual" fill="none" />
              {hover && (
                <g>
                  <line className="crosshair" x1={geo.x(hover.t)} x2={geo.x(hover.t)} y1={PAD.t} y2={PAD.t + geo.ih} />
                  {hover.actual != null && <circle className="dot-actual" cx={geo.x(hover.t)} cy={geo.y(hover.actual)} r="4.5" />}
                  {hover.target != null && <circle className="dot-target" cx={geo.x(hover.t)} cy={geo.y(hover.target)} r="4.5" />}
                </g>
              )}
            </svg>
          )}
          {hover && geo && (
            <div className="tooltip" style={{ left: Math.min(Math.max(geo.x(hover.t), 80), width - 80) }}>
              <strong>{clock(hover.t, tz)}</strong>
              <span>Brightness {fmtV(hover.actual)}</span>
              <span>Wanted {fmtV(hover.target)}</span>
              {data.hasMotion && inBand(hover.t) && <span>Movement</span>}
            </div>
          )}
        </div>
      )}

      {data && table && (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Time</th><th scope="col">Brightness</th><th scope="col">Wanted</th>{data.hasMotion && <th scope="col">Movement</th>}</tr></thead>
            <tbody>
              {hourly.map((p) => (
                <tr key={p.t}><td>{clock(p.t, tz)}</td><td>{fmtV(p.actual)}</td><td>{fmtV(p.target)}</td>{data.hasMotion && <td>{inBand(p.t) ? 'Yes' : ''}</td>}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">Brightness is the average across the group's lights; sockets count as 100% when on.</p>
    </section>
  );
}
