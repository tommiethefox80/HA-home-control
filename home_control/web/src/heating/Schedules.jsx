import { useState } from 'react';
import { api, thermal, DAYS, DAY_NAMES, DAY_SHORT, nowLocal, toMin } from './lib.js';
import { Icon, Ribbon, Stepper, Sheet } from './ui.jsx';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND = ['sat', 'sun'];

function RoomChips({ rooms, picked, setPicked }) {
  const toggle = (id) => setPicked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <div className="choice-row">
      <button className="chip" aria-pressed={picked.length === rooms.length && rooms.length > 0} onClick={() => setPicked(picked.length === rooms.length ? [] : rooms.map((r) => r.id))}>All rooms</button>
      {rooms.map((r) => (
        <button key={r.id} className="chip" aria-pressed={picked.includes(r.id)} onClick={() => toggle(r.id)}>{r.name}</button>
      ))}
    </div>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function DayEditor({ zone, schedule, day, tz, onClose, notify, rooms, schedules }) {
  const [points, setPoints] = useState(() => (schedule[day] || []).map((p) => ({ ...p })));
  const [copyTo, setCopyTo] = useState([]);
  const [copyRooms, setCopyRooms] = useState([]);
  const otherRooms = rooms.filter((r) => r.id !== zone.id);
  const [saving, setSaving] = useState(false);

  const update = (i, patch) => setPoints((ps) => ps.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const remove = (i) => setPoints((ps) => ps.filter((_, k) => k !== i));
  // New change goes 2h after the last one, or into the middle of the biggest gap if the day is full.
  const add = () => setPoints((ps) => {
    const times = ps.map((p) => toMin(p.time)).filter(Number.isFinite).sort((a, b) => a - b);
    let at = times.length ? times[times.length - 1] + 120 : 6 * 60;
    if (at > 23 * 60 + 30) {
      let best = { gap: times[0], at: Math.max(0, Math.round(times[0] / 2 / 15) * 15) };
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        if (gap > best.gap) best = { gap, at: Math.round((times[i - 1] + gap / 2) / 15) * 15 };
      }
      at = best.at;
    }
    const t = `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    return [...ps, { time: t, temp: ps.length ? ps[ps.length - 1].temp : 19 }];
  });
  const toggleCopy = (d) => setCopyTo((c) => (c.includes(d) ? c.filter((x) => x !== d) : [...c, d]));
  const setGroup = (g) => setCopyTo(g.filter((d) => d !== day));
  const isGroup = (g) => { const want = g.filter((d) => d !== day); return want.length > 0 && want.length === copyTo.length && want.every((d) => copyTo.includes(d)); };

  const sorted = points.filter((p) => Number.isFinite(toMin(p.time))).map((p) => ({ ...p, time: p.time.slice(0, 5) })).sort((a, b) => toMin(a.time) - toMin(b.time));
  const preview = { ...schedule, [day]: sorted };

  const save = async () => {
    setSaving(true);
    const days = [day, ...copyTo];
    const apply = (sched) => {
      const next = { ...sched };
      for (const d of days) next[d] = sorted.map((p) => ({ ...p }));
      return next;
    };
    try {
      await api(`zones/${zone.id}/schedule`, 'PUT', apply(schedule));
      for (const id of copyRooms) await api(`zones/${id}/schedule`, 'PUT', apply(schedules[id] || {}));
      const what = days.length > 1 ? plural(days.length, 'day') : DAY_NAMES[day];
      notify(copyRooms.length ? `Saved ${what} for ${plural(copyRooms.length + 1, 'room')}` : `Saved ${what}`);
      onClose();
    } catch (e) { notify(e.message, true); } finally { setSaving(false); }
  };

  return (
    <Sheet onClose={onClose} label={`${zone.name}, ${DAY_NAMES[day]}`}>
      <h2>{zone.name}, {DAY_NAMES[day]}</h2>
      <p className="lede">Each change sets the temperature from that time until the next one. Before the first change, yesterday’s last setting carries on.</p>
      <Ribbon schedule={preview} day={day} tz={tz} tall showHours labels />

      <h3>Changes</h3>
      <ul className="points">
        {points.map((p, i) => (
          <li className="point" key={i}>
            <input type="time" value={p.time} step={300} aria-label={`Change ${i + 1} time`} onChange={(e) => update(i, { time: e.target.value })} />
            <Stepper small value={Number(p.temp)} onChange={(t) => update(i, { temp: t })} label={`change ${i + 1} temperature`} />
            <button className="icon-btn" aria-label={`Remove change at ${p.time}`} onClick={() => remove(i)}><Icon.x /></button>
          </li>
        ))}
      </ul>
      {points.length === 0 && <p className="lede">No changes on this day, so yesterday’s last temperature holds all day.</p>}
      <button className="btn" onClick={add} disabled={points.length >= 12}>Add a change</button>

      <h3>Also use for</h3>
      <div className="choice-row" style={{ marginBottom: 10 }}>
        <button className="chip" aria-pressed={isGroup(WEEKDAYS)} onClick={() => setGroup(WEEKDAYS)}>Weekdays</button>
        <button className="chip" aria-pressed={isGroup(WEEKEND)} onClick={() => setGroup(WEEKEND)}>Weekend</button>
        <button className="chip" aria-pressed={isGroup(DAYS)} onClick={() => setGroup(DAYS)}>Every day</button>
        {copyTo.length > 0 && <button className="chip" onClick={() => setCopyTo([])}>None</button>}
      </div>
      <div className="choice-row">
        {DAYS.filter((d) => d !== day).map((d) => (
          <button key={d} className="chip" aria-pressed={copyTo.includes(d)} onClick={() => toggleCopy(d)}>{DAY_SHORT[d]}</button>
        ))}
      </div>

      {otherRooms.length > 0 && (
        <>
          <h3>Also use in</h3>
          <RoomChips rooms={otherRooms} picked={copyRooms} setPicked={setCopyRooms} />
          {copyRooms.length > 0 && <p className="lede" style={{ marginTop: 10 }}>Replaces {copyTo.length ? `these ${copyTo.length + 1} days` : DAY_NAMES[day]} in {plural(copyRooms.length, 'other room')}. Their other days stay as they are.</p>}
        </>
      )}

      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <span className="spacer" />
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save schedule'}</button>
      </div>
    </Sheet>
  );
}

function CopyWeekSheet({ zone, schedule, rooms, onClose, notify }) {
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    setBusy(true);
    try {
      for (const id of picked) await api(`zones/${id}/schedule`, 'PUT', schedule);
      notify(`Copied ${zone.name}’s week to ${plural(picked.length, 'room')}`);
      onClose();
    } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  return (
    <Sheet onClose={onClose} label={`Copy ${zone.name}’s week`}>
      <h2>Copy {zone.name}’s week</h2>
      <p className="lede">The rooms you pick get exactly the same seven days. Their current schedules are replaced.</p>
      <RoomChips rooms={rooms} picked={picked} setPicked={setPicked} />
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <span className="spacer" />
        <button className="btn primary" onClick={copy} disabled={busy || picked.length === 0}>
          {busy ? 'Copying…' : picked.length ? `Copy to ${plural(picked.length, 'room')}` : 'Pick a room'}
        </button>
      </div>
    </Sheet>
  );
}

export default function Schedules({ state, zoneId, notify }) {
  const zones = state.zoneConfig;
  const zone = zones.find((z) => z.id === zoneId) || zones[0];
  const [editing, setEditing] = useState(null);
  const [copying, setCopying] = useState(false);
  const tz = state.timeZone;
  const today = nowLocal(tz).day;

  if (!zone) {
    return <div className="empty"><h2>No rooms yet</h2><p>Add a room in Settings, then set its week here.</p><a className="btn primary" href="#/settings">Add a room</a></div>;
  }
  const schedule = state.schedules[zone.id] || {};
  return (
    <>
      <nav className="room-picker" aria-label="Rooms">
        {zones.map((z) => (
          <a key={z.id} className="chip" href={`#/schedules/${z.id}`} aria-pressed={z.id === zone.id} style={{ textDecoration: 'none' }}>{z.name}</a>
        ))}
      </nav>
      <section className="week" aria-label={`${zone.name} weekly schedule`}>
        {DAYS.map((d) => (
          <button key={d} className={`week-row${d === today ? ' today' : ''}`} onClick={() => setEditing(d)} aria-label={`Edit ${DAY_NAMES[d]}`}>
            <span className="d">{DAY_SHORT[d]}</span>
            <Ribbon schedule={schedule} day={d} tz={tz} tall labels showNow={d === today} />
          </button>
        ))}
        <div className="ribbon-hours" style={{ marginLeft: 54 }} aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      </section>
      <div className="legend">
        <span>7°</span>
        <span className="scale" style={{ background: `linear-gradient(90deg, ${[7, 13, 16.5, 19, 21, 24].map(thermal).join(',')})` }} />
        <span>24°</span>
        <span style={{ marginLeft: 'auto' }}>Tap a day to change it</span>
      </div>
      {zones.length > 1 && (
        <div className="actions"><button className="btn" onClick={() => setCopying(true)}>Copy this week to other rooms</button></div>
      )}
      {editing && <DayEditor key={`${zone.id}-${editing}`} zone={zone} schedule={schedule} day={editing} tz={tz} onClose={() => setEditing(null)} notify={notify} rooms={zones} schedules={state.schedules} />}
      {copying && <CopyWeekSheet zone={zone} schedule={schedule} rooms={zones.filter((z) => z.id !== zone.id)} onClose={() => setCopying(false)} notify={notify} />}
    </>
  );
}
