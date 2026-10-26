import { useEffect, useMemo, useRef, useState } from 'react';
import { api, plural } from './lib.js';
import { Icon, Sheet, Toggle, Field, Notice, kindIcon } from './ui.jsx';
import { ScenesSettings } from './Scenes.jsx';
import { OldAppSettings } from './Import.jsx';
import { describeMonthDay } from '../../../server/src/lighting/schedule.js';
import { SettingsFrame, settingsPage } from '../SettingsFrame.jsx';
import { LEARN_OPTIONS, learnHelp } from '../Learn.jsx';

export function Settings({ state, run, go, old, arg }) {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { id?, preset? }
  const [form, setForm] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);
  const saveTimer = useRef(null);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const load = () => api('GET', 'config').then((c) => { setCfg(c); setForm((f) => f || { ...c.settings }); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // Away's evening is set under General → Away: keep the groups' "house setting" up to date
    window.addEventListener('home-changed', load);
    return () => window.removeEventListener('home-changed', load);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Open "new group" straight from links like #/lighting/settings/new
  useEffect(() => {
    if (arg === 'new' && cfg) { setEditing({}); go('settings', 'groups'); }
  }, [cfg, go, arg]);
  const { item, shown } = settingsPage('lighting', arg === 'new' ? 'groups' : arg);
  const show = (id) => shown === id;
  const status = savedMsg ? <><Icon name="check" size={16} />{savedMsg}</> : 'Changes save as you make them';

  if (!cfg || !form) {
    return (
      <SettingsFrame part="lighting" item={item} shown={shown}>
        {error ? <Notice tone="error">{error}</Notice> : <div className="loading" role="status">Loading settings</div>}
      </SettingsFrame>
    );
  }

  const usedAreas = new Set(cfg.groups.map((g) => g.name.toLowerCase()));
  const isFree = (id) => !cfg.candidates.devices.find((d) => d.id === id)?.group;
  const freeAreas = cfg.areas.filter((a) => !usedAreas.has(a.name.toLowerCase()) && a.devices.some(isFree))
    .map((a) => ({ ...a, free: a.devices.filter(isFree) }));
  // Settings save themselves shortly after each change, so nothing is lost by leaving the page.
  const set = (k, v) => {
    setForm((f) => {
      const next = { ...f, [k]: v };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveSettings(next), 900);
      return next;
    });
  };
  const saveSettings = async (values) => {
    try {
      const { awayOffTime, awayBrightness, ...rest } = values; // eslint-disable-line no-unused-vars -- set under General → Away
      await run(() => api('PUT', 'settings', rest));
      setSavedMsg('Saved');
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedMsg(null), 2500);
    } catch { /* shown by run */ }
  };
  const move = async (i, dir) => {
    const ids = cfg.groups.map((g) => g.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await run(() => api('POST', 'groups-order', { ids })).catch(() => {});
    load();
  };
  const sunName = cfg.candidates.suns.find((s) => s.id === cfg.sunFound)?.name;

  return (
    <SettingsFrame part="lighting" item={item} shown={shown} status={status}>
      {!cfg.connected && <Notice tone="warn">Not connected to Home Assistant, so the lists below may be empty. They fill in once it reconnects.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {show('groups') && <section className="card settings-section" aria-labelledby="set-groups">
        <div className="row-between">
          <h3 id="set-groups">Groups</h3>
          <button type="button" className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" size={18} />Add a group</button>
        </div>
        <p className="fine">A group is anything you want to control together: a room, the Christmas lights, the outside sockets. Each light or socket can be in one group.</p>
        {cfg.groups.length === 0 && <p className="fine">No groups yet.</p>}
        <ul className="group-list">
          {cfg.groups.map((g, i) => {
            const devs = g.devices.map((id) => cfg.candidates.devices.find((d) => d.id === id));
            const missing = devs.filter((d) => !d).length;
            const lights = devs.filter((d) => d?.kind === 'light').length;
            const sockets = devs.filter((d) => d && d.kind !== 'light').length;
            return (
              <li key={g.id}>
                <div className="group-li-text">
                  <strong>{g.name}</strong>
                  <span className="fine">
                    {[lights && plural(lights, 'light'), sockets && plural(sockets, 'socket')].filter(Boolean).join(' and ') || 'Nothing in it yet'}
                    {g.motion ? ', movement sensor' : ''}{g.lux ? ', light sensor' : ''}{g.livedIn ? `, looks lived in when away${g.away ? ` (${[g.away.offTime && `off around ${g.away.offTime}`, g.away.brightness != null && `${g.away.brightness}%`].filter(Boolean).join(', ')})` : ''}` : ''}{g.learn === 'auto' ? ', changes its schedule to match changes made by hand' : g.learn === 'off' ? ', no schedule suggestions' : ''}
                    {g.card === 'hide' ? ', hidden from the dashboard' : g.card === 'season' && g.season ? `, on the dashboard ${describeMonthDay(g.season.from)} to ${describeMonthDay(g.season.to)}` : ''}
                  </span>
                  {missing > 0 && <span className="warn-text"><Icon name="warn" size={14} /> {plural(missing, 'device')} no longer in Home Assistant</span>}
                </div>
                <div className="group-li-actions">
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${g.name} up`}><Icon name="up" /></button>
                  <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === cfg.groups.length - 1} aria-label={`Move ${g.name} down`}><Icon name="down" /></button>
                  <button type="button" className="btn btn-quiet" onClick={() => setEditing({ id: g.id })}>Edit</button>
                </div>
              </li>
            );
          })}
        </ul>
        {freeAreas.length > 0 && (
          <div className="areas">
            <h4>Start from your Home Assistant areas</h4>
            <div className="chips">
              {freeAreas.map((a) => (
                <button key={a.id} type="button" className="chip" onClick={() => setEditing({ preset: { name: a.name, devices: a.free } })}>
                  <Icon name="plus" size={16} />{a.name} ({a.free.length})
                </button>
              ))}
            </div>
          </div>
        )}
      </section>}

      {show('each') && (
        <section className="card settings-section" aria-labelledby="set-each">
          <h3 id="set-each">Each light and socket</h3>
          <p className="fine">Off, a group is one control: one power button and one brightness for everything in it. On, each light and socket in a group is listed under it too, with its own switch and, where it dims, its own brightness, so you can turn one off without the rest. A change to one lasts until the group's next scheduled change, like any other change made here. Groups with just one light or socket stay as they are.</p>
          <Toggle label="On the Lighting page" checked={!!form.showDevices?.page} onChange={(v) => set('showDevices', { ...form.showDevices, page: v })}
            description="Under each group's card, on the Lights page." />
          <Toggle label="On the dashboard card" checked={!!form.showDevices?.card} onChange={(v) => set('showDevices', { ...form.showDevices, card: v })}
            description="Under each group on the Home Control card (show: lighting). A card can choose for itself with devices: true or devices: false." />
          <p className="fine">Each light can also be switched from a group's details: tap its name on the Lights page.</p>
        </section>
      )}

      {show('scenes') && <ScenesSettings cfg={cfg} state={state} run={run} reload={load} form={form} set={set} />}

      {show('behaviour') && <section className="card settings-section" aria-labelledby="set-behave">
        <h3 id="set-behave">How it behaves</h3>
        <Toggle label="Notice changes made elsewhere" checked={form.detectManual} onChange={(v) => set('detectManual', v)}
          description="When someone uses a wall switch, the Home Assistant app or a voice assistant, leave that group alone until its next scheduled change. Turn off to put things straight back to the schedule." />
        <Field label="Brightness step for the minus and plus buttons" htmlFor="step">
          <select id="step" value={form.stepSize} onChange={(e) => set('stepSize', Number(e.target.value))}>
            {[5, 10, 20, 25].map((n) => <option key={n} value={n}>{n}%</option>)}
          </select>
        </Field>
        <Field label="Normal fade (seconds)" htmlFor="fade" help="How long lights take to change when a schedule doesn't set its own fade. 0 is instant.">
          <input id="fade" type="number" min="0" max="60" inputMode="numeric" value={form.defaultTransition} onChange={(e) => set('defaultTransition', e.target.value)} />
        </Field>
        <Field label="Wait after a command (seconds)" htmlFor="grace" help="Cloud lights and sockets can take a while to report back. During this wait the app won't resend or mistake late reports for someone using a switch.">
          <input id="grace" type="number" min="5" max="300" inputMode="numeric" value={form.graceSeconds} onChange={(e) => set('graceSeconds', e.target.value)} />
        </Field>
      </section>}

      {show('sun') && <section className="card settings-section" aria-labelledby="set-ha">
        <h3 id="set-ha">Sunrise and sunset</h3>
        <Field label="Sunrise and sunset from" htmlFor="sun" help="Used for changes set around sunset or sunrise. Without it, times are worked out from your home location.">
          <select id="sun" value={form.sunEntity} onChange={(e) => set('sunEntity', e.target.value)}>
            <option value="auto">{cfg.sunFound ? `Find automatically (using ${sunName || cfg.sunFound})` : 'Find automatically (none found, using your home location)'}</option>
            {cfg.candidates.suns.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
          </select>
        </Field>
      </section>}

      {show('start') && <OldAppSettings old={old} run={run} paused={!!state?.paused} />}

      {show('start') && <section className="card settings-section" aria-labelledby="set-tips">
        <h3 id="set-tips">Getting started</h3>
        <ol className="tips">
          <li>Turn off any Home Assistant automations that already switch these lights on a timer. Toggle them off rather than deleting them, so you can go back. Two schedules for the same light will fight.</li>
          <li>Changes at wall switches, in the Home Assistant app or by voice are respected until the next scheduled change.</li>
          <li>To open lighting straight from a dashboard, add a Button card:
            <pre>{`type: button
name: Lighting
icon: mdi:lightbulb-group
tap_action:
  action: navigate
  navigation_path: ${state?.house?.panel || '/local_heating_control'}?section=lighting`}</pre>
          </li>
        </ol>
      </section>}

      {editing && (
        <GroupEditor cfg={cfg} editing={editing} run={run}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </SettingsFrame>
  );
}

// ---------- add or edit a group ----------

function GroupEditor({ cfg, editing, run, onClose, onSaved }) {
  const existing = editing.id ? cfg.groups.find((g) => g.id === editing.id) : null;
  const start = existing || editing.preset || {};
  const [name, setName] = useState(start.name || '');
  const [devices, setDevices] = useState(start.devices || []);
  const [motion, setMotion] = useState(existing?.motion || { entity: '', minutes: 5, brightness: 80 });
  const [night, setNight] = useState(existing?.motion?.night || null);
  const [season, setSeason] = useState(existing?.season || null);
  const [lux, setLux] = useState(existing?.lux || { entity: '', threshold: 50 });
  const [livedIn, setLivedIn] = useState(!!existing?.livedIn);
  // its own Away evening, or the house's (General → Away)
  const houseAway = { offTime: cfg.settings?.awayOffTime || '23:00', brightness: cfg.settings?.awayBrightness ?? 70 };
  const [awayOwn, setAwayOwn] = useState(!!existing?.away);
  const [awayOff, setAwayOff] = useState(existing?.away?.offTime || houseAway.offTime);
  const [awayBri, setAwayBri] = useState(existing?.away?.brightness ?? houseAway.brightness);
  const [card, setCard] = useState(existing?.card || 'show');
  const [learn, setLearn] = useState(existing?.learn || 'suggest');
  const [onBrightness, setOnBrightness] = useState(existing?.onBrightness ?? 100);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const groupName = (id) => cfg.groups.find((g) => g.id === id)?.name;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cfg.candidates.devices.filter((d) => {
      if (devices.includes(d.id)) return true;
      if (q) return d.name.toLowerCase().includes(q) || d.id.includes(q) || (d.area || '').toLowerCase().includes(q);
      if (!showAll && d.hidden) return false;
      return true;
    });
  }, [cfg, query, devices, showAll]);

  const byArea = [];
  const picked = list.filter((d) => devices.includes(d.id));
  if (picked.length) byArea.push({ area: 'In this group', items: picked });
  for (const d of list.filter((x) => !devices.includes(x.id))) {
    const a = d.area || 'No area';
    if (byArea[byArea.length - 1]?.area !== a) byArea.push({ area: a, items: [] });
    byArea[byArea.length - 1].items.push(d);
  }
  const missing = devices.filter((id) => !cfg.candidates.devices.some((d) => d.id === id));
  const moving = devices.map((id) => cfg.candidates.devices.find((d) => d.id === id)).filter((d) => d?.group && d.group !== existing?.id);

  const toggle = (id) => setDevices((ds) => (ds.includes(id) ? ds.filter((x) => x !== id) : [...ds, id]));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { name, devices, motion: motion.entity ? { ...motion, night } : null, lux: lux.entity ? lux : null, livedIn, away: awayOwn ? { offTime: awayOff, brightness: awayBri } : null, onBrightness, season, card: card === 'season' && !season ? 'show' : card, learn };
      await run(() => (existing ? api('PUT', `groups/${existing.id}`, body) : api('POST', 'groups', body)));
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await run(() => api('DELETE', `groups/${existing.id}`)); onSaved(); } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <Sheet wide title={existing ? `Edit ${existing.name}` : 'Add a group'} onClose={onClose}
      footer={<>
        {existing && !confirmDelete && <button type="button" className="btn btn-danger-quiet" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={18} />Remove group</button>}
        {confirmDelete && <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>Yes, remove {existing.name}</button>}
        <span className="spacer" />
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>{existing ? 'Save' : 'Add group'}</button>
      </>}>
      {confirmDelete && <Notice tone="warn">Removing {existing.name} deletes its schedule. Its lights and sockets stay as they are and are no longer controlled by this app.</Notice>}
      <Field label="Name" htmlFor="gname">
        <input id="gname" type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Lounge or Christmas lights" data-autofocus />
      </Field>

      <section className="sheet-section">
        <div className="row-between">
          <h3>Lights and sockets <span className="fine">({devices.length} picked)</span></h3>
        </div>
        <div className="search">
          <Icon name="search" size={18} />
          <label className="sr-only" htmlFor="devsearch">Search lights and sockets</label>
          <input id="devsearch" type="search" placeholder="Search by name or area" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {cfg.candidates.devices.length === 0 && <p className="fine">No lights or sockets found in Home Assistant.</p>}
        {missing.length > 0 && (
          <Notice tone="warn">
            {plural(missing.length, 'device')} in this group can't be found in Home Assistant ({missing.join(', ')}). Untick to remove.
            <div className="chips">{missing.map((id) => <button key={id} type="button" className="chip chip-on" onClick={() => toggle(id)}>{id}</button>)}</div>
          </Notice>
        )}
        <div className="dev-picker">
          {byArea.map((a) => (
            <fieldset key={a.area}>
              <legend>{a.area}</legend>
              {a.items.map((d) => {
                const other = d.group && d.group !== existing?.id ? groupName(d.group) : null;
                return (
                  <label key={d.id} className="pick">
                    <input type="checkbox" checked={devices.includes(d.id)} onChange={() => toggle(d.id)} />
                    <Icon name={kindIcon(d.kind)} size={18} />
                    <span className="pick-name">{d.name}
                      <span className="fine">
                        {d.kind === 'light' ? (d.ct ? 'Dims, warmth' : d.dimmable ? 'Dims' : 'On and off') : 'Socket, on and off'}
                        {other ? `, in ${other}` : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
        {!showAll && cfg.candidates.devices.some((d) => d.hidden) && !query && (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setShowAll(true)}>Show hidden entities too</button>
        )}
        {moving.length > 0 && <p className="fine">{moving.map((d) => d.name).join(', ')} will move out of {[...new Set(moving.map((d) => groupName(d.group)))].join(' and ')}.</p>}
      </section>

      {devices.some((id) => cfg.candidates.devices.find((d) => d.id === id)?.dimmable) && (
        <section className="sheet-section">
          <h3>Turning on</h3>
          <p className="fine">The power button turns lights on at the level this group's schedule uses at that time of day: last evening's level late at night, or the morning level once it's due within the hour.</p>
          <Field label="Without a schedule, turn on at (%)" htmlFor="onbri">
            <input id="onbri" type="number" min="1" max="100" inputMode="numeric" value={onBrightness} onChange={(e) => setOnBrightness(e.target.value)} />
          </Field>
        </section>
      )}

      <section className="sheet-section">
        <h3>Movement</h3>
        <Field label="Movement sensor" htmlFor="motion" help="Turns the group on when there's movement and it would otherwise be off. Only in Schedules mode.">
          <select id="motion" value={motion.entity} onChange={(e) => setMotion({ ...motion, entity: e.target.value })}>
            <option value="">None</option>
            {cfg.candidates.motion.map((m) => <option key={m.id} value={m.id}>{m.name}{m.area ? ` (${m.area})` : ''}</option>)}
          </select>
        </Field>
        {cfg.candidates.motion.length === 0 && <p className="fine">No movement sensors found in Home Assistant.</p>}
        {motion.entity && (
          <div className="field-pair">
            <Field label="Stay on for (minutes)" htmlFor="mmin">
              <input id="mmin" type="number" min="1" max="120" inputMode="numeric" value={motion.minutes} onChange={(e) => setMotion({ ...motion, minutes: e.target.value })} />
            </Field>
            <Field label="Brightness (%)" htmlFor="mbri">
              <input id="mbri" type="number" min="1" max="100" inputMode="numeric" value={motion.brightness} onChange={(e) => setMotion({ ...motion, brightness: e.target.value })} />
            </Field>
          </div>
        )}
        {motion.entity && (
          <>
            <Toggle label="Use a lower level at night" checked={!!night}
              onChange={(v) => setNight(v ? { brightness: 5, from: '23:00', to: '06:00' } : null)}
              description="So a trip to the loo in the night doesn't light up the whole house." />
            {night && (
              <div className="field-pair">
                <Field label="Night brightness (%)" htmlFor="nbri">
                  <input id="nbri" type="number" min="1" max="100" inputMode="numeric" value={night.brightness} onChange={(e) => setNight({ ...night, brightness: e.target.value })} />
                </Field>
                <Field label="From" htmlFor="nfrom">
                  <input id="nfrom" type="time" value={night.from} onChange={(e) => setNight({ ...night, from: e.target.value })} />
                </Field>
                <Field label="Until" htmlFor="nto">
                  <input id="nto" type="time" value={night.to} onChange={(e) => setNight({ ...night, to: e.target.value })} />
                </Field>
              </div>
            )}
          </>
        )}
      </section>

      <section className="sheet-section">
        <h3>Season</h3>
        <Toggle label="Only run the schedule between two dates" checked={!!season}
          onChange={(v) => setSeason(v ? { from: '12-01', to: '01-06' } : null)}
          description="Outside these dates the schedule sleeps and the group is left alone. Good for Christmas lights or garden lights in summer. It comes back every year by itself." />
        {season && (
          <div className="field-pair">
            <MonthDay label="From" id="sfrom" value={season.from} onChange={(v) => setSeason({ ...season, from: v })} />
            <MonthDay label="Until (inclusive)" id="sto" value={season.to} onChange={(v) => setSeason({ ...season, to: v })} />
          </div>
        )}
        {season && <p className="fine">Runs {describeMonthDay(season.from)} to {describeMonthDay(season.to)} every year.</p>}
      </section>

      <section className="sheet-section">
        <h3>Dashboard</h3>
        <Field label="On the Home Control card" htmlFor="gcard" help="Hidden groups still follow their schedules and are all here in the app; they're just left off the dashboard card.">
          <select id="gcard" value={card === 'season' && !season ? 'show' : card} onChange={(e) => setCard(e.target.value)}>
            <option value="show">Show</option>
            {season && <option value="season">Show only in its season</option>}
            <option value="hide">Hide</option>
          </select>
        </Field>
        {!season && <p className="fine">To show it only part of the year, set its season above.</p>}
      </section>

      <section className="sheet-section">
        <h3>Daylight</h3>
        <Field label="Light level sensor" htmlFor="lux" help="Stops the group switching on when it's already bright. Lights that are already on stay on.">
          <select id="lux" value={lux.entity} onChange={(e) => setLux({ ...lux, entity: e.target.value })}>
            <option value="">None</option>
            {cfg.candidates.lux.map((m) => <option key={m.id} value={m.id}>{m.name}{m.area ? ` (${m.area})` : ''}</option>)}
          </select>
        </Field>
        {lux.entity && (
          <Field label="Don't switch on above (lx)" htmlFor="luxt">
            <input id="luxt" type="number" min="0" max="100000" inputMode="numeric" value={lux.threshold} onChange={(e) => setLux({ ...lux, threshold: e.target.value })} />
          </Field>
        )}
      </section>

      <section className="sheet-section">
        <h3>Changes made by hand</h3>
        <Field label="When the same change keeps being made" htmlFor="glearn" help={learnHelp(learn, 'group')}>
          <select id="glearn" value={learn} onChange={(e) => setLearn(e.target.value)}>
            {LEARN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </section>

      <section className="sheet-section">
        <h3>While away</h3>
        <Toggle label="Look lived in" checked={livedIn} onChange={setLivedIn}
          description="Comes on a little after sunset and goes off in the evening, a bit differently each day. Otherwise it stays off while the house is on Away." />
        {livedIn && (
          <>
            <Field label="Evening" htmlFor="gaway" help={awayOwn ? 'Varies by up to 20 minutes each day.' : <>Change the house setting in <a href="#/lighting/settings/presence">General → Away</a>.</>}>
              <select id="gaway" value={awayOwn ? 'own' : 'house'} onChange={(e) => setAwayOwn(e.target.value === 'own')}>
                <option value="house">House setting: off around {houseAway.offTime}, at {houseAway.brightness}%</option>
                <option value="own">Its own</option>
              </select>
            </Field>
            {awayOwn && (
              <div className="field-pair">
                <Field label="Go off around" htmlFor="gawayoff">
                  <input id="gawayoff" type="time" value={awayOff} onChange={(e) => setAwayOff(e.target.value)} />
                </Field>
                <Field label="Brightness (%)" htmlFor="gawaybri">
                  <input id="gawaybri" type="number" min="1" max="100" inputMode="numeric" value={awayBri} onChange={(e) => setAwayBri(e.target.value)} />
                </Field>
              </div>
            )}
          </>
        )}
      </section>
      {err && <Notice tone="error">{err}</Notice>}
    </Sheet>
  );
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function MonthDay({ label, id, value, onChange }) {
  const [m, d] = value.split('-').map(Number);
  const emit = (mm, dd) => onChange(`${String(mm).padStart(2, '0')}-${String(Math.min(dd, DAYS_IN[mm - 1])).padStart(2, '0')}`);
  return (
    <fieldset className="monthday">
      <legend>{label}</legend>
      <label className="sr-only" htmlFor={`${id}-d`}>{label} day</label>
      <select id={`${id}-d`} value={d} onChange={(e) => emit(m, Number(e.target.value))}>
        {Array.from({ length: DAYS_IN[m - 1] }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <label className="sr-only" htmlFor={`${id}-m`}>{label} month</label>
      <select id={`${id}-m`} value={m} onChange={(e) => emit(Number(e.target.value), d)}>
        {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
      </select>
    </fieldset>
  );
}
