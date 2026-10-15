import { useEffect, useState } from 'react';
import { api, clock, dayLabel } from './lib.js';
import { Chips, Notice } from './ui.jsx';

export function Activity({ state }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const tick = state ? Math.floor(state.now / 10000) : 0;

  useEffect(() => {
    api('GET', 'activity').then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [tick]);

  if (!data || !state) return error ? <Notice tone="error">{error}</Notice> : <div className="loading" role="status">Loading activity</div>;
  const tz = state.ctx.tz;
  const items = data.items.filter((i) => filter === 'all' || i.group === filter);
  const byDay = [];
  for (const it of items) {
    const label = dayLabel(it.at, tz, state.now);
    if (!byDay.length || byDay[byDay.length - 1].label !== label) byDay.push({ label, items: [] });
    byDay[byDay.length - 1].items.push(it);
  }
  return (
    <>
      <div className="page-head">
        <h2>Activity</h2>
        {data.groups.length > 1 && (
          <Chips small label="Show" value={filter} onChange={setFilter}
            options={[{ value: 'all', label: 'Everything' }, ...data.groups.map((g) => ({ value: g.id, label: g.name }))]} />
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!items.length && <p className="fine card pad">Nothing yet. Changes the app makes, and changes made at switches or in Home Assistant, show up here.</p>}
      {byDay.map((d) => (
        <section key={d.label} className="card activity">
          <h3>{d.label}</h3>
          <ol>
            {d.items.map((it, i) => (
              <li key={`${it.at}-${i}`}><time dateTime={new Date(it.at).toISOString()}>{clock(it.at, tz)}</time><span>{it.text}</span></li>
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}
