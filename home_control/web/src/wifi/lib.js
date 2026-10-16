// Wi-Fi: API, live state and words for times and schedules.
import { useCallback, useEffect, useRef, useState } from 'react';
import { zonedParts, minutesToTime } from '../../../server/src/lighting/schedule.js';

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`api/wifi/${path}`, {
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
      try { es = new EventSource('api/wifi/live'); } catch { return startPolling(); }
      es.addEventListener('state', (ev) => {
        failures = 0; stopPolling(); setLink('live');
        try { setState(JSON.parse(ev.data)); } catch { /* ignore */ }
      });
      es.onerror = () => { failures++; if (failures >= 2) { es.close(); es = null; startPolling(); } };
    }
    open();
    return () => { stopped = true; es?.close(); stopPolling(); clearTimeout(retry); };
  }, []);
  const replace = useCallback((s) => { if (s?.networks && s?.aps) setState((cur) => ({ ...cur, ...s })); }, []);
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

/** "9 days", "3 h", "25 min" */
export function upFor(since, now = Date.now()) {
  if (!since) return null;
  const m = Math.max(0, Math.round((now - since) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

export function scheduleText(s, { onWord = 'on', offWord = 'off' } = {}) {
  if (!s || s.mode === 'none') return null;
  return s.mode === 'off_between' ? `${offWord[0].toUpperCase()}${offWord.slice(1)} ${s.from}–${s.to}` : `${onWord[0].toUpperCase()}${onWord.slice(1)} only ${s.from}–${s.to}`;
}

export const STATE_WORDS = {
  connected: 'Online', disconnected: 'Offline', pending: 'Waiting to be adopted', firmware_mismatch: 'Firmware mismatch',
  upgrading: 'Updating', provisioning: 'Applying settings', heartbeat_missed: 'Not answering', adopting: 'Being adopted',
  deleting: 'Being removed', inform_error: 'Can\'t reach the controller', adoption_failed: 'Adoption failed', isolated: 'Isolated',
};

export function statusOf(d) {
  if (d.switchedOff) return { text: 'Switched off', tone: 'off' };
  if (d.state && d.state !== 'connected') return { text: STATE_WORDS[d.state] || d.state, tone: d.state === 'upgrading' || d.state === 'provisioning' ? 'busy' : 'warn' };
  return d.online ? { text: 'Online', tone: 'ok' } : { text: 'Offline', tone: 'warn' };
}
