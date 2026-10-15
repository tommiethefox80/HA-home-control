import { useState } from 'react';
import { api, deg, fmtTime, minutesLeft } from './lib.js';
import { Icon, Sheet, Stepper } from './ui.jsx';

const label = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

export function BoostSheet({ state, onClose, notify }) {
  const s = state.settings;
  const rooms = state.zones.filter((z) => z.enabled);
  const active = state.houseBoost;
  const defaultMins = Number(s.houseBoostMinutes) || 30;
  const durations = [...new Set([15, 30, 45, 60, 90, 120, defaultMins])].sort((a, b) => a - b);
  const [temp, setTemp] = useState(Number(s.houseBoostTemp) || 22);
  const [mins, setMins] = useState(defaultMins);
  // snoozed rooms start unticked: they're meant to stay cool (tick one to boost it anyway; it goes back to its snooze after)
  const [picked, setPicked] = useState(() => rooms.filter((r) => !r.snoozedUnder).map((r) => r.id));
  const [busy, setBusy] = useState(false);
  const off = state.mode === 'off';

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const all = picked.length === rooms.length;

  const start = async () => {
    setBusy(true);
    try {
      await api('boost', 'POST', { temp, minutes: mins, zoneIds: picked });
      notify(`Boosting ${picked.length === rooms.length ? 'the house' : `${picked.length} room${picked.length === 1 ? '' : 's'}`} to ${deg(temp)} for ${label(mins)}`);
      onClose();
    } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await api('boost', 'DELETE'); notify('Boost stopped, rooms back to what they were doing'); onClose(); }
    catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };

  return (
    <Sheet onClose={onClose} label="Boost the house">
      <h2>Boost the house</h2>
      {active ? (
        <div className="boost-running">
          <p><b>Boosting to {deg(active.temp)}</b> in {active.zones.length} room{active.zones.length === 1 ? '' : 's'} until {fmtTime(active.until, state.timeZone)}, {minutesLeft(active.until)} left.</p>
          <button className="btn" disabled={busy} onClick={stop}>Stop boost now</button>
        </div>
      ) : (
        <p className="lede">Warms the rooms you pick for a while. Afterwards each room goes back to exactly what it was doing before.</p>
      )}

      {off ? (
        <p>Heating is switched off for the whole house. Switch back to Schedules or Away to boost.</p>
      ) : (
        <>
          {active && <h3>Start a new boost instead</h3>}
          <h3>Temperature</h3>
          <Stepper value={temp} onChange={setTemp} min={10} max={28} label="boost temperature" />

          <h3>For</h3>
          <div className="choice-row">
            {durations.map((m) => <button key={m} className="chip" aria-pressed={mins === m} onClick={() => setMins(m)}>{label(m)}</button>)}
          </div>

          <div className="boost-rooms-head">
            <h3>Rooms</h3>
            <button className="btn link" onClick={() => setPicked(all ? [] : rooms.map((r) => r.id))}>{all ? 'Untick all' : 'Tick all'}</button>
          </div>
          <div className="checklist">
            {rooms.map((r) => (
              <label key={r.id}>
                <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
                {r.name}
                <small>{deg(r.current)} now, {r.snoozedUnder ? 'snoozed' : r.target >= temp ? `already set to ${deg(r.target)}` : `set to ${deg(r.target)}`}</small>
              </label>
            ))}
          </div>

          <div className="actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <span className="spacer" />
            <button className="btn primary boost-go" disabled={busy || picked.length === 0} onClick={start}>
              <Icon.flame />
              {picked.length === 0 ? 'Pick a room' : `Boost ${all ? 'all rooms' : `${picked.length} room${picked.length === 1 ? '' : 's'}`} for ${label(mins)}`}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
