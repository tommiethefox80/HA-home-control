import { useEffect, useState } from 'react';
import { api, thermal, deg } from './lib.js';
import { Sheet } from './ui.jsx';
import { HomeSettings } from '../HomeSettings.jsx';

// Per-room "stop early": learned automatically, a fixed % of the target, or the house setting.
function StopEarlyField({ room, form, setForm, live, houseStop, notify }) {
  const target = live?.target ?? 20;
  const mode = form.stopEarlyMode;
  const pct = form.stopEarlyPct === '' ? null : Number(form.stopEarlyPct);
  const learn = live?.learn;
  const c = live?.coast;
  const fmt = (d) => `${(Math.round(d * 100) / 100).toFixed(2).replace(/0$/, '')}°`;
  const pctOf = (d) => Math.round((d / target) * 1000) / 10;
  const rise = c ? Math.round((c.peak - c.stoppedAt) * 10) / 10 : null;
  const over = c ? Math.round((c.peak - c.target) * 10) / 10 : null;
  const suggest = c && over > 0.1 ? Math.min(10, Math.ceil((rise / c.target) * 100 * 2) / 2) : null;
  const relearn = async () => {
    try { await api(`zones/${room.id}/learn`, 'DELETE'); notify(`${room.name} will learn again from scratch`); }
    catch (e) { notify(e.message, true); }
  };
  const fixedDeg = pct == null ? 0 : Math.round(target * pct) / 100;
  return (
    <div className="field">
      <span>Stop heating early</span>
      <small>Radiators keep giving off heat after they shut off, so a room can carry on warming past its target. Stopping a little early lets it coast up to the target instead. While the room isn't calling for heat, its valves are turned down to the stop point so they close too.</small>
      <div className="choice-row" role="group" aria-label="How to stop early">
        <button type="button" className="chip" aria-pressed={mode === 'auto'} onClick={() => setForm({ ...form, stopEarlyMode: 'auto' })}>Learn automatically</button>
        <button type="button" className="chip" aria-pressed={mode === 'fixed'} onClick={() => setForm({ ...form, stopEarlyMode: 'fixed', stopEarlyPct: form.stopEarlyPct === '' ? '2' : form.stopEarlyPct })}>Fixed %</button>
        <button type="button" className="chip" aria-pressed={mode === 'house'} onClick={() => setForm({ ...form, stopEarlyMode: 'house' })}>House setting</button>
      </div>

      {mode === 'auto' && (
        <div className="coast-note">
          {learn?.cycles ? (
            <>
              <p>Learned from {learn.cycles} heat-up{learn.cycles === 1 ? '' : 's'}: stops <b>{fmt(learn.margin)} early</b> (about {pctOf(learn.margin)}% of {deg(target)}, so at {deg(Math.round((target - learn.margin) * 10) / 10)}).</p>
              <ul className="learn-list">
                {[...learn.history].reverse().slice(0, 4).map((h) => (
                  <li key={h.at}>{new Date(h.at).toLocaleDateString('en-GB', { weekday: 'short' })} {new Date(h.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}: stopped at {deg(h.stoppedAt)}, peaked at {deg(h.peak)} {h.err > 0.05 ? `(${h.err}° over)` : h.err < -0.05 ? `(${Math.abs(h.err)}° short)` : '(on target)'}</li>
                ))}
              </ul>
              <button type="button" className="btn link" onClick={relearn}>Forget and relearn</button>
            </>
          ) : (
            <p>Still learning. After the next heat-up it watches how far the room keeps rising and adjusts itself. Until then it uses the house setting ({houseStop ? `${houseStop}° early` : 'stop at target'}).</p>
          )}
        </div>
      )}

      {mode === 'fixed' && (
        <>
          <div className="pct-row">
            <input type="number" inputMode="decimal" step="0.5" min="0" max="10" aria-label="Stop early, percent of target"
              value={form.stopEarlyPct} onChange={(e) => setForm({ ...form, stopEarlyPct: e.target.value })} />
            <span className="pct-unit">% of target</span>
          </div>
          <small>At {deg(target)} this stops the heating at {deg(Math.round((target - fixedDeg) * 10) / 10)} ({fmt(fixedDeg)} early).</small>
          {c && over > 0.1 && suggest != null && (
            <p className="coast-note">Last time it kept rising {rise}° after stopping, {over}° over target. About {suggest}% would have stopped that. <button type="button" className="btn link" onClick={() => setForm({ ...form, stopEarlyPct: String(suggest) })}>Use {suggest}%</button></p>
          )}
        </>
      )}

      {mode === 'house' && <small>Uses the house setting under Temperatures: {houseStop ? `stops ${houseStop}° early` : 'stops at the target'}.</small>}
    </div>
  );
}

function RoomEditor({ room, entities, state, onClose, notify }) {
  const isNew = !room.id;
  const [form, setForm] = useState({
    name: room.name || '', trvs: room.trvs || [], sensor: room.sensor || '', enabled: room.enabled !== false,
    stopEarlyPct: room.stopEarlyPct ?? '',
    stopEarlyMode: room.stopEarlyMode || (room.stopEarlyPct != null ? 'fixed' : 'auto'),
    openRadiator: room.openRadiator ?? null,
  });
  const live = state.zones.find((z) => z.id === room.id);
  const [busy, setBusy] = useState(false);
  const boiler = state.settings.boiler.entity;
  const usedElsewhere = new Set(state.zoneConfig.filter((z) => z.id !== room.id).flatMap((z) => z.trvs));
  const climates = entities.filter((e) => e.domain === 'climate');
  const sensors = entities.filter((e) => e.kind === 'temperature');

  const toggleTrv = (id) => setForm((f) => ({ ...f, trvs: f.trvs.includes(id) ? f.trvs.filter((x) => x !== id) : [...f.trvs, id] }));
  const save = async () => {
    if (!form.name.trim()) return notify('Give the room a name', true);
    setBusy(true);
    try {
      if (isNew) await api('zones', 'POST', form);
      else await api(`zones/${room.id}`, 'PUT', form);
      notify(isNew ? `Added ${form.name}` : `Saved ${form.name}`);
      onClose();
    } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${room.name}? Its schedule will be deleted and its radiators left as they are.`)) return;
    try { await api(`zones/${room.id}`, 'DELETE'); notify(`Removed ${room.name}`); onClose(); } catch (e) { notify(e.message, true); }
  };

  return (
    <Sheet onClose={onClose} label={isNew ? 'Add a room' : `Edit ${room.name}`}>
      <h2>{isNew ? 'Add a room' : `Edit ${room.name}`}</h2>
      {isNew && <p className="lede">New rooms start on a typical weekday and weekend schedule you can change straight after.</p>}
      <label className="field"><span>Name</span><input value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Lounge" /></label>

      <div className="field">
        <span>Radiators</span>
        <small>Pick every TRV in this room. All of them get the same target. If the boiler thermostat is in this room, tick it too: it gives the room temperature and keeps firing the boiler.</small>
        <div className="checklist">
          {climates.map((e) => (
            <label key={e.entity_id}>
              <input type="checkbox" checked={form.trvs.includes(e.entity_id)} onChange={() => toggleTrv(e.entity_id)} />
              {e.name}
              <small>{usedElsewhere.has(e.entity_id) ? 'in another room' : e.entity_id === boiler ? 'boiler thermostat' : e.integration?.includes('Hive') ? 'Hive' : e.entity_id}</small>
            </label>
          ))}
          {climates.length === 0 && <p className="lede">No radiator valves found in Home Assistant.</p>}
        </div>
      </div>

      <label className="field">
        <span>Radiator valves</span>
        <small>A radiator with no TRV (often the one in the room with the boiler thermostat) is always open, so it gets heat whenever the boiler runs for any room. Home Control counts that separately and keeps it out of what the room learns.</small>
        <select value={form.openRadiator == null ? 'auto' : form.openRadiator ? 'open' : 'trv'}
          onChange={(e) => setForm({ ...form, openRadiator: e.target.value === 'auto' ? null : e.target.value === 'open' })}>
          <option value="auto">Work it out ({!form.trvs.some((e) => e !== boiler) ? 'no TRV picked, so always open' : 'has TRVs'})</option>
          <option value="trv">Its radiators have TRVs</option>
          <option value="open">A radiator here is always open (no TRV)</option>
        </select>
      </label>

      <label className="field">
        <span>Room thermometer</span>
        <small>Optional. A sensor away from the radiator gives a truer reading than the TRV’s own.</small>
        <select value={form.sensor} onChange={(e) => setForm({ ...form, sensor: e.target.value })}>
          <option value="">Use the radiators’ own readings</option>
          {sensors.map((e) => <option key={e.entity_id} value={e.entity_id}>{e.name} ({deg(Number(e.state))})</option>)}
        </select>
      </label>

      <StopEarlyField room={room} form={form} setForm={setForm} live={live} houseStop={Number(state.settings.stopEarly) || 0} notify={notify} />
      {!isNew && (
        <div className="field">
          <span>Warm-up speed</span>
          <small>
            {live?.warm?.samples
              ? `Learned from ${live.warm.samples} heat-up${live.warm.samples === 1 ? '' : 's'}: warms about ${live.warm.rate.toFixed(1)}° an hour${live.warm.gap != null ? ` when it's ${Math.round(live.warm.gap)}° colder outside than the target` : ''}. Used to start heating early so the room is warm by its scheduled time.`
              : 'Still learning. After its next heat-up of 20 minutes or more, the app knows how quickly this room warms and can start early so it\'s warm by the scheduled time.'}
          </small>
        </div>
      )}

      <label className="toggle">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span>Manage this room<small>Turn off to leave its radiators alone without losing the schedule.</small></span>
      </label>

      <div className="actions">
        {!isNew && <button className="btn danger" onClick={remove}>Remove room</button>}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{isNew ? 'Add room' : 'Save room'}</button>
      </div>
    </Sheet>
  );
}

function ChildLocks({ state, notify }) {
  const locks = state.zones.flatMap((z) => z.trvs.filter((t) => t.childLock).map((t) => ({ ...t.childLock, trv: t.name, room: z.name })));
  const [busy, setBusy] = useState(false);
  if (!locks.length) return null;
  const onCount = locks.filter((l) => l.on).length;
  const all = async (on) => {
    setBusy(true);
    try { await api('childlock', 'POST', { all: true, on }); notify(on ? 'Child locks on' : 'Child locks off'); }
    catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  return (
    <section className="section">
      <h2>Child locks</h2>
      <p>{onCount} of {locks.length} radiators with a child lock {locks.length === 1 ? 'has' : 'have'} it on. Locked valves ignore their buttons and dial, but this app can still change them.</p>
      <ul className="room-list">
        {locks.map((l) => (
          <li key={l.entity_id}>
            <span style={{ flex: 1 }}>{l.trv}<br /><span className="sub">{l.room}{l.available ? '' : ', offline'}</span></span>
            <span className="sub">{l.on ? 'Locked' : 'Unlocked'}</span>
          </li>
        ))}
      </ul>
      <div className="actions" style={{ marginTop: 6 }}>
        <button className="btn" disabled={busy || onCount === 0} onClick={() => all(false)}>Unlock all</button>
        <button className="btn primary" disabled={busy || onCount === locks.length} onClick={() => all(true)}>Lock all</button>
      </div>
    </section>
  );
}

const numIn = (v) => (v === '' ? '' : Number(v));

// Warm by the scheduled time, open windows, away automatically.
function HistorySettings({ s, set }) {
  const r = s.retention || { activityDays: 30, detailDays: 7, dailyDays: 400 };
  const [usage, setUsage] = useState(null);
  useEffect(() => { api('storage').then(setUsage).catch(() => setUsage(null)); }, [r.activityDays, r.detailDays, r.dailyDays]);
  const size = (...names) => names.reduce((a, nm) => a + (usage?.files.find((f) => f.name === nm)?.bytes || 0), 0);
  const kb = (b) => (b < 1024 ? `${b} bytes` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const upd = (k, v) => set({ retention: { ...r, [k]: numIn(v) } });
  return (
    <section className="section">
      <h2>History</h2>
      <p>How long the app keeps its own records. Room temperatures and the boiler's on/off come from Home Assistant's history, which keeps 10 days unless you change <code>purge_keep_days</code> in its recorder settings; the daily statistics behind Insights are kept by Home Assistant indefinitely.</p>
      <label className="field">
        <span>Activity log (days)</span>
        <small>Everything in the Activity tab: boiler starts, holds, boosts, snoozes, schedule changes. {usage ? `Now ${usage.activity.entries} entries, ${kb(size('activity.json'))}.` : ''}</small>
        <input type="number" min="1" max="365" step="1" value={r.activityDays} onChange={(e) => upd('activityDays', e.target.value)} />
      </label>
      <label className="field">
        <span>Room detail (days)</span>
        <small>Each room's targets and when it called for heat. The 24-hour chart and the room cards only use the last day. {usage ? `Now ${kb(size('targets.json', 'calls.json'))}.` : ''}</small>
        <input type="number" min="1" max="90" step="1" value={r.detailDays} onChange={(e) => upd('detailDays', e.target.value)} />
      </label>
      <label className="field">
        <span>Daily totals (days)</span>
        <small>Each day's boiler hours, outside average, and each room's heating time and average temperature. Insights shows the last 30 days. {usage ? `Now ${usage.daily.days} day${usage.daily.days === 1 ? '' : 's'}, ${kb(size('daily.json'))}.` : ''}</small>
        <input type="number" min="30" max="1100" step="1" value={r.dailyDays} onChange={(e) => upd('dailyDays', e.target.value)} />
      </label>
      <p className="hint">Lowering a number deletes the older records when you save. All of it is included in Home Assistant backups.</p>
    </section>
  );
}

function SmartSettings({ s, set, state }) {
  const pre = s.preheat || { enabled: true, maxMinutes: 120 };
  const win = s.window || { enabled: true, drop: 1, minutes: 10, pauseMinutes: 20 };
  const learned = state.zones.filter((z) => z.warm?.samples).length;
  return (
    <>
      <section className="section">
        <h2>Warm by the scheduled time</h2>
        <label className="toggle">
          <input type="checkbox" checked={!!pre.enabled} onChange={(e) => set({ preheat: { ...pre, enabled: e.target.checked } })} />
          <span>Start heating early<small>Each room learns how quickly it warms (allowing for how cold it is outside) and starts early so it's at the new temperature by the scheduled time, rather than only starting to warm then. {learned ? `${learned} of ${state.zones.length} rooms have learned so far.` : 'Rooms learn from their first heat-up.'}</small></span>
        </label>
        {pre.enabled && (
          <label className="field" style={{ marginTop: 6 }}>
            <span>Start at most this early (minutes)</span>
            <input type="number" step="15" value={pre.maxMinutes} onChange={(e) => set({ preheat: { ...pre, maxMinutes: numIn(e.target.value) } })} />
          </label>
        )}
      </section>

      <section className="section">
        <h2>Open windows</h2>
        <label className="toggle">
          <input type="checkbox" checked={!!win.enabled} onChange={(e) => set({ window: { ...win, enabled: e.target.checked } })} />
          <span>Pause a room when its temperature drops sharply<small>A sudden drop usually means a window or door is open. The room's valves go to frost protection for a while instead of heating the street. You can resume it from the room any time.</small></span>
        </label>
        {win.enabled && (
          <div className="grid2" style={{ marginTop: 6 }}>
            <label className="field"><span>Drop of (°)</span><input type="number" step="0.1" value={win.drop} onChange={(e) => set({ window: { ...win, drop: numIn(e.target.value) } })} /></label>
            <label className="field"><span>Within (minutes)</span><input type="number" value={win.minutes} onChange={(e) => set({ window: { ...win, minutes: numIn(e.target.value) } })} /></label>
            <label className="field"><span>Pause for (minutes)</span><input type="number" step="5" value={win.pauseMinutes} onChange={(e) => set({ window: { ...win, pauseMinutes: numIn(e.target.value) } })} /></label>
          </div>
        )}
        <small style={{ display: 'block', color: 'var(--ink-2)', fontSize: '.84rem' }}>Works best with valves or thermometers that report often. Hive valves can take a few minutes to report, so a quick blast of cold air may be missed.</small>
      </section>

    </>
  );
}

const ALERTS = [
  ['on', 'When the heating comes on', 'e.g. "Heating on: boiler fired for Lounge 18.9° (wants 21°)."'],
  ['off', 'When the heating goes off', 'e.g. "Heating off: no rooms need heat now, so the boiler has stopped. It ran for 42 min."'],
  ['window', 'When a window looks open', 'e.g. "Kitchen: window open? Kitchen dropped 1.2° in a few minutes, so its heating is paused until 21:05."'],
];

function PhoneAlerts({ s, setNotify, targets, saveFirst, dirty, notify }) {
  const [testing, setTesting] = useState(null);
  const n = s.notify || { on: {}, off: {} };
  const known = new Set(targets.map((t) => t.service));
  const test = async (which) => {
    setTesting(which);
    try {
      if (dirty) await saveFirst();
      await api('notify/test', 'POST', { which });
      notify('Test alert sent');
    } catch (e) { notify(e.message, true); } finally { setTesting(null); }
  };
  return (
    <section className="section">
      <h2>Phone alerts</h2>
      <p>Get a notification from the Home Assistant app when the boiler starts or stops, or when a window looks open. Pick a group service to alert several phones at once.</p>
      {ALERTS.map(([which, label, example]) => {
        const cfg = n[which] || {};
        const custom = cfg.service && !known.has(cfg.service);
        return (
          <div className="alert-row" key={which}>
            <label className="toggle">
              <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setNotify(which, { enabled: e.target.checked })} />
              <span>{label}<small>{example}</small></span>
            </label>
            <div className="alert-device">
              {targets.length > 0 ? (
                <select aria-label={`Device for "${label}"`} value={custom ? '__other' : cfg.service || ''} onChange={(e) => setNotify(which, { service: e.target.value === '__other' ? 'notify.' : e.target.value })}>
                  <option value="">Choose a device…</option>
                  {targets.map((t) => <option key={t.service} value={t.service}>{t.mobile ? `${t.name} (phone app)` : t.name}</option>)}
                  <option value="__other">Other notify service…</option>
                </select>
              ) : null}
              {(targets.length === 0 || custom) && (
                <input aria-label={`Notify service for "${label}"`} value={cfg.service || ''} placeholder="notify.mobile_app_your_phone" onChange={(e) => setNotify(which, { service: e.target.value.trim() })} />
              )}
              <button className="btn" disabled={!cfg.service || testing === which} onClick={() => test(which)}>{testing === which ? 'Sending…' : 'Send test'}</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

export default function Settings({ state, notify, focus }) {
  const [entities, setEntities] = useState([]);
  // links like #/settings/away (from the Lighting settings) open on that section
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => document.getElementById(focus === 'away' ? 'home-away' : `set-${focus}`)?.scrollIntoView({ block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [focus]);
  const [editing, setEditing] = useState(null);
  const [s, setS] = useState(state.settings);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { api('entities').then(setEntities).catch((e) => notify(e.message, true)); }, [state.haConnected]);
  useEffect(() => { if (!dirty) setS(state.settings); }, [state.settings, dirty]);

  const set = (patch) => { setS((x) => ({ ...x, ...patch })); setDirty(true); };
  const setB = (patch) => { setS((x) => ({ ...x, boiler: { ...x.boiler, ...patch } })); setDirty(true); };
  const save = async () => {
    const { presence, dashboardPath, ...mine } = s; // saved by the Home Control block, as you change them
    try { await api('settings', 'PUT', mine); setDirty(false); notify('Settings saved'); } catch (e) { notify(e.message, true); }
  };
  const nameOf = (id) => entities.find((e) => e.entity_id === id)?.name || id;
  const [targets, setTargets] = useState([]);
  useEffect(() => { api('notify-targets').then(setTargets).catch(() => setTargets([])); }, [state.haConnected]);
  const setNotify = (which, patch) => {
    setS((x) => {
      const n = x.notify || { on: { enabled: false, service: '' }, off: { enabled: false, service: '' } };
      return { ...x, notify: { ...n, [which]: { ...n[which], ...patch } } };
    });
    setDirty(true);
  };
  const saveFirst = async () => { const { presence, dashboardPath, ...mine } = s; await api('settings', 'PUT', mine); setDirty(false); };
  const boilerOptions = entities.filter((e) => ['climate', 'switch', 'input_boolean'].includes(e.domain));
  const boilerIsClimate = s.boiler.entity?.startsWith('climate.');

  return (
    <>
      <HomeSettings />

      <section className="section">
        <h2>Rooms</h2>
        <p>Each room groups its radiator valves and follows one schedule.</p>
        <ul className="room-list">
          {state.zoneConfig.map((z) => {
            const live = state.zones.find((v) => v.id === z.id);
            return (
              <li key={z.id} style={{ '--heat': thermal(live?.target) }}>
                <span className="dot" />
                <span style={{ flex: 1 }}>{z.name}<br /><span className="sub">{z.trvs.length} radiator{z.trvs.length === 1 ? '' : 's'}{z.sensor ? ' and a thermometer' : ''}{z.enabled ? '' : ', not managed'}</span></span>
                <button className="btn" onClick={() => setEditing(z)}>Edit</button>
              </li>
            );
          })}
        </ul>
        <button className="btn primary" onClick={() => setEditing({})}>Add a room</button>
      </section>

      <section className="section">
        <h2>Boiler</h2>
        <p>When any room is below its target, the app fires the boiler. With a Hive thermostat it does this by turning the thermostat up, then back down when every room is warm.</p>
        <label className="field">
          <span>Boiler control</span>
          <select value={s.boiler.entity} onChange={(e) => setB({ entity: e.target.value })}>
            <option value="">None (only set radiators)</option>
            {boilerOptions.map((e) => <option key={e.entity_id} value={e.entity_id}>{e.name} ({e.entity_id})</option>)}
          </select>
        </label>
        {boilerIsClimate && (
          <div className="grid2">
            <label className="field"><span>Thermostat setting to fire</span><input type="number" step="0.5" value={s.boiler.onTemp} onChange={(e) => setB({ onTemp: numIn(e.target.value) })} /></label>
            <label className="field"><span>Thermostat setting to rest</span><input type="number" step="0.5" value={s.boiler.offTemp} onChange={(e) => setB({ offTemp: numIn(e.target.value) })} /></label>
          </div>
        )}
        <div className="grid2">
          <label className="field"><span>Run for at least (min)</span><input type="number" value={s.boiler.minOnMinutes} onChange={(e) => setB({ minOnMinutes: numIn(e.target.value) })} /></label>
          <label className="field"><span>Rest for at least (min)</span><input type="number" value={s.boiler.minOffMinutes} onChange={(e) => setB({ minOffMinutes: numIn(e.target.value) })} /></label>
        </div>
      </section>

      <section className="section">
        <h2>Temperatures</h2>
        <div className="grid2">
          <label className="field"><span>Away</span><input type="number" step="0.5" value={s.awayTemp} onChange={(e) => set({ awayTemp: numIn(e.target.value) })} /></label>
          <label className="field"><span>Frost protection</span><input type="number" step="0.5" value={s.frostTemp} onChange={(e) => set({ frostTemp: numIn(e.target.value) })} /></label>
          <label className="field"><span>Boost temperature</span><input type="number" step="0.5" value={s.houseBoostTemp ?? 22} onChange={(e) => set({ houseBoostTemp: numIn(e.target.value) })} /></label>
          <label className="field"><span>Boost length (min)</span><input type="number" step="5" value={s.houseBoostMinutes ?? 30} onChange={(e) => set({ houseBoostMinutes: numIn(e.target.value) })} /></label>
        </div>
        <small style={{ display: 'block', margin: '-6px 0 14px', color: 'var(--ink-2)', fontSize: '.84rem' }}>The Boost button starts with these. You can still change them each time.</small>
        <label className="field">
          <span>Start heating when a room is this far below target</span>
          <small>A small gap stops the boiler flicking on and off. 0.3° suits most homes.</small>
          <input type="number" step="0.1" value={s.hysteresis} onChange={(e) => set({ hysteresis: numIn(e.target.value) })} />
        </label>
        <label className="field">
          <span>Stop heating this far below target</span>
          <small>Used by rooms without their own setting (set one per room under Rooms → Edit). 0 stops exactly at target. If this is bigger than the start gap above, the start gap widens to keep 0.2° between them.</small>
          <input type="number" step="0.1" min="0" value={s.stopEarly ?? 0} onChange={(e) => set({ stopEarly: numIn(e.target.value) })} />
        </label>
      </section>

      <SmartSettings s={s} set={set} state={state} />

      <PhoneAlerts s={s} setNotify={setNotify} targets={targets} saveFirst={saveFirst} dirty={dirty} notify={notify} />

      <ChildLocks state={state} notify={notify} />

      <section className="section">
        <h2>Gas cost and outside temperature</h2>
        <p>Shown beside your rooms. Leave on "Find automatically" or pick the exact entities.</p>
        <label className="field">
          <span>Gas cost today</span>
          <small>A sensor that counts today's gas cost and resets at midnight, such as Octopus Energy's "Current Accumulative Cost Gas".</small>
          <select value={s.costEntity || ''} onChange={(e) => set({ costEntity: e.target.value })}>
            <option value="">Find automatically{!s.costEntity && state.extras?.cost ? ` (using ${nameOf(state.extras.cost.entity)})` : !s.costEntity ? ' (none found)' : ''}</option>
            {entities.filter((e) => e.kind === 'money').map((e) => <option key={e.entity_id} value={e.entity_id}>{e.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Outside temperature</span>
          <small>A weather entity or an outdoor thermometer.</small>
          <select value={s.outsideEntity || ''} onChange={(e) => set({ outsideEntity: e.target.value })}>
            <option value="">Find automatically{!s.outsideEntity && state.extras?.outside ? ` (using ${nameOf(state.extras.outside.entity)})` : !s.outsideEntity ? ' (none found)' : ''}</option>
            {entities.filter((e) => e.domain === 'weather').map((e) => <option key={e.entity_id} value={e.entity_id}>{e.name} (weather)</option>)}
            {entities.filter((e) => e.kind === 'temperature').map((e) => <option key={e.entity_id} value={e.entity_id}>{e.name}</option>)}
          </select>
        </label>
      </section>

      <section className="section">
        <h2>Room cards</h2>
        <label className="toggle">
          <input type="checkbox" checked={s.cards?.spark !== false} onChange={(e) => set({ cards: { ...s.cards, spark: e.target.checked } })} />
          <span>Today's mini graph<small>Each room's temperature since midnight, with orange shading where it was heating, above its schedule.</small></span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.cards?.fires !== false} onChange={(e) => set({ cards: { ...s.cards, fires: e.target.checked } })} />
          <span>Times fired today<small>How many times each room called for heat today, and for how long in total.</small></span>
        </label>
      </section>

      <HistorySettings s={s} set={set} />

      <section className="section">
        <h2>Behaviour</h2>
        <label className="toggle">
          <input type="checkbox" checked={s.respectManualChanges} onChange={(e) => set({ respectManualChanges: e.target.checked })} />
          <span>Keep changes made on a radiator<small>If someone turns a TRV or changes it in the Hive app, that room holds the new temperature until its next scheduled change.</small></span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.takeOverTrvMode} onChange={(e) => set({ takeOverTrvMode: e.target.checked })} />
          <span>Switch radiators to manual mode<small>Stops Hive’s own schedules overriding this app. Recommended.</small></span>
        </label>
        <label className="field" style={{ marginTop: 10 }}>
          <span>Wait before re-sending a command (seconds)</span>
          <small>Hive updates through the cloud, so changes take a minute or two to show. Zigbee valves answer almost instantly.</small>
          <input type="number" value={s.commandGraceSeconds} onChange={(e) => set({ commandGraceSeconds: numIn(e.target.value) })} />
        </label>
      </section>

      {dirty && (
        <div className="actions" style={{ position: 'sticky', bottom: 'calc(84px + env(safe-area-inset-bottom))', background: 'var(--bg)', padding: '10px 0' }}>
          <button className="btn" onClick={() => { setS(state.settings); setDirty(false); }}>Discard</button>
          <span className="spacer" />
          <button className="btn primary" onClick={save}>Save settings</button>
        </div>
      )}

      {editing && <RoomEditor room={editing} entities={entities} state={state} onClose={() => setEditing(null)} notify={notify} />}
    </>
  );
}
