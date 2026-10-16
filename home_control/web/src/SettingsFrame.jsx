// The Settings menu, the same in every part of Home Control: General (for the whole app) at the
// top, then a group for each part that's on. On a wide screen the menu sits on the left with one
// page of settings beside it; on a phone the menu is a list, and each page opens on its own with
// a way back. Each part renders its own pages inside this, in its own look; a page in another part
// is a link into that part's Settings.
import { useEffect, useRef, useState } from 'react';
import { GENERAL, HomeSettings, ICON, useHome } from './HomeSettings.jsx';

// every page of settings, by part, in menu order
export const SETTINGS_MENU = {
  heating: {
    name: 'Heating', base: '#/settings', items: [
      { id: 'rooms', label: 'Rooms' },
      { id: 'boiler', label: 'Boiler' },
      { id: 'temperatures', label: 'Temperatures' },
      { id: 'early', label: 'Warm by the scheduled time' },
      { id: 'windows', label: 'Open windows' },
      { id: 'behaviour', label: 'How it behaves' },
      { id: 'alerts', label: 'Phone alerts' },
      { id: 'cards', label: 'Room cards' },
      { id: 'sources', label: 'Gas cost and outside' },
      { id: 'history', label: 'History' },
    ],
  },
  lighting: {
    name: 'Lighting', base: '#/lighting/settings', items: [
      { id: 'groups', label: 'Groups' },
      { id: 'scenes', label: 'Scenes' },
      { id: 'behaviour', label: 'How it behaves' },
      { id: 'away', label: 'Away' },
      { id: 'sun', label: 'Sunrise and sunset' },
      { id: 'start', label: 'Getting started' },
    ],
  },
  cameras: {
    name: 'Cameras', base: '#/cameras/settings', items: [
      { id: 'cameras', label: 'Cameras' },
      { id: 'phones', label: 'Phones to alert' },
      { id: 'offline', label: 'Offline cameras' },
      { id: 'recordings', label: 'Recordings' },
    ],
  },
  wifi: {
    name: 'Wi-Fi', base: '#/wifi/settings', items: [
      { id: 'leds', label: 'Status lights at night' },
      { id: 'clients', label: 'Connected devices' },
      { id: 'networks', label: 'Network schedules' },
      { id: 'aps', label: 'Access points' },
      { id: 'kinds', label: 'What each device is' },
    ],
  },
};
const PARTS = ['heating', 'lighting', 'cameras', 'wifi'];
const STARTS_ON = { heating: true, lighting: true, cameras: false, wifi: false };
const isGeneral = (id) => GENERAL.some((g) => g.id === id);

/**
 * Which page of a part's settings to show, from the address (e.g. 'boiler' in #/settings/boiler).
 * `item` is the page asked for (null for the menu itself), `shown` the one to show beside the menu
 * on a wide screen (the part's first page when none was asked for).
 */
export function settingsPage(part, arg) {
  const own = SETTINGS_MENU[part].items;
  const item = arg && (isGeneral(arg) || own.some((i) => i.id === arg)) ? arg : null;
  return { item, shown: item || own[0].id, general: isGeneral(item) };
}

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const Sliders = () => <svg viewBox="0 0 24 24" {...P}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>;
const Chevron = () => <svg viewBox="0 0 24 24" {...P} className="setf-chev"><path d="m9 6 6 6-6 6" /></svg>;
const Back = () => <svg viewBox="0 0 24 24" {...P}><path d="m15 6-6 6 6 6" /></svg>;

/** The menu and one page of settings. `children` is the page, rendered by the part. */
export function SettingsFrame({ part, item, shown, status, children }) {
  const { home } = useHome();
  const parts = PARTS.filter((p) => home?.modules?.[p] ?? STARTS_ON[p]);
  const base = SETTINGS_MENU[part].base;
  const current = item || shown;
  const groups = [
    { id: 'general', name: 'General', icon: <Sliders />, items: GENERAL.map((g) => ({ ...g, href: `${base}/${g.id}`, here: current === g.id })) },
    ...parts.map((p) => ({
      id: p, name: SETTINGS_MENU[p].name, icon: ICON[p],
      items: SETTINGS_MENU[p].items.map((i) => ({ ...i, href: `${SETTINGS_MENU[p].base}/${i.id}`, here: p === part && current === i.id })),
    })),
  ];
  const here = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.name }))).find((i) => i.here);
  // on a wide screen the other parts' groups fold away until opened (a phone's list shows them all)
  const [open, setOpen] = useState(() => new Set(['general', part]));
  const flip = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // a new page starts at the top
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.scrollTo({ top: 0 });
  }, [part, item]);

  return (
    <div className={`setf ${item ? 'setf-on-page' : 'setf-on-menu'}`}>
      <div className="setf-head">
        <a className="setf-back" href={base}><Back />All settings</a>
        <h2 className="setf-title">Settings</h2>
        {here && <span className="setf-where">{here.group}</span>}
        {status && <span className="setf-status" role="status">{status}</span>}
      </div>
      <div className="setf-body">
        <nav className="setf-nav" aria-label="Settings">
          {groups.map((g) => (
            <div className={`setf-group${open.has(g.id) ? '' : ' setf-shut'}`} key={g.id}>
              <h3>
                <button type="button" aria-expanded={open.has(g.id)} aria-controls={`setf-${g.id}`} onClick={() => flip(g.id)}>
                  <span className="setf-icon">{g.icon}</span><span className="setf-gname">{g.name}</span><Chevron />
                </button>
              </h3>
              <ul id={`setf-${g.id}`}>
                {g.items.map((i) => (
                  <li key={i.id}>
                    <a href={i.href} aria-current={i.here ? 'page' : undefined}><span>{i.label}</span><Chevron /></a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="setf-page">
          {isGeneral(current) ? <HomeSettings item={current} /> : children}
        </div>
      </div>
    </div>
  );
}
