import { useEffect, useState } from 'react';

// ---------- API (relative URLs so it works behind HA ingress) ----------
const base = () => new URL('./api/', window.location.href.split('#')[0]);

// Every change the GUI makes (hold, back to schedule, boost, mode, settings…) answers with the
// fresh state. It's applied straight away, so the screen never waits on the live stream.
let liveSink = null;
const asSnapshot = (d) => (d && Array.isArray(d.zones) && d.mode ? d : d?.state && Array.isArray(d.state.zones) ? d.state : null);

export async function api(path, method = 'GET', body) {
  const res = await fetch(new URL(path, base()), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  if (method !== 'GET' && liveSink) { const snap = asSnapshot(data); if (snap) liveSink(snap); }
  return data;
}

// Live state: Server-Sent Events, falling back to polling if SSE is blocked.
// A stream can also die silently (the Home Assistant phone app in the background, a flaky
// network): still "open", but nothing arrives. The server sends a heartbeat every 25 s, so if
// we hear nothing for 70 s we reconnect, and coming back to the app always fetches fresh state.
export function useLiveState() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let es = null;
    let closed = false;
    let poller = null;
    let last = Date.now();
    const apply = (s) => { if (!closed) { setState(s); setError(null); } };
    liveSink = apply;
    const poll = async () => {
      try { apply(await api('state')); } catch (e) { if (!closed) setError(e.message); }
    };
    const startPolling = () => { if (poller) return; poll(); poller = setInterval(poll, 5000); };
    const stopPolling = () => { clearInterval(poller); poller = null; };
    const connect = () => {
      es?.close();
      last = Date.now();
      try {
        es = new EventSource(new URL('events', base()));
        es.onmessage = (ev) => { last = Date.now(); stopPolling(); apply(JSON.parse(ev.data)); };
        es.addEventListener('ping', () => { last = Date.now(); });
        es.onerror = () => { if (!closed) startPolling(); };
      } catch { startPolling(); }
    };
    connect();
    const t = setTimeout(() => { if (!es || es.readyState !== 1) startPolling(); }, 4000);
    const watchdog = setInterval(() => {
      if (closed || Date.now() - last < 70000 || es?.readyState === 0) return;
      poll();
      connect();
    }, 15000);
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      poll();
      if (Date.now() - last > 35000) connect();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      closed = true;
      if (liveSink === apply) liveSink = null;
      es?.close();
      clearTimeout(t);
      clearInterval(watchdog);
      stopPolling();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, []);
  return [state, setState, error];
}

// Navigate Home Assistant itself (we run inside its ingress iframe).
export function goToHA(path = '/') {
  try {
    const w = window.parent;
    if (w && w !== window && w.location.origin === window.location.origin) {
      w.history.pushState(null, '', path);
      w.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
      return;
    }
  } catch { /* cross-origin: fall through */ }
  window.top.location.href = path;
}

// ---------- thermal colour scale ----------
const STOPS = [
  [7, [74, 111, 150]],    // frost: steel blue
  [13, [111, 152, 166]],  // cool
  [16.5, [139, 178, 160]],// setback: sage
  [19, [230, 182, 72]],   // comfortable: amber
  [21, [238, 132, 52]],   // warm: orange
  [24, [196, 66, 45]],    // hot: ember
];
export function thermal(t) {
  if (t == null || Number.isNaN(t)) return 'var(--muted-line)';
  if (t <= STOPS[0][0]) return rgb(STOPS[0][1]);
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    const [t0, c0] = STOPS[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return rgb(c0.map((v, k) => v + (c1[k] - v) * f));
    }
  }
  return rgb(STOPS[STOPS.length - 1][1]);
}
const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;

// ---------- formatting ----------
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
export const DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export const deg = (t, dp = 1) => (t == null ? '–' : `${Number(t).toFixed(dp).replace(/\.0$/, '')}°`);
export const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export function fmtTime(ms, tz, withDay) {
  if (!ms) return '';
  const d = new Date(ms);
  const opts = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short' });
  const sameDay = today.format(d) === today.format(new Date());
  if (withDay || !sameDay) opts.weekday = 'short';
  return new Intl.DateTimeFormat('en-GB', opts).format(d);
}

export function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function minutesLeft(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

// local day/minute "now" in HA's time zone
export function nowLocal(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return { day: g('weekday').toLowerCase().slice(0, 3), minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}

// Segments for one day of a schedule, carrying the previous day's last value in.
export function daySegments(schedule, day) {
  const idx = DAYS.indexOf(day);
  let carry = null;
  for (let k = 1; k <= 7 && carry == null; k++) {
    const prev = schedule?.[DAYS[(idx - k + 7) % 7]] || [];
    if (prev.length) carry = prev[prev.length - 1].temp;
  }
  const pts = schedule?.[day] || [];
  const segs = [];
  let start = 0;
  let temp = carry;
  for (const p of pts) {
    const at = toMin(p.time);
    if (at > start) segs.push({ from: start, to: at, temp });
    start = at;
    temp = p.temp;
  }
  segs.push({ from: start, to: 1440, temp });
  return segs.filter((s) => s.to > s.from);
}
