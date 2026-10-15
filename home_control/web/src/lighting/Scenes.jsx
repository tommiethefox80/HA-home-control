import { useState } from 'react';
import { api, lightCss, warmthWord, plural } from './lib.js';
import { Icon, Sheet, Segmented, Slider, Field, Notice, brightnessTrack, warmthTrack } from './ui.jsx';

// ---------- the row of scene buttons on the Lights page ----------

export function SceneRow({ state, run }) {
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(null);
  const go = async (sc) => {
    setBusy(sc.id);
    try {
      const r = await run(() => api('POST', `scenes/${sc.id}/run`));
      setDone(sc.id === 'all-off' ? 'Everything is off until its next scheduled change' : `${sc.name}: ${plural(r?.changed ?? 0, 'group')} set`);
      setTimeout(() => setDone(null), 4000);
    } catch { /* shown at the top */ }
    setBusy(null);
  };
  return (
    <section className="scenes" aria-label="Scenes">
      <div className="scene-buttons">
        <button type="button" className="btn btn-quiet scene-btn" onClick={() => go({ id: 'all-off', name: 'All off' })} disabled={busy === 'all-off'}>
          <Icon name="power" size={18} />All off
        </button>
        {(state.scenes || []).map((sc) => (
          <button key={sc.id} type="button" className="btn btn-quiet scene-btn" onClick={() => go(sc)} disabled={busy === sc.id}>
            <Icon name={/goodnight|bed|sleep/i.test(sc.name) ? 'moon' : 'bulb'} size={18} />{sc.name}
          </button>
        ))}
      </div>
      <span className="scene-done" role="status">{done}</span>
    </section>
  );
}

// ---------- Settings: scenes ----------

export function ScenesSettings({ cfg, state, run, reload, form, set }) {
  const [editing, setEditing] = useState(null);
  return (
    <section className="card settings-section" aria-labelledby="set-scenes">
      <div className="row-between">
        <h3 id="set-scenes">Scenes</h3>
        <button type="button" className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" size={18} />Add a scene</button>
      </div>
      <p className="fine">One button that sets several groups at once, such as Film night or Goodnight. Scenes show as buttons at the top of the Lights page.</p>
      <ul className="group-list">
        {cfg.scenes.map((sc) => (
          <li key={sc.id}>
            <div className="group-li-text">
              <strong>{sc.name}</strong>
              <span className="fine">{sceneSummary(sc, cfg.groups)}</span>
            </div>
            <div className="group-li-actions"><button type="button" className="btn btn-quiet" onClick={() => setEditing({ id: sc.id })}>Edit</button></div>
          </li>
        ))}
      </ul>
      <Field label='"Until the morning" ends at the first scheduled change after' htmlFor="morning">
        <input id="morning" type="time" value={form.morningTime} onChange={(e) => set('morningTime', e.target.value)} />
      </Field>
      <details className="ha-help">
        <summary>Run a scene from Home Assistant, a dashboard or Alexa</summary>
        <p className="fine">Make a script in Home Assistant (Settings, Automations and scenes, Scripts) and switch it to YAML. Scripts can be put on a dashboard or shared with Alexa.</p>
        <pre>{`alias: Goodnight
sequence:
  - event: lighting_control_scene
    event_data:
      scene: Goodnight`}</pre>
        <p className="fine">Use <code>scene: All off</code> to switch everything off. Change the mode the same way with <code>lighting_control_mode</code> and <code>mode: away</code> or <code>schedules</code>.</p>
      </details>
      {editing && (
        <SceneEditor cfg={cfg} state={state} editing={editing} run={run}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </section>
  );
}

function sceneSummary(sc, groups) {
  const on = []; const off = [];
  for (const g of groups) {
    const e = sc.groups?.[g.id] ?? { action: sc.others === 'off' ? 'off' : 'leave' };
    if (e.action === 'on') on.push(e.brightness ? `${g.name} ${e.brightness}%` : g.name);
    if (e.action === 'off') off.push(g.name);
  }
  const parts = [];
  if (on.length) parts.push(`On: ${on.join(', ')}`);
  if (off.length) parts.push(off.length === groups.length ? 'Everything off' : `Off: ${off.join(', ')}`);
  parts.push(sc.until === 'morning' ? 'Until the morning' : 'Until the next scheduled change');
  return `${parts.join('. ')}.`;
}

const FOR = [
  { value: '', label: 'Until the scene ends' },
  { value: 5, label: 'For 5 min' },
  { value: 10, label: 'For 10 min' },
  { value: 15, label: 'For 15 min' },
  { value: 30, label: 'For 30 min' },
  { value: 60, label: 'For 1 hour' },
];

function SceneEditor({ cfg, state, editing, run, onClose, onSaved }) {
  const existing = editing.id ? cfg.scenes.find((x) => x.id === editing.id) : null;
  const [name, setName] = useState(existing?.name || '');
  const [until, setUntil] = useState(existing?.until || 'next');
  const [others, setOthers] = useState(existing?.others || 'leave');
  const [entries, setEntries] = useState(() => ({ ...(existing?.groups || {}) }));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const live = Object.fromEntries((state?.groups || []).map((g) => [g.id, g]));

  const entry = (gid) => entries[gid] ?? { action: others === 'off' ? 'off' : 'leave' };
  const setEntry = (gid, patch) => setEntries((e) => ({ ...e, [gid]: { ...entry(gid), ...patch } }));
  const captureNow = () => {
    const next = {};
    for (const g of cfg.groups) {
      const c = live[g.id]?.current;
      if (!c) continue;
      next[g.id] = c.onCount > 0
        ? { action: 'on', brightness: live[g.id].dimmable ? c.brightness : null, kelvin: live[g.id].ct ? c.kelvin : null }
        : { action: 'off' };
    }
    setEntries(next);
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const groups = {};
      for (const g of cfg.groups) groups[g.id] = entry(g.id);
      const body = { name, until, others, groups };
      await run(() => (existing ? api('PUT', `scenes/${existing.id}`, body) : api('POST', 'scenes', body)));
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await run(() => api('DELETE', `scenes/${existing.id}`)); onSaved(); } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <Sheet wide title={existing ? `Edit ${existing.name}` : 'Add a scene'} onClose={onClose}
      footer={<>
        {existing && !confirmDelete && <button type="button" className="btn btn-danger-quiet" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={18} />Remove scene</button>}
        {confirmDelete && <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>Yes, remove {existing.name}</button>}
        <span className="spacer" />
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>{existing ? 'Save' : 'Add scene'}</button>
      </>}>
      <Field label="Name" htmlFor="scname">
        <input id="scname" type="text" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Film night" data-autofocus />
      </Field>
      <div className="field">
        <span className="field-label">Keep it until</span>
        <Segmented label="Keep it until" value={until} onChange={setUntil}
          options={[{ value: 'next', label: 'Next scheduled change' }, { value: 'morning', label: 'The morning' }]} />
        <p className="field-help">{until === 'morning' ? 'Schedules take over again with the first change after the morning, so nothing comes back on in the night.' : 'Each group goes back to its schedule at its next scheduled change.'}</p>
      </div>

      <section className="sheet-section">
        <div className="row-between">
          <h3>Groups</h3>
          <button type="button" className="btn btn-quiet btn-small" onClick={captureNow}>Copy how things are now</button>
        </div>
        <div className="field">
          <span className="field-label">Groups added later</span>
          <Segmented label="Groups added later" value={others} onChange={setOthers}
            options={[{ value: 'leave', label: 'Leave alone' }, { value: 'off', label: 'Turn off' }]} />
        </div>
        <ul className="scene-groups">
          {cfg.groups.map((g) => {
            const e = entry(g.id);
            const lg = live[g.id] || {};
            return (
              <li key={g.id} className="scene-group" style={{ '--light': e.action === 'on' ? lightCss(true, e.brightness ?? 100, e.kelvin) : e.action === 'off' ? 'var(--off)' : 'transparent' }}>
                <div className="row-between">
                  <strong>{g.name}</strong>
                  <Segmented label={g.name} value={e.action} onChange={(v) => setEntry(g.id, { action: v, ...(v === 'on' && lg.dimmable && !e.brightness ? { brightness: 50 } : {}) })}
                    options={[{ value: 'leave', label: 'Leave' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
                </div>
                {e.action === 'on' && lg.dimmable && (
                  <Slider label="Brightness" min={1} max={100} value={e.brightness ?? 50} format={(v) => `${v}%`} track={brightnessTrack(e.kelvin)}
                    onChange={(v) => setEntry(g.id, { brightness: v })} />
                )}
                {e.action === 'on' && lg.ct && (e.kelvin
                  ? (
                    <div className="kelvin-row">
                      <Slider label="Warmth" min={2000} max={6500} step={50} value={e.kelvin} format={(v) => `${warmthWord(v)}, ${v} K`} track={warmthTrack()}
                        onChange={(v) => setEntry(g.id, { kelvin: v })} />
                      <button type="button" className="btn btn-quiet btn-small" onClick={() => setEntry(g.id, { kelvin: null })}>Leave warmth as it is</button>
                    </div>
                  )
                  : <button type="button" className="btn btn-quiet btn-small" onClick={() => setEntry(g.id, { kelvin: 2700 })}>Set warmth too</button>)}
                {e.action !== 'leave' && (
                  <div className="point-fade">
                    <label htmlFor={`for-${g.id}`}>How long</label>
                    <select id={`for-${g.id}`} value={e.minutes ?? ''} onChange={(ev) => setEntry(g.id, { minutes: ev.target.value === '' ? null : Number(ev.target.value) })}>
                      {FOR.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                    {e.minutes ? <span className="fine">Then back to its schedule.</span> : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!cfg.groups.length && <p className="fine">Add some groups first.</p>}
      </section>
      {confirmDelete && <Notice tone="warn">Removing {existing.name} doesn't change any lights.</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
    </Sheet>
  );
}
