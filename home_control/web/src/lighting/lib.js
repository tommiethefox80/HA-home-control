// API, live state, time formatting and the "light as colour" scale.
import { useEffect, useRef, useState, useCallback } from 'react';
import { zonedParts, minutesToTime } from '../../../server/src/lighting/schedule.js';
import { hcFetch } from '../net.js';

// ---------- API (relative URLs: ingress serves us under a random prefix) ----------

export async function api(method, path, body) {
  let res;
  try {
    res = await hcFetch(`api/lighting/${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Couldn\'t reach the Home app. Check Home Assistant is running and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data?.error || `The lighting app answered with an error (${res.status}).`);
  return data;
}

/** Live state over Server-Sent Events, falling back to polling every 5 s if SSE fails. */
export function useLiveState() {
  const [state, setState] = useState(null);
  const [link, setLink] = useState('connecting'); // 'live' | 'polling' | 'connecting' | 'down'
  const pollRef = useRef(null);

  useEffect(() => {
    let es = null; let stopped = false; let retrySse = null; let failures = 0;
    const poll = async () => {
      try { setState(await api('GET', 'state')); setLink('polling'); } catch { setLink('down'); }
    };
    const startPolling = () => {
      if (pollRef.current) return;
      poll();
      pollRef.current = setInterval(poll, 5000);
      retrySse = setTimeout(openSse, 60000);
    };
    const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null; };
    function openSse() {
      if (stopped || typeof EventSource === 'undefined') return startPolling();
      try { es = new EventSource('api/lighting/events'); } catch { return startPolling(); }
      es.addEventListener('state', (ev) => {
        failures = 0;
        stopPolling();
        setLink('live');
        try { setState(JSON.parse(ev.data)); } catch { /* ignore */ }
      });
      es.onerror = () => {
        failures++;
        if (failures >= 2) { es.close(); es = null; startPolling(); }
      };
    }
    openSse();
    return () => { stopped = true; es?.close(); stopPolling(); clearTimeout(retrySse); };
  }, []);

  const replace = useCallback((s) => { if (s && s.groups) setState(s); }, []);
  return { state, link, replace };
}

// ---------- time ----------

export function clock(ms, tz) {
  if (ms == null) return '';
  return minutesToTime(zonedParts(ms, tz).minutes);
}

export function dayLabel(ms, tz, now = Date.now()) {
  const k = (t) => { const p = zonedParts(t, tz); return `${p.year}-${p.month}-${p.day}`; };
  if (k(ms) === k(now)) return 'Today';
  if (k(ms) === k(now - 86400000)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms));
}

// ---------- light as colour ----------

const STOPS = [
  [2000, [255, 147, 44]],
  [2700, [255, 182, 98]],
  [3500, [255, 214, 162]],
  [4500, [255, 236, 214]],
  [6500, [224, 235, 255]],
];
const DIM_BASE = [92, 52, 18];

function kelvinRgb(k) {
  const kk = Math.max(2000, Math.min(6500, k || 2700));
  for (let i = 1; i < STOPS.length; i++) {
    if (kk <= STOPS[i][0]) {
      const [k0, c0] = STOPS[i - 1]; const [k1, c1] = STOPS[i];
      const t = (kk - k0) / (k1 - k0);
      return c0.map((v, j) => v + (c1[j] - v) * t);
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** Colour of a light state: dim warm amber through to bright cool white. Off returns null (use the --off token). */
export function lightRgb(on, brightness, kelvin) {
  if (!on) return null;
  const b = Math.max(1, Math.min(100, brightness ?? 100)) / 100;
  const base = kelvinRgb(kelvin);
  const t = 0.32 + 0.68 * Math.pow(b, 0.75);
  return base.map((v, j) => Math.round(DIM_BASE[j] + (v - DIM_BASE[j]) * t));
}

export function lightCss(on, brightness, kelvin) {
  const rgb = lightRgb(on, brightness, kelvin);
  return rgb ? `rgb(${rgb.join(' ')})` : 'var(--off)';
}

/** Ink that reads on top of a light colour. */
export function inkOn(on, brightness, kelvin) {
  const rgb = lightRgb(on, brightness, kelvin);
  if (!rgb) return 'var(--off-ink)';
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.3 ? '#1c252c' : '#fff6ea';
}

export function levelText(l, dimmable = true) {
  if (!l || !l.on) return 'Off';
  if (!dimmable || l.brightness == null) return 'On';
  return `${l.brightness}%`;
}

export function warmthWord(k) {
  if (!k) return '';
  if (k < 2600) return 'Candle warm';
  if (k < 3200) return 'Warm';
  if (k < 4200) return 'Neutral';
  if (k < 5300) return 'Cool';
  return 'Daylight';
}

// ---------- small helpers ----------

export const store = {
  get(key, fallback = null) { try { const v = window.localStorage.getItem(`lighting:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { window.localStorage.setItem(`lighting:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};

/** Go back to an HA dashboard: we run inside HA's iframe, so navigate the parent. */
export function goDashboard(path = '/') {
  try {
    const parent = window.parent;
    if (parent && parent !== window && parent.history) {
      parent.history.pushState(null, '', path);
      parent.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
      return;
    }
  } catch { /* cross-origin: fall through */ }
  try { window.top.location.href = path; } catch { window.location.href = path; }
}

export function plural(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

export function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
