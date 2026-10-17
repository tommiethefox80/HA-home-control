// Home: the heating and lighting halves in one app, with a switch at the top of each.
// Both halves stay mounted so switching is instant and each keeps its live connection;
// only the one on screen renders anything.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import HeatingApp from './heating/App.jsx';
import { App as CamerasApp } from './cameras/App.jsx';
import { App as WifiApp } from './wifi/App.jsx';
import { App as EnergyApp } from './energy/App.jsx';
import { App as LightingApp } from './lighting/App.jsx';
import { ErrorBoundary as HeatingBoundary } from './heating/ui.jsx';
import { ErrorBoundary as LightingBoundary } from './lighting/ui.jsx';
import { MoveScreen, MovedBanner, useMove, useOldHome } from './Move.jsx';
import { GENERAL, useHome } from './HomeSettings.jsx';
import { SETTINGS_MENU } from './SettingsFrame.jsx';

export const sectionOf = (hash) => {
  const m = /^#\/?(lighting|cameras|wifi|energy)(\/|$)/.exec(hash || '');
  return m ? m[1] : 'heating';
};
const HOME = { heating: '#/', lighting: '#/lighting/lights', cameras: '#/cameras/', wifi: '#/wifi/', energy: '#/energy/' };
const SECTIONS = ['heating', 'lighting', 'cameras', 'wifi', 'energy'];
// new parts start off (as in the app's house settings)
const STARTS_ON = { heating: true, lighting: true, cameras: false, wifi: false, energy: false };

/** ?section=lighting on the panel's address (e.g. a dashboard button) opens straight onto lighting. */
function askedFor() {
  const read = (loc) => { try { return new URLSearchParams(loc.search).get('section'); } catch { return null; } };
  let s = read(window.location);
  try { if (!s && window.parent !== window) s = read(window.parent.location); } catch { /* not inside Home Assistant */ }
  return SECTIONS.includes(s) ? s : null;
}

export function startSection() {
  const s = askedFor();
  if (s && s !== sectionOf(window.location.hash)) window.location.replace(HOME[s]);
  return sectionOf(window.location.hash);
}

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const Flame = () => <svg viewBox="0 0 24 24" {...P}><path d="M12 3c1 3.5 5 5.6 5 10a5 5 0 0 1-10 0c0-2.3 1-3.7 2.2-4.8.3 1.6 1.1 2.6 2.1 3C11 8.7 11.4 5.6 12 3Z" /></svg>;
const Bulb = () => <svg viewBox="0 0 24 24" {...P}><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z" /></svg>;
const Cam = () => <svg viewBox="0 0 24 24" {...P}><path d="M3 7h12a2 2 0 0 1 2 2v1.5L21 8v8l-4-2.5V15a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" /></svg>;
const Bolt = () => <svg viewBox="0 0 24 24" {...P}><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" /></svg>;
const Wifi = () => <svg viewBox="0 0 24 24" {...P}><path d="M2 8.8a15 15 0 0 1 20 0M5.5 12.4a10 10 0 0 1 13 0M9 15.9a5 5 0 0 1 6 0M12 19.5h.01" /></svg>;

const PARTS = { heating: { name: 'Heating', Icon: Flame }, lighting: { name: 'Lighting', Icon: Bulb }, cameras: { name: 'Cameras', Icon: Cam }, wifi: { name: 'Wi-Fi', Icon: Wifi }, energy: { name: 'Energy', Icon: Bolt } };

function SectionSwitch({ section, links, heatOn, lightOn, parts }) {
  // only one part looked after here: its name, no switch
  if (parts.length === 1) {
    const { name, Icon } = PARTS[parts[0]];
    return <span className="home-solo"><Icon /><span>{name}</span></span>;
  }
  // "something's on over there"
  const dot = {
    heating: heatOn && <span className="hs-dot hs-heat" title="Boiler on"><span className="sr-only">, boiler on</span></span>,
    lighting: lightOn && <span className="hs-dot hs-light" title="Lights on"><span className="sr-only">, lights on</span></span>,
  };
  return (
    <nav className={`home-switch home-switch-${parts.length}`} aria-label="Parts of Home Control">
      {parts.map((p) => {
        const { name, Icon } = PARTS[p];
        return (
          <a key={p} href={links[p]} aria-current={section === p ? 'page' : undefined}>
            <Icon /><span className="hs-label">{name}</span>
            {section !== p && dot[p]}
          </a>
        );
      })}
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
  const { home } = useHome();
  const deciding = !move.status || (move.status.empty && old === undefined) || !home;
  // the parts turned on in Settings → Home Control
  const parts = SECTIONS.filter((m) => home?.modules?.[m] ?? STARTS_ON[m]);

  const asked = sectionOf(hash);
  const section = moving ? 'heating' : parts.includes(asked) ? asked : parts[0] || 'heating';
  // a page of a part that's turned off: go to the part that's on (staying in Settings, e.g. after
  // turning that part off from Settings → General)
  useEffect(() => {
    if (!home || moving || section === asked) return;
    const m = /\/settings(?:\/([^/]+))?/.exec(hash || '');
    const general = m?.[1] && GENERAL.some((g) => g.id === m[1]) ? `/${m[1]}` : '';
    window.location.replace(m ? `${SETTINGS_MENU[section].base}${general}` : HOME[section]);
  }, [home, moving, section, asked, hash]);
  // Coming back to a section returns to the page you were last on there.
  const last = useRef({ ...HOME });
  last.current[section] = hash && hash !== '#' ? hash : HOME[section];

  useLayoutEffect(() => {
    document.body.classList.toggle('sec-heating', section === 'heating');
    // cameras are built on the lighting look, and Wi-Fi and Energy on the cameras' (chips, lists)
    document.body.classList.toggle('sec-lighting', ['lighting', 'cameras', 'wifi', 'energy'].includes(section));
    document.body.classList.toggle('sec-cameras', ['cameras', 'wifi', 'energy'].includes(section));
    document.body.classList.toggle('sec-wifi', section === 'wifi');
    document.body.classList.toggle('sec-energy', section === 'energy');
    document.title = PARTS[section]?.name || 'Home';
  }, [section]);

  const switcher = (status) => <SectionSwitch section={section} links={last.current} parts={parts} {...status} />;
  if (deciding) return null;
  if (moving) return <MoveScreen status={move.status} old={old} />;
  return (
    <>
      <MovedBanner status={move.status} onDone={move.reload} />
      {parts.includes('heating') && (
        <div hidden={section !== 'heating'}>
          <HeatingBoundary><HeatingApp active={section === 'heating'} switcher={switcher} /></HeatingBoundary>
        </div>
      )}
      {parts.includes('lighting') && (
        <div hidden={section !== 'lighting'}>
          <LightingBoundary><LightingApp active={section === 'lighting'} switcher={switcher} /></LightingBoundary>
        </div>
      )}
      {parts.includes('cameras') && (
        <div hidden={section !== 'cameras'}>
          <LightingBoundary><CamerasApp active={section === 'cameras'} switcher={switcher} /></LightingBoundary>
        </div>
      )}
      {parts.includes('wifi') && (
        <div hidden={section !== 'wifi'}>
          <LightingBoundary><WifiApp active={section === 'wifi'} switcher={switcher} /></LightingBoundary>
        </div>
      )}
      {parts.includes('energy') && (
        <div hidden={section !== 'energy'}>
          <LightingBoundary><EnergyApp active={section === 'energy'} switcher={switcher} /></LightingBoundary>
        </div>
      )}
    </>
  );
}
