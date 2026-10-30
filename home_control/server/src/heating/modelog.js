// When the house was on Away or had the heating off, kept so the figures that compare a room with
// its usual (heat-loss alerts, how fast it cools, Insights) can leave those times out.
//
// A house left on Away isn't in its usual state: its rooms sit at the Away temperature, and the
// walls, floors and furniture cool right down with them. Short bursts of heat to keep a room at 12°
// warm the air, which then drops quickly back into the cold fabric; and for a day or two after
// coming back, a room that's warmed up loses heat fast in the same way while its walls catch up.
// Measured like an ordinary night, that looks like a room losing heat two, three or four times
// faster than usual. So those times, and the two days after, aren't counted.
//
// Kept as runtime.modeLog: [{ mode: 'away' | 'off', from, to }] (to null while it lasts), 90 days.
// Filled in once, for the time before this was kept, from Activity's "Mode: …" notes.

export const RECOVER_MS = 48 * 3600000; // the walls warming back up after Away (or the heating off)
const KEEP_MS = 90 * 86400000;
const UNUSUAL = new Set(['away', 'off']);

/** The house's mode changed (at `at`): close what was open, start a new one for Away or off. */
export function recordMode(list, mode, at = Date.now()) {
  const open = list.find((e) => e.to == null);
  if (open && open.mode === mode) return list; // no change
  if (open) open.to = at;
  if (UNUSUAL.has(mode)) list.push({ mode, from: at, to: null });
  const cutoff = at - KEEP_MS;
  return list.filter((e) => e.to == null || e.to >= cutoff);
}

/** The same, from Activity's notes (newest first, as kept): for the time before the log was kept. */
export function modeLogFromActivity(entries, { now = Date.now(), current = 'auto' } = {}) {
  const changes = [];
  for (const e of entries || []) {
    const m = typeof e?.msg === 'string' ? e.msg : '';
    let mode = null;
    if (/^Mode: Away\b/.test(m)) mode = 'away';
    else if (/^Mode: Heating off\b/.test(m)) mode = 'off';
    else if (/^Mode: Schedules\b/.test(m) || /^Away mode ended\b/.test(m)) mode = 'auto';
    if (mode) changes.push({ at: e.at, mode });
  }
  changes.sort((a, b) => a.at - b.at);
  let list = [];
  for (const c of changes) list = recordMode(list, c.mode, c.at);
  // in Away or off now with no note for it (it began before Activity goes back): from the oldest note
  if (UNUSUAL.has(current) && !list.some((e) => e.to == null)) {
    const oldest = (entries || []).reduce((a, e) => Math.min(a, e?.at ?? a), now);
    list.push({ mode: current, from: oldest, to: null });
  }
  return list;
}

/** The times between `from` and `to` that aren't usual: Away or off, and the two days after. */
export function unusualSpans(list, from, to, { recover = RECOVER_MS, now = Date.now() } = {}) {
  const out = [];
  for (const e of list || []) {
    const a = Math.max(from, e.from);
    const b = Math.min(to, (e.to ?? now) + recover);
    if (b > a) out.push([a, b]);
  }
  out.sort((x, y) => x[0] - y[0]);
  // merged, so each moment is in at most one
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([...s]);
  }
  return merged;
}

/** The local days ('YYYY-MM-DD') any of the spans touch. */
export function daysTouched(spans, tz) {
  const key = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const days = new Set();
  for (const [a, b] of spans) {
    for (let t = a; t < b; t += 3600000) days.add(key(t));
    days.add(key(b - 1));
  }
  return days;
}
