// Cameras: API, live state, and opening Home Assistant's own live view.
import { useCallback, useEffect, useRef, useState } from 'react';
import { zonedParts, minutesToTime } from '../../../server/src/lighting/schedule.js';
import { hcFetch } from '../net.js';

export async function api(method, path, body) {
  let res;
  try {
    res = await hcFetch(`api/cameras/${path}`, {
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
      pollRef.current = setInterval(poll, 5000);
      retry = setTimeout(open, 60000);
    };
    const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null; };
    function open() {
      if (stopped || typeof EventSource === 'undefined') return startPolling();
      try { es = new EventSource('api/cameras/live'); } catch { return startPolling(); }
      es.addEventListener('state', (ev) => {
        failures = 0; stopPolling(); setLink('live');
        try { setState(JSON.parse(ev.data)); } catch { /* ignore */ }
      });
      es.onerror = () => { failures++; if (failures >= 2) { es.close(); es = null; startPolling(); } };
    }
    open();
    return () => { stopped = true; es?.close(); stopPolling(); clearTimeout(retry); };
  }, []);
  const replace = useCallback((s) => { if (s?.cameras) setState(s); }, []);
  return { state, link, replace };
}

export function clock(ms, tz) {
  return ms == null ? '' : minutesToTime(zonedParts(ms, tz).minutes);
}

/** "21:42", "yesterday 21:42" or "Tue 14 Oct, 21:42" */
export function when(ms, tz, now = Date.now()) {
  if (ms == null) return '';
  const day = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(t));
  if (day(ms) === day(now)) return clock(ms, tz);
  if (day(ms) === day(now - 86400000)) return `yesterday ${clock(ms, tz)}`;
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms))}, ${clock(ms, tz)}`;
}

/** Home Assistant's own live view of a camera (works for every make), over the app. */
export function openLive(entityId) {
  try {
    const ha = window.parent !== window && window.parent.document.querySelector('home-assistant');
    if (ha) {
      ha.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
      return true;
    }
  } catch { /* not inside Home Assistant */ }
  return false;
}

export const WHEN_OPTIONS = [
  { value: 'always', label: 'Always' },
  { value: 'away', label: 'When everyone\'s out' },
  { value: 'times', label: 'Between set times' },
  { value: 'away_or_times', label: 'When everyone\'s out, or between set times' },
  { value: 'never', label: 'Never' },
];

export function whenText(s) {
  switch (s.when) {
    case 'always': return 'always';
    case 'away': return 'when everyone\'s out';
    case 'times': return `${s.from}–${s.to}`;
    case 'away_or_times': return `when out, or ${s.from}–${s.to}`;
    default: return 'never';
  }
}

export const KIND_ICON = { person: 'motion', vehicle: 'motion', animal: 'motion', visitor: 'bell', package: 'motion', sound: 'bell', movement: 'motion' };
