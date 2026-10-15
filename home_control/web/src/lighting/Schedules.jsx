import { useEffect, useMemo, useRef, useState } from 'react';
import { api, levelText, lightCss, plural, store, warmthWord } from './lib.js';
import { Icon, Ribbon, Sheet, Chips, Segmented, Slider, Notice, brightnessTrack, warmthTrack } from './ui.jsx';
import {
  DAY_NAMES, DAY_SHORT, addDays, startOfWeek, daySegments, normalizeDay, suggestNewTime, describeWhen, emptyWeek,
  timeToMinutes, pointMinute,
} from '../../../server/src/lighting/schedule.js';

export function Schedules({ state, run, go, groupId }) {
  const [schedules, setSchedules] = useState(null);
  const [error, setError] = useState(null);
  const [editDay, setEditDay] = useState(null);
  const [copying, setCopying] = useState(false);

  const load = () => api('GET', 'schedules').then((d) => { setSchedules(d.schedules); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (!state) return <div className="loading" role="status">Loading schedules</div>;
  const groups = state.groups;
  if (!groups.length) {
    return (
      <section className="empty card">
        <h2>Nothing to schedule yet</h2>
        <p>Add a group of lights or sockets first.</p>
        <a className="btn btn-primary" href="#/lighting/settings/new">Add a group</a>
      </section>
    );
  }
  const saved = store.get('scheduleGroup');
  const gid = groups.some((g) => g.id === groupId) ? groupId : groups.some((g) => g.id === saved) ? saved : groups[0].id;
  const g = groups.find((x) => x.id === gid);
  const week = schedules?.[gid] || emptyWeek();
  const ctx = state.ctx;
  const ws = startOfWeek(state.now, ctx.tz);
  const todayDow = state.today.dow;
  const total = Object.values(week).reduce((n, d) => n + d.length, 0);

  return (
    <>
      <div className="page-head">
        <h2>Schedules</h2>
        <Chips label="Group" value={gid} onChange={(v) => { store.set('scheduleGroup', v); go('schedules', v); }}
          options={groups.map((x) => ({ value: x.id, label: x.name }))} />
      </div>
      {state.mode !== 'schedule' && (
        <Notice tone="warn">{state.mode === 'away' ? 'Away is on' : 'All off is on'}, so schedules aren't running right now. You can still edit them.</Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {g.season && (
        <Notice tone={g.season.active ? 'info' : 'warn'}>
          {g.name}'s schedule runs {g.season.text} each year.{g.season.active ? '' : ' It\'s sleeping now, so the group is left alone.'} Change the dates in Settings.
        </Notice>
      )}

      <section className="card week" aria-label={`${g.name} week`}>
        <div className="row-between">
          <h3>{g.name}</h3>
          <span className="fine">{total ? plural(total, 'change') + ' this week' : 'No schedule yet'}</span>
        </div>
        {!total && <p className="fine">Tap a day to add the first change. Without a schedule, the app leaves this group alone.</p>}
        <ol className="days">
          {DAY_NAMES.map((name, d) => {
            const date = addDays(ws, d);
            const segs = daySegments(week, date, ctx);
            const pts = week[d] || [];
            return (
              <li key={d}>
                <button type="button" className={`day ${d === todayDow ? 'day-today' : ''}`} onClick={() => setEditDay(d)}
                  aria-label={`${name}: ${pts.length ? pts.map((p) => `${describeWhen(p)} ${levelText(p, g.dimmable)}`).join(', ') : 'no changes'}. Edit`}>
                  <span className="day-name">{DAY_SHORT[d]}</span>
                  <span className="day-ribbon"><Ribbon segments={segs} nowMin={d === todayDow ? state.today.minutes : null} height={14} label=" " /></span>
                  <span className="day-sum">{pts.length ? pts.map((p) => `${describeWhen(p)} ${levelText(p, g.dimmable).toLowerCase()}`).join(', ') : 'No changes'}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="ribbon-ticks-row" aria-hidden="true"><span />
          <span className="ticks-only">{[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h % 24).padStart(2, '0')}</span>)}</span>
        </div>
        {groups.length > 1 && total > 0 && (
          <button type="button" className="btn btn-quiet" onClick={() => setCopying(true)}><Icon name="copy" size={18} />Copy this week to other groups</button>
        )}
      </section>

      {editDay != null && schedules && (
        <DayEditor key={`${gid}-${editDay}`} g={g} groups={groups} day={editDay} schedules={schedules} state={state}
          onClose={() => setEditDay(null)}
          onSaved={(s) => { setSchedules(s); setEditDay(null); }} run={run} />
      )}
      {copying && (
        <CopySheet g={g} groups={groups} onClose={() => setCopying(false)} run={run}
          onDone={(s) => { setSchedules(s); setCopying(false); }} />
      )}
    </>
  );
}

// ---------- day editor ----------

const FADES = [
  { value: '', label: 'Quick' },
  { value: 10, label: 'Over 10 s' },
  { value: 30, label: 'Over 30 s' },
  { value: 60, label: 'Over 1 min' },
  { value: 300, label: 'Over 5 min' },
  { value: 900, label: 'Over 15 min' },
  { value: 1800, label: 'Over 30 min' },
];
const OFFSETS = [-120, -90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90, 120];
let keySeq = 1;

function DayEditor({ g, groups, day, schedules, state, onClose, onSaved, run }) {
  const ctx = state.ctx;
  const ws = startOfWeek(state.now, ctx.tz);
  const date = addDays(ws, day);
  // Changes are kept in time order. Sun-relative ones use this day's actual sunrise or sunset.
  const minuteOf = (p) => (p.time ? timeToMinutes(p.time) ?? Infinity : pointMinute(p, date, ctx) ?? (p.anchor === 'sunrise' ? 420 : 1080) + (p.offset || 0));
  const inOrder = (ps) => [...ps].sort((a, b) => minuteOf(a) - minuteOf(b));
  const [points, setPoints] = useState(() => inOrder((schedules[g.id]?.[day] || []).map((p) => ({ ...p, key: keySeq++ }))));
  const [days, setDays] = useState([day]);
  const [also, setAlso] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [moved, setMoved] = useState(null); // briefly highlight a change that has just moved or been added
  const listRef = useRef(null);
  const flash = (key, focusTime = false) => {
    setMoved(key);
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-point="${key}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      if (focusTime) el?.querySelector('input[type="time"]')?.focus({ preventScroll: true });
    });
    clearTimeout(flash.t);
    flash.t = setTimeout(() => setMoved(null), 1400);
  };
  /** Put the list back in time order, and point out the change if it moved. */
  const reorder = (key) => setPoints((ps) => {
    const next = inOrder(ps);
    if (key != null && next.findIndex((p) => p.key === key) !== ps.findIndex((p) => p.key === key)) flash(key);
    return next;
  });
  const others = groups.filter((x) => x.id !== g.id);
  const dimmable = g.dimmable || also.some((id) => groups.find((x) => x.id === id)?.dimmable);
  const ct = g.ct || also.some((id) => groups.find((x) => x.id === id)?.ct);

  const update = (key, patch) => setPoints((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const add = () => {
    const time = suggestNewTime(points);
    const last = points[points.length - 1];
    const key = keySeq++;
    setPoints((ps) => inOrder([...ps, { key, time, on: !(last?.on ?? false), brightness: last?.on ? null : (dimmable ? 80 : null), kelvin: null, fade: null }]));
    flash(key, true);
  };

  const preview = useMemo(() => {
    const w = { ...(schedules[g.id] || emptyWeek()), [day]: normalizeDay(points) };
    return daySegments(w, addDays(ws, day), ctx);
  }, [points, schedules, g.id, day, ws, ctx]);

  const setPreset = (preset) => {
    if (preset === 'weekdays') setDays([...new Set([day, 0, 1, 2, 3, 4])]);
    if (preset === 'weekend') setDays([...new Set([day, 5, 6])]);
    if (preset === 'all') setDays([0, 1, 2, 3, 4, 5, 6]);
  };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const clean = normalizeDay(points);
      let latest = schedules;
      for (const id of [g.id, ...also]) {
        const week = { ...(latest[id] || emptyWeek()) };
        for (const d of days) week[d] = clean;
        const res = await run(() => api('PUT', `schedules/${id}`, { week }));
        latest = res.schedules;
      }
      onSaved(latest);
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  };

  const otherDays = days.filter((d) => d !== day);
  const saveLabel = also.length || otherDays.length
    ? `Save for ${plural(days.length, 'day')}${also.length ? ` in ${plural(also.length + 1, 'group')}` : ''}`
    : 'Save';

  return (
    <Sheet wide title={`${g.name}, ${DAY_NAMES[day]}`} subtitle="Each change lasts until the next one." onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving' : saveLabel}</button>
      </>}>
      <div className="preview">
        <span className="field-label">Preview</span>
        <Ribbon segments={preview} height={16} ticks dimmable={dimmable} />
      </div>

      {!points.length && <p className="fine">No changes on this day, so whatever was set the day before carries on.</p>}
      <ol className="points" ref={listRef}>
        {points.map((p, i) => (
          <PointRow key={p.key} p={p} index={i} dimmable={dimmable} ct={ct} g={g} flash={moved === p.key}
            onChange={(patch) => update(p.key, patch)}
            onTimeDone={() => reorder(p.key)}
            onRemove={() => setPoints((ps) => ps.filter((x) => x.key !== p.key))} />
        ))}
      </ol>
      <button type="button" className="btn btn-quiet add-btn" onClick={add} disabled={points.length >= 24}><Icon name="plus" size={18} />Add a change</button>

      <section className="sheet-section">
        <h3>Also use for</h3>
        <div className="chips">
          <button type="button" className="chip" onClick={() => setPreset('weekdays')}>Weekdays</button>
          <button type="button" className="chip" onClick={() => setPreset('weekend')}>Weekend</button>
          <button type="button" className="chip" onClick={() => setPreset('all')}>Every day</button>
        </div>
        <Chips multi small label="Days" value={days} onChange={(v) => setDays(v.includes(day) ? v : [day, ...v])}
          options={DAY_SHORT.map((n, d) => ({ value: d, label: n, disabled: d === day }))} />
      </section>

      {others.length > 0 && (
        <section className="sheet-section">
          <h3>Also use in</h3>
          <div className="chips">
            <button type="button" className="chip" onClick={() => setAlso(also.length === others.length ? [] : others.map((x) => x.id))}>
              {also.length === others.length ? 'None' : 'All groups'}
            </button>
          </div>
          <Chips multi small label="Other groups" value={also} onChange={setAlso} options={others.map((x) => ({ value: x.id, label: x.name }))} />
          {also.length > 0 && <p className="fine">Replaces {days.length === 1 ? DAY_NAMES[day] : 'these days'} in {plural(also.length, 'other group')}.</p>}
        </section>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </Sheet>
  );
}

function PointRow({ p, index, dimmable, ct, flash, onChange, onTimeDone, onRemove }) {
  const when = p.anchor || 'time';
  const id = `pt-${p.key}`;
  // Picking from a list is finished straight away; a typed time is finished when you leave the field.
  const pick = (patch) => { onChange(patch); setTimeout(onTimeDone, 0); };
  return (
    <li className={`point ${flash ? 'point-flash' : ''}`} data-point={p.key} style={{ '--light': lightCss(p.on, p.brightness ?? 100, p.kelvin) }}>
      <div className="point-row">
        <div className="point-when">
          <label className="sr-only" htmlFor={`${id}-mode`}>When change {index + 1} happens</label>
          <select id={`${id}-mode`} value={when} onChange={(e) => {
            const v = e.target.value;
            if (v === 'time') pick({ anchor: undefined, offset: undefined, time: p.time || '18:00' });
            else pick({ anchor: v, offset: p.offset ?? 0, time: undefined });
          }}>
            <option value="time">At</option>
            <option value="sunset">Around sunset</option>
            <option value="sunrise">Around sunrise</option>
          </select>
          {when === 'time' ? (
            <>
              <label className="sr-only" htmlFor={`${id}-time`}>Time</label>
              <input id={`${id}-time`} type="time" value={p.time || ''} step="60" onChange={(e) => onChange({ time: e.target.value })} onBlur={onTimeDone} required />
            </>
          ) : (
            <>
              <label className="sr-only" htmlFor={`${id}-off`}>Offset</label>
              <select id={`${id}-off`} value={p.offset ?? 0} onChange={(e) => pick({ offset: Number(e.target.value) })}>
                {OFFSETS.map((o) => <option key={o} value={o}>{o === 0 ? `At ${when}` : describeWhen({ anchor: when, offset: o })}</option>)}
              </select>
            </>
          )}
        </div>
        <Segmented label={`Change ${index + 1}`} value={p.on ? 'on' : 'off'} onChange={(v) => onChange({ on: v === 'on', brightness: v === 'on' ? (p.brightness ?? (dimmable ? 80 : null)) : null })}
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
        <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Remove change ${index + 1}`}><Icon name="trash" size={18} /></button>
      </div>
      {p.on && dimmable && (
        <Slider label="Brightness" min={1} max={100} value={p.brightness ?? 100} format={(v) => `${v}%`} track={brightnessTrack(p.kelvin)}
          onChange={(v) => onChange({ brightness: v })} />
      )}
      {p.on && ct && (
        p.kelvin
          ? (
            <div className="kelvin-row">
              <Slider label="Warmth" min={2000} max={6500} step={50} value={p.kelvin} format={(v) => `${warmthWord(v)}, ${v} K`} track={warmthTrack()}
                onChange={(v) => onChange({ kelvin: v })} />
              <button type="button" className="btn btn-quiet btn-small" onClick={() => onChange({ kelvin: null })}>Leave warmth as it is</button>
            </div>
          )
          : <button type="button" className="btn btn-quiet btn-small" onClick={() => onChange({ kelvin: 2700 })}>Set warmth too</button>
      )}
      <div className="point-fade">
        <label htmlFor={`${id}-fade`}>Fade</label>
        <select id={`${id}-fade`} value={p.fade ?? ''} onChange={(e) => onChange({ fade: e.target.value === '' ? null : Number(e.target.value) })}>
          {FADES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        {!p.on && p.fade >= 3 && <span className="fine">Dims down over this time, then switches off.</span>}
        {!p.on && !p.fade && <span className="fine">Switches straight off.</span>}
        {p.on && p.fade >= 300 && <span className="fine">Good for waking up and winding down. Some lights can't do long fades and change straight away.</span>}
      </div>
    </li>
  );
}

// ---------- copy a week ----------

function CopySheet({ g, groups, onClose, onDone, run }) {
  const others = groups.filter((x) => x.id !== g.id);
  const [to, setTo] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true);
    try {
      const res = await run(() => api('POST', `schedules/${g.id}/copy`, { to }));
      onDone(res.schedules);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Sheet title={`Copy ${g.name}'s week`} subtitle="Their current schedules are replaced." onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!to.length || busy} onClick={go}>
          {to.length ? `Copy to ${plural(to.length, 'group')}` : 'Pick groups'}
        </button>
      </>}>
      <div className="chips">
        <button type="button" className="chip" onClick={() => setTo(to.length === others.length ? [] : others.map((x) => x.id))}>{to.length === others.length ? 'None' : 'All groups'}</button>
      </div>
      <Chips multi label="Copy to" value={to} onChange={setTo} options={others.map((x) => ({ value: x.id, label: x.name }))} />
      {err && <Notice tone="error">{err}</Notice>}
    </Sheet>
  );
}
