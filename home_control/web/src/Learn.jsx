// Suggested schedule changes, from changes made by hand that keep happening (server: patterns.js),
// and the ones made recently (by a suggestion, or automatically), with Undo. Shared by heating and
// lighting; styles in shell.css.
import { useState } from 'react';
import { hcFetch } from './net.js';

async function call(path) {
  const r = await hcFetch(`api/patterns/${path}`, { method: 'POST', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Home Control answered ${r.status}`);
  return d;
}

const SHOW_DONE_MS = 2 * 86400000; // a change made is shown (with Undo) for two days

// "Lounge was turned up to 22° …" under "Lounge:" reads "Turned up to 22° …"
const reason = (why, name) => (why.startsWith(`${name} was `) ? `${why.charAt(name.length + 5).toUpperCase()}${why.slice(name.length + 6)}` : why);

export function Suggestions({ part, learn, notify, settingsHref }) {
  const [busy, setBusy] = useState(null);
  const [gone, setGone] = useState(() => new Set());
  if (!learn) return null;
  const now = Date.now();
  const sugs = (learn.suggestions || []).filter((s) => !gone.has(s.id));
  const done = (learn.applied || []).filter((a) => now - a.at < SHOW_DONE_MS && !gone.has(`u${a.id}`));
  if (!sugs.length && !done.length) return null;

  const act = async (key, path, msg) => {
    setBusy(key);
    try {
      await call(path);
      setGone((g) => new Set([...g, key.replace(/:.*/, '')]));
      notify?.(msg);
    } catch (e) { notify?.(e.message, true); }
    setBusy(null);
  };
  return (
    <section className="learn" aria-labelledby={`learn-h-${part}`}>
      <h2 id={`learn-h-${part}`}>{sugs.length ? 'Suggested schedule changes' : 'Schedule changed to match'}</h2>
      <ul>
        {sugs.map((s) => (
          <li key={s.id}>
            <p className="learn-change"><b>{s.name}:</b> {s.change}</p>
            <p className="learn-why">{reason(s.why, s.name)}</p>
            <div className="learn-actions">
              <button type="button" className="learn-btn learn-btn-go" disabled={!!busy} onClick={() => act(`${s.id}:apply`, `${part}/${s.id}/apply`, `${s.name}: schedule changed`)}>Change the schedule</button>
              <button type="button" className="learn-btn" disabled={!!busy} onClick={() => act(`${s.id}:later`, `${part}/${s.id}/later`, 'Asked again in a week if it keeps happening')}>Not now</button>
              <button type="button" className="learn-btn learn-btn-quiet" disabled={!!busy} onClick={() => act(`${s.id}:never`, `${part}/${s.id}/never`, 'Won\'t be suggested again')}>Don't suggest this</button>
            </div>
          </li>
        ))}
        {done.map((a) => (
          <li key={`u${a.id}`} className="learn-done">
            <p className="learn-change"><b>{a.name}:</b> {a.auto ? 'changed automatically' : 'changed'}: {a.change.charAt(0).toLowerCase()}{a.change.slice(1)}</p>
            <p className="learn-why">{reason(a.why, a.name)}</p>
            <div className="learn-actions">
              <button type="button" className="learn-btn" disabled={!!busy} onClick={() => act(`u${a.id}:undo`, `${part}/${a.id}/undo`, `${a.name}: put back as it was`)}>Undo</button>
            </div>
          </li>
        ))}
      </ul>
      {settingsHref && <p className="learn-fine">Each {part === 'heating' ? 'room' : 'group'} can suggest changes, make them automatically, or neither: <a href={settingsHref}>its settings</a>.</p>}
    </section>
  );
}

/** The setting for a room or group: what to do with changes made by hand that keep happening. */
export const LEARN_OPTIONS = [
  { value: 'suggest', label: 'Suggest a schedule change' },
  { value: 'auto', label: 'Change the schedule automatically' },
  { value: 'off', label: 'Leave the schedule alone' },
];

export function learnHelp(value, what = 'room') {
  if (value === 'auto') return `When the same change keeps being made by hand at about the same time (most evenings, or every Friday), the schedule is changed to match straight away. It says so at the top of the page and in Activity, with an Undo.`;
  if (value === 'off') return `Changes made by hand are left as they are; nothing is suggested for this ${what}.`;
  return `When the same change keeps being made by hand at about the same time (most evenings, or every Friday), a change to the schedule is suggested at the top of the page, to make with one tap.`;
}
