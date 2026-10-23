// Saying when the integration behind the radiators and boiler (Hive) isn't working, and when it is again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationWatch } from '../../src/heating/integrations.js';

const M = 60000;
function setup({ entries, flows = [], unavailable = [], registry = true } = {}) {
  let now = Date.UTC(2026, 9, 23, 18, 30); // 19:30 in London
  const states = new Map([
    ['climate.main_bedroom', { state: 'heat', attributes: { friendly_name: 'Main bedroom' } }],
    ['climate.main_thermostat', { state: 'heat', attributes: { friendly_name: 'Main thermostat' } }],
    ['sensor.lounge_temperature', { state: '19.5', attributes: { friendly_name: 'Lounge temperature' } }],
  ]);
  for (const id of unavailable) states.get(id).state = 'unavailable';
  const info = { 'climate.main_bedroom': { entry: 'e_hive', platform: 'hive' }, 'climate.main_thermostat': { entry: 'e_hive', platform: 'hive' }, 'sensor.lounge_temperature': { entry: 'e_zha', platform: 'zha' } };
  const data = {
    entries: entries || [{ entry_id: 'e_hive', domain: 'hive', title: 'tom@example.com', state: 'loaded', reason: null, disabled_by: null }, { entry_id: 'e_zha', domain: 'zha', title: 'ZHA', state: 'loaded', disabled_by: null }],
    flows,
  };
  const alerts = [];
  const engine = {
    ha: {
      connected: true, timeZone: 'Europe/London',
      get: (id) => states.get(id),
      entityInfo: (id) => (registry ? info[id] || null : null),
      send: async ({ type, integration }) => {
        if (type === 'config_entries/get') return data.entries;
        if (type === 'config_entries/flow/progress') return data.flows;
        if (type === 'manifest/get') return { hive: { name: 'Hive' }, zha: { name: 'Zigbee Home Automation' } }[integration];
        throw new Error('unknown');
      },
    },
    zones: [
      { id: 'z1', name: 'Main Bedroom', enabled: true, trvs: ['climate.main_bedroom'], sensor: null },
      { id: 'z2', name: 'Lounge', enabled: true, trvs: [], sensor: 'sensor.lounge_temperature' },
    ],
    s: { boiler: { entity: 'climate.main_thermostat' } },
    rt: {},
    store: { save() {} },
    integrationAlert: (a) => alerts.push(a),
  };
  const w = new IntegrationWatch({ engine, now: () => now });
  return { w, data, states, alerts, tick: (mins) => { now += mins * M; } };
}

test('working: nothing to say', async () => {
  const { w, alerts } = setup();
  assert.deepEqual(await w.check(), []);
  assert.equal(alerts.length, 0);
  assert.deepEqual(w.problems(), []);
});

test('Hive failed to set up: told after a minute, with what to do; and again when it\'s working', async () => {
  const { w, data, states, alerts, tick } = setup();
  data.entries[0].state = 'setup_error';
  states.get('climate.main_bedroom').state = 'unavailable';
  states.get('climate.main_thermostat').state = 'unavailable';
  const found = await w.check();
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'failed');
  assert.equal(alerts.length, 0, 'not straight away: it must still be so at the next look');
  tick(1);
  await w.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'broken');
  assert.equal(alerts[0].text, 'Hive isn\'t working in Home Assistant: it failed to set up, since 19:30. Home Control can\'t change Main bedroom and the boiler until it\'s fixed: try Reload on Hive (Settings → Devices & services → Hive), and look at its log for why. Until then they stay as they were: in the Hive app, put the thermostat and radiators back on Schedule so Hive heats the house meanwhile.');
  const [p] = w.problems();
  assert.equal(p.domain, 'hive');
  assert.equal(w.covers('climate.main_bedroom'), true, 'its own "offline" notice is left out');
  assert.equal(w.covers('sensor.lounge_temperature'), false);
  tick(5);
  await w.check();
  assert.equal(alerts.length, 1, 'told once');
  // fixed
  data.entries[0].state = 'loaded';
  states.get('climate.main_bedroom').state = 'heat';
  states.get('climate.main_thermostat').state = 'heat';
  tick(1);
  await w.check();
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].kind, 'fixed');
  assert.equal(alerts[1].text, 'Hive is working again in Home Assistant, so Home Control is looking after Main bedroom and the boiler again.');
  assert.deepEqual(w.problems(), []);
});

test('signing in again; retrying only after ten minutes; turned off', async () => {
  let s = setup({ flows: [{ flow_id: 'f1', handler: 'hive', context: { source: 'reauth', entry_id: 'e_hive' } }] });
  s.data.entries[0].state = 'setup_error';
  await s.w.check(); s.tick(1); await s.w.check();
  assert.equal(s.alerts[0].rec.kind, 'signin');
  assert.match(s.alerts[0].text, /^Hive needs signing in again in Home Assistant \(Settings → Devices & services → Hive\)/);

  s = setup();
  s.data.entries[0].state = 'setup_retry';
  await s.w.check(); s.tick(9); await s.w.check();
  assert.equal(s.alerts.length, 0, 'it retries briefly as Home Assistant starts');
  s.tick(1.5); await s.w.check();
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].text, /^Hive can't connect in Home Assistant and has been retrying since 19:30\./);
  // it recovers before ever being told: nothing said either way
  s = setup();
  s.data.entries[0].state = 'setup_retry';
  await s.w.check(); s.tick(3);
  s.data.entries[0].state = 'loaded';
  await s.w.check();
  assert.equal(s.alerts.length, 0);

  s = setup();
  Object.assign(s.data.entries[0], { state: 'not_loaded', disabled_by: 'user' });
  await s.w.check(); s.tick(1); await s.w.check();
  assert.match(s.alerts[0].text, /^Hive is turned off in Home Assistant/);
});

test('loaded, but every device unavailable for a quarter of an hour; one still there is fine', async () => {
  let s = setup({ unavailable: ['climate.main_bedroom', 'climate.main_thermostat'] });
  await s.w.check(); s.tick(14); await s.w.check();
  assert.equal(s.alerts.length, 0);
  s.tick(1.5); await s.w.check();
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].text, /^Every Hive device Home Control uses has been unavailable in Home Assistant since 19:30 \(Main bedroom and the boiler\)\. Hive's servers or its hub may be down: check the Hive app\./);
  s = setup({ unavailable: ['climate.main_bedroom'] });
  await s.w.check(); s.tick(30); await s.w.check();
  assert.equal(s.alerts.length, 0, 'just one radiator offline: that\'s its own notice');
});

test('without the registry (not allowed): nothing guessed', async () => {
  const s = setup({ registry: false });
  s.data.entries[0].state = 'setup_error';
  await s.w.check(); s.tick(5); await s.w.check();
  assert.equal(s.alerts.length, 0);
});
