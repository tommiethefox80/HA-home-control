// Energy: API, live state, and words for prices, money and times.
import { useCallback, useEffect, useRef, useState } from 'react';
import { zonedParts, minutesToTime } from '../../../server/src/lighting/schedule.js';

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`api/energy/${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Couldn\'t reach the Home app. Check Home Assistant is running and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data?.error || `The Home app answered with an error (${res.status}).`);
  return data;
}

/** Live state over Server-Sent Events, falling back to polling. */
export function useLiveState() {
  const [state, setState] = useState(null);
  const [link, setLink] = useState('connecting');
  const pollRef = useRef(null);
  useEffect(() => {
    let es = null; let stopped = false; let failures = 0; let retry = null;
    const poll = async () => { try { setState(await api('GET', 'state')); setLink('polling'); } catch { setLink('down'); } };
    const startPolling = () => {
      if (pollRef.current) return;
      poll();
      pollRef.current = setInterval(poll, 10000);
      retry = setTimeout(open, 60000);
    };
    const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null; };
    function open() {
      if (stopped || typeof EventSource === 'undefined') return startPolling();
      try { es = new EventSource('api/energy/live'); } catch { return startPolling(); }
      es.addEventListener('state', (ev) => {
        failures = 0; stopPolling(); setLink('live');
        try { setState(JSON.parse(ev.data)); } catch { /* ignore */ }
      });
      es.onerror = () => { failures++; if (failures >= 2) { es.close(); es = null; startPolling(); } };
    }
    open();
    return () => { stopped = true; es?.close(); stopPolling(); clearTimeout(retry); };
  }, []);
  const replace = useCallback((s) => { if (s && 'rates' in s && 'plans' in s) setState((cur) => ({ ...cur, ...s })); }, []);
  return { state, link, replace };
}

export function clock(ms, tz) {
  return ms == null ? '' : minutesToTime(zonedParts(ms, tz).minutes);
}

const dayOf = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(t));

/** "21:42", "tomorrow 02:00", "yesterday 21:42" or "Tue 14 Oct, 21:42" */
export function when(ms, tz, now = Date.now()) {
  if (ms == null) return '';
  const d = dayOf(ms, tz);
  if (d === dayOf(now, tz)) return clock(ms, tz);
  if (d === dayOf(now + 86400000, tz)) return `tomorrow ${clock(ms, tz)}`;
  if (d === dayOf(now - 86400000, tz)) return `yesterday ${clock(ms, tz)}`;
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms))}, ${clock(ms, tz)}`;
}

/** A run of time: "02:00–04:00", "tomorrow 02:00–04:00", "23:30–05:30 tonight" */
export function span(start, end, tz, now = Date.now()) {
  const a = when(start, tz, now);
  return `${a}–${clock(end, tz)}`;
}

/** "Today", "Yesterday", or "Wed 15 Oct" for a day key (YYYY-MM-DD) */
export function dayWord(key, tz, now = Date.now()) {
  if (!key) return '';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now));
  const yday = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now - 86400000));
  if (key === today) return 'Today';
  if (key === yday) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** £1.23, or 85p under a pound */
export function money(v, currency = 'GBP') {
  if (v == null || !Number.isFinite(v)) return '–';
  if (currency !== 'GBP') return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(v);
  if (Math.abs(v) < 1) return `${Math.round(v * 100)}p`;
  return `${v < 0 ? '-' : ''}£${Math.abs(v).toFixed(2)}`;
}

/** A price in pence per kWh: "18.2p", "-1.5p" */
export function pence(p) {
  if (p == null || !Number.isFinite(p)) return '–';
  const r = Math.round(p * 10) / 10;
  return `${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}p`;
}

export function kwh(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} kWh`;
}

export function hoursText(min) {
  if (min === 30) return 'half an hour';
  if (min === 60) return '1 hour';
  return `${min % 60 ? (min / 60).toFixed(1) : min / 60} hours`;
}

export const BAND = {
  free: { word: 'Paid to use', short: 'Free' },
  cheap: { word: 'Cheap', short: 'Cheap' },
  standard: { word: 'Standard', short: 'Standard' },
  peak: { word: 'Peak', short: 'Peak' },
};

export function watts(w) {
  if (w == null) return null;
  return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;
}
