// One Away for the whole house.
//
// The heating's Away (and its "away automatically" from people's phones) is the master:
// - heating goes to Away (by hand or automatically)  -> lights go to Away (lived-in pattern)
// - heating comes back to Schedules from Away        -> lights back to schedules
// - Away / Schedules picked on the Lighting page      -> heating follows, unless it's switched Off
// - heating switched Off (e.g. for summer)            -> lights stay as they are, and while it's off
//   the same people/delay/distance settings still switch the lights to Away and back.
export function createHouse({ log }) {
  let heating = null; let lighting = null;
  let lastHeatMode = null;
  const st = { emptySince: null, suppress: false, lightAway: false };

  const hrt = () => heating.store.data.runtime;
  const presenceSettings = () => heating.store.data.settings.presence || {};

  function lightingTo(mode, reason) {
    const l = lighting.engine;
    if (lighting.store.data.paused || l.data.mode === mode) return;
    l.setMode(mode, { reason, auto: true });
  }

  function onHeatingChange() {
    const mode = hrt().mode;
    if (mode === lastHeatMode) return;
    const prev = lastHeatMode; lastHeatMode = mode;
    if (prev == null) return; // first look at startup: nothing changed
    if (mode === 'away') {
      st.lightAway = true;
      lightingTo('away', hrt().presenceAway ? 'Everyone is out.' : 'Heating set to Away.');
    } else if (mode === 'auto' && prev === 'away') {
      st.lightAway = false;
      lightingTo('schedule', 'Heating back on schedules.');
    }
  }

  /** Away or Schedules picked on the Lighting page. */
  function setFromLighting(mode, reason = null) {
    const l = lighting.engine;
    if (mode === 'off') { l.setMode('off'); return; } // older scripts: "off" means All off, a one-press action
    if (!['schedule', 'away'].includes(mode)) { l.setMode(mode); return; } // lets lighting refuse it in plain words
    l.setMode(mode, { reason });
    st.lightAway = false;
    const heatMode = hrt().mode;
    const want = mode === 'away' ? 'away' : 'auto';
    if (heatMode !== 'off' && heatMode !== want) {
      lastHeatMode = want; // we're making this change; don't echo it back
      heating.engine.setMode(want, null, { by: 'user' });
      l.addActivity(mode === 'away' ? 'The heating is on Away too.' : 'The heating is back on schedules too.');
    }
    // picked by hand while everyone's out: don't switch straight back to Away
    if (mode === 'schedule' && everyoneOut()) st.suppress = true;
  }

  function people() {
    try { return heating.engine.presenceView(); } catch { return []; }
  }
  function everyoneOut() {
    const p = presenceSettings();
    const list = people();
    return !!p.enabled && list.length > 0 && !list.some((x) => x.home);
  }

  /** Lights follow people even while the heating is switched off (e.g. all summer). */
  function check() {
    if (!heating || !lighting || lighting.store.data.paused) return;
    const p = presenceSettings();
    if (!p.enabled) return;
    const list = people();
    if (!list.length) return;
    const near = Number(p.nearMiles) || 2;
    const back = list.find((x) => x.home) || list.find((x) => x.miles != null && x.miles <= near);
    if (back) {
      st.emptySince = null;
      st.suppress = false;
      if (st.lightAway && lighting.engine.data.mode === 'away' && hrt().mode !== 'away') {
        st.lightAway = false;
        lightingTo('schedule', back.home ? `${back.name} is home.` : `${back.name} is on the way home.`);
      }
      return;
    }
    if (hrt().mode !== 'off') { st.emptySince = null; return; } // the heating's own presence check is in charge
    st.emptySince ??= Date.now();
    const waited = Date.now() - st.emptySince >= (Number.isFinite(Number(p.delayMinutes)) ? Number(p.delayMinutes) : 15) * 60000;
    if (waited && !st.suppress && lighting.engine.data.mode === 'schedule') {
      st.lightAway = true;
      lightingTo('away', 'Everyone is out.');
    }
  }

  function view() {
    if (!heating) return null;
    const p = presenceSettings();
    const list = p.enabled ? people() : [];
    let heatingOn = false;
    try { heatingOn = !!heating.engine.boilerView().on; } catch { /* no boiler chosen yet */ }
    return {
      heatingMode: hrt().mode,
      heatingOn,
      dashboardPath: heating.store.data.settings.dashboardPath || '/',
      panel: api.panel?.() || null, // where this app is in Home Assistant, for dashboard buttons
      presence: { enabled: !!p.enabled, delay: Number.isFinite(Number(p.delayMinutes)) ? Number(p.delayMinutes) : 15, home: list.filter((x) => x.home).map((x) => x.name), allOut: everyoneOut() },
    };
  }

  function attach(h, l) {
    heating = h; lighting = l;
    l.engine.modeRequest = (mode, reason) => setFromLighting(mode, reason); // lighting_control_mode events from Home Assistant
    lastHeatMode = hrt().mode;
    heating.engine.on('change', () => { onHeatingChange(); lighting.engine.changed(); });
    setInterval(check, 30000);
  }

  const api = { attach, setFromLighting, view, check, state: st, panel: null };
  return api;
}
