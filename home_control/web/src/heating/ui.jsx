import { Component, useEffect, useRef } from 'react';
import { thermal, daySegments, nowLocal, deg } from './lib.js';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
export const Icon = {
  flame: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M12 3c1 3.5 5 5.6 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.2-4.8.3 1.6 1.1 2.6 2.1 3C11 8.7 11.4 5.6 12 3Z" fill="currentColor" fillOpacity=".25" /></svg>,
  rooms: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M7.5 9v6M10.5 9v6M13.5 9v6M16.5 9v6M6 18v2M18 18v2" /></svg>,
  calendar: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>,
  list: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></svg>,
  cog: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></svg>,
  chev: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M9 6l6 6-6 6" /></svg>,
  home: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M4 11.5 12 5l8 6.5M6.5 10v9h11v-9" /></svg>,
  chart: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M4 20h16M7 16v-5M12 16V7M17 16v-8" /></svg>,
  alert: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.5M12 17.2v.3" /></svg>,
  x: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>,
  undo: (p) => <svg viewBox="0 0 24 24" {...P} {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>,
};

export function Ribbon({ schedule, day, tz, tall, showNow, showHours, labels }) {
  const segs = daySegments(schedule, day);
  const now = showNow ? nowLocal(tz) : null;
  return (
    <div className={`ribbon${tall ? ' tall' : ''}`}>
      <div className="ribbon-bar" role="img" aria-label={segs.map((s) => `${fmt(s.from)} ${deg(s.temp)}`).join(', ')}>
        {segs.map((s, i) => (
          <div key={i} className="ribbon-seg" style={{ width: `${((s.to - s.from) / 1440) * 100}%`, background: thermal(s.temp) }}>
            {labels && s.to - s.from >= 150 && <span>{deg(s.temp)}</span>}
          </div>
        ))}
        {now && now.day === day && <div className="ribbon-now" style={{ left: `${(now.minutes / 1440) * 100}%` }} />}
      </div>
      {showHours && <div className="ribbon-hours" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>}
    </div>
  );
}
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function Stepper({ value, onChange, min = 5, max = 30, step = 0.5, small, label }) {
  return (
    <div className={`stepper${small ? ' small' : ''}`}>
      <button type="button" aria-label={`Lower ${label || 'temperature'}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <div className="target num" style={{ '--heat': thermal(value) }} aria-live="polite">{deg(value)}</div>
      <button type="button" aria-label={`Raise ${label || 'temperature'}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </div>
  );
}

export function Sheet({ onClose, children, label }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Runs once per opening. Live updates re-render the page every few seconds,
  // so this must not depend on props, or it would steal focus from inputs.
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus?.({ preventScroll: true }); };
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        <div className="grab" />
        {children}
      </div>
    </div>
  );
}

// Last-resort guard: show a way back instead of a blank screen.
export class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app">
        <div className="empty">
          <h2>Something went wrong on this screen</h2>
          <p>Your heating carries on as normal. Reload to get back to it.</p>
          <p style={{ fontSize: '.8rem' }}>{String(this.state.error?.message || this.state.error)}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </main>
    );
  }
}
