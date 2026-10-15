// Home: the heating and lighting halves in one app, with a switch at the top of each.
// Both halves stay mounted so switching is instant and each keeps its live connection;
// only the one on screen renders anything.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import HeatingApp from './heating/App.jsx';
import { App as LightingApp } from './lighting/App.jsx';
import { ErrorBoundary as HeatingBoundary } from './heating/ui.jsx';
import { ErrorBoundary as LightingBoundary } from './lighting/ui.jsx';
import { MoveScreen, MovedBanner, useMove, useOldHome } from './Move.jsx';

export const sectionOf = (hash) => (/^#\/?lighting(\/|$)/.test(hash || '') ? 'lighting' : 'heating');
const HOME = { heating: '#/', lighting: '#/lighting/lights' };

/** ?section=lighting on the panel's address (e.g. a dashboard button) opens straight onto lighting. */
function askedFor() {
  const read = (loc) => { try { return new URLSearchParams(loc.search).get('section'); } catch { return null; } };
  let s = read(window.location);
  try { if (!s && window.parent !== window) s = read(window.parent.location); } catch { /* not inside Home Assistant */ }
  return s === 'lighting' || s === 'heating' ? s : null;
}

export function startSection() {
  const s = askedFor();
  if (s && s !== sectionOf(window.location.hash)) window.location.replace(HOME[s]);
  return sectionOf(window.location.hash);
}

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const Flame = () => <svg viewBox="0 0 24 24" {...P}><path d="M12 3c1 3.5 5 5.6 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.2-4.8.3 1.6 1.1 2.6 2.1 3C11 8.7 11.4 5.6 12 3Z" /></svg>;
const Bulb = () => <svg viewBox="0 0 24 24" {...P}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z" /></svg>;

function SectionSwitch({ section, links, heatOn, lightOn }) {
  return (
    <nav className="home-switch" aria-label="Heating or lighting">
      <a href={links.heating} aria-current={section === 'heating' ? 'page' : undefined}>
        <Flame /><span>Heating</span>
        {heatOn && section !== 'heating' && <span className="hs-dot hs-heat" title="Boiler on"><span className="sr-only">, boiler on</span></span>}
      </a>
      <a href={links.lighting} aria-current={section === 'lighting' ? 'page' : undefined}>
        <Bulb /><span>Lighting</span>
        {lightOn && section !== 'lighting' && <span className="hs-dot hs-light" title="Lights on"><span className="sr-only">, lights on</span></span>}
      </a>
    </nav>
  );
}

export function Shell() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    // Home Assistant navigating to this panel again with ?section=… while it's already open
    let parent = null;
    try { if (window.parent !== window && window.parent.location.href) parent = window.parent; } catch { parent = null; }
    const fromHA = () => {
      const s = askedFor();
      if (s && s !== sectionOf(window.location.hash)) window.location.hash = HOME[s];
    };
    parent?.addEventListener('location-changed', fromHA);
    return () => { window.removeEventListener('hashchange', on); parent?.removeEventListener('location-changed', fromHA); };
  }, []);

  const move = useMove();
  const old = useOldHome(move.status);
  // a fresh install next to the Home Control installed by hand: offer to move everything here
  const moving = !!(move.status?.empty && old);
  const deciding = !move.status || (move.status.empty && old === undefined);

  const section = moving ? 'heating' : sectionOf(hash);
  // Coming back to a section returns to the page you were last on there.
  const last = useRef({ ...HOME });
  last.current[section] = hash && hash !== '#' ? hash : HOME[section];

  useLayoutEffect(() => {
    document.body.classList.toggle('sec-heating', section === 'heating');
    document.body.classList.toggle('sec-lighting', section === 'lighting');
    document.title = section === 'lighting' ? 'Lighting' : 'Heating';
  }, [section]);

  const switcher = (status) => <SectionSwitch section={section} links={last.current} {...status} />;
  if (deciding) return null;
  if (moving) return <MoveScreen status={move.status} old={old} />;
  return (
    <>
      <MovedBanner status={move.status} onDone={move.reload} />
      <div hidden={section !== 'heating'}>
        <HeatingBoundary><HeatingApp active={section === 'heating'} switcher={switcher} /></HeatingBoundary>
      </div>
      <div hidden={section !== 'lighting'}>
        <LightingBoundary><LightingApp active={section === 'lighting'} switcher={switcher} /></LightingBoundary>
      </div>
    </>
  );
}
