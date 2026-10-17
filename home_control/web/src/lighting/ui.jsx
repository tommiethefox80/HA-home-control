import { Component, useEffect, useId, useRef } from 'react';
import { lightCss, levelText } from './lib.js';
import { minutesToTime } from '../../../server/src/lighting/schedule.js';

// ---------- icons (inline, decorative unless labelled) ----------

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z',
  socket: 'M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM9 9v3M15 9v3M10 16h4',
  switch: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM10 7h4v5h-4z',
  power: 'M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  motion: 'M13 4a2 2 0 1 0 0 .1M9 21l2-6 3 3v3M7 12l2-4 4 1 3 3 3-1M11 15l-1-5',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  away: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6',
  pause: 'M8 5v14M16 5v14',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  warn: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  check: 'M5 12l5 5L20 7',
  // cameras
  camera: 'M3 7h12a2 2 0 0 1 2 2v1.5L21 8v8l-4-2.5V15a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  bellOff: 'M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8M10 21h4M3 3l18 18',
  rec: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  play: 'M8 5v14l11-7z',
  live: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  offline: 'M3 3l18 18M8.5 8.6A6 6 0 0 0 6 13M2 9a15 15 0 0 1 4-2.7M12 18h.01M9.5 15a3.5 3.5 0 0 1 5 0M17.7 11.8a6 6 0 0 0-3-2.5M22 9a15 15 0 0 0-9.5-3.9',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15 9h.01',
  wifi: 'M2 8.8a15 15 0 0 1 20 0M5.5 12.4a10 10 0 0 1 13 0M9 15.9a5 5 0 0 1 6 0M12 19.5h.01',
  ap: 'M4 9.5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 9.5v2c0 1.7 3.6 3 8 3s8-1.3 8-3v-2M12 9.5h.01',
  led: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2M12 19v2M5.6 5.6 7 7M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4',
  restart: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  phone: 'M8 2.5h8a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2zM11 18h2',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  block: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  netbox: 'M3 8h18v8H3zM7 12h.01M11 12h.01M15 12h.01',
  plug: 'M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5',
  // energy
  bolt: 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z',
  car: 'M5 16h14M5 16v2.5M19 16v2.5M3.5 12.5 5.6 7.4A2 2 0 0 1 7.4 6h9.2a2 2 0 0 1 1.8 1.4l2.1 5.1M3.5 12.5h17v3.5h-17zM7 14.2h.01M17 14.2h.01',
  flame: 'M12 3c1 3.5 5 5.6 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.2-4.8.3 1.6 1.1 2.6 2.1 3C11 8.7 11.4 5.6 12 3Z',
  chart: 'M4 20h16M7 16v-5M12 16V6M17 16v-8',
  pound: 'M16 6.5A3.5 3.5 0 0 0 9.5 8v4.5c0 3-1 5-2.5 6.5H17M7 12.5h7',
};

export function Icon({ name, size = 20, label, className }) {
  return (
    <svg className={`icon ${className || ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined}
      aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={PATHS[name] || ''} />
    </svg>
  );
}

export const kindIcon = (kind) => (kind === 'socket' ? 'socket' : kind === 'switch' ? 'switch' : 'bulb');

// ---------- sheet (bottom on phones, centred on desktop) ----------

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ title, subtitle, onClose, children, footer, wide }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  // Runs once per opening. Live updates re-render every few seconds; depending on props here
  // would steal focus from inputs (desktop time fields become uneditable). Don't add deps.
  useEffect(() => {
    const before = document.activeElement;
    const el = ref.current;
    const first = el?.querySelector('[data-autofocus]') || el?.querySelector(FOCUSABLE);
    first?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current?.(); return; }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const a = items[0]; const z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('sheet-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sheet-open');
      before?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current?.(); }}>
      <div className={`sheet ${wide ? 'sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="sheet-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="sheet-sub">{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={() => closeRef.current?.()} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- ribbon: a day of light, painted in the light's own colour ----------

export function Ribbon({ segments, nowMin, height = 10, ticks = false, label, dimmable = true }) {
  const summary = label || (segments?.length
    ? segments.map((s) => `${minutesToTime(s.from)} ${levelText(s, dimmable)}`).join(', ')
    : 'No schedule');
  return (
    <div className="ribbon-wrap">
      <div className="ribbon" style={{ height }} role="img" aria-label={summary}>
        {(segments || []).map((s, i) => (
          <span key={i} className="ribbon-seg"
            style={{ left: `${(s.from / 1440) * 100}%`, width: `${((s.to - s.from) / 1440) * 100}%`, background: s.on ? lightCss(true, s.brightness, s.kelvin) : 'var(--ribbon-off)' }} />
        ))}
        {nowMin != null && <span className="ribbon-now" style={{ left: `${(nowMin / 1440) * 100}%` }} />}
      </div>
      {ticks && (
        <div className="ribbon-ticks" aria-hidden="true">
          {[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h % 24).padStart(2, '0')}:00</span>)}
        </div>
      )}
    </div>
  );
}

// ---------- form bits ----------

export function Toggle({ checked, onChange, label, description, disabled }) {
  const id = useId();
  return (
    <div className="toggle-row">
      <label htmlFor={id}>
        <span className="toggle-label">{label}</span>
        {description && <span className="field-help">{description}</span>}
      </label>
      <button id={id} type="button" role="switch" aria-checked={!!checked} className="switch" disabled={disabled}
        onClick={() => onChange(!checked)}><span /></button>
    </div>
  );
}

export function Chips({ options, value, onChange, multi = false, label, small }) {
  const has = (v) => (multi ? value.includes(v) : value === v);
  return (
    <div className={`chips ${small ? 'chips-small' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={`chip ${has(o.value) ? 'chip-on' : ''}`} aria-pressed={has(o.value)}
          disabled={o.disabled} onClick={() => {
            if (!multi) return onChange(o.value);
            onChange(has(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value]);
          }}>
          {o.swatch && <span className="chip-swatch" style={{ background: o.swatch }} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'seg-on' : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={18} />}{o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, onCommit, format, track, disabled }) {
  const id = useId();
  return (
    <div className="slider">
      <div className="slider-top">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{format ? format(value) : value}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value ?? min} disabled={disabled}
        style={track ? { '--track': track } : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number(e.target.value))}
        onKeyUp={(e) => onCommit?.(Number(e.target.value))} />
    </div>
  );
}

export function Field({ label, help, children, htmlFor }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && <p className="field-help">{help}</p>}
    </div>
  );
}

export function Notice({ tone = 'info', children, action }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone !== 'info' && <Icon name="warn" size={18} />}
      <div>{children}</div>
      {action}
    </div>
  );
}

// Brightness track painted with the light scale itself.
export function brightnessTrack(kelvin) {
  return `linear-gradient(90deg, ${lightCss(true, 1, kelvin)}, ${lightCss(true, 100, kelvin)})`;
}
export function warmthTrack() {
  return `linear-gradient(90deg, ${lightCss(true, 100, 2000)}, ${lightCss(true, 100, 3500)}, ${lightCss(true, 100, 6500)})`;
}

// ---------- error boundary ----------

export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>Something went wrong on this screen</h1>
        <p>Your lights keep running as normal. Reloading usually fixes this.</p>
        <pre>{String(this.state.error?.message || this.state.error)}</pre>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
