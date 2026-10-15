// Seed the running app (against the mock) with a realistic house. Run after dev/run.sh on empty dev/data.
// LIGHTING_API=http://localhost:8098/api/ seeds the old standalone Lighting Control app instead (lights only).
const APP = process.env.LIGHTING_API || 'http://localhost:8099/api/lighting/';
const LIGHTS_ONLY = !!process.env.LIGHTING_API;
const HEAT = 'http://localhost:8099/api/';
const j = async (m, p, b) => {
  const r = await fetch(APP + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const days = (fn) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, fn(d)]));
const weekday = (d) => d < 5;

await j('PUT', 'settings', { graceSeconds: 8 });
const groups = [
  { name: 'Lounge', devices: ['light.lounge_ceiling', 'light.lounge_lamp', 'switch.lounge_uplighter_plug'], livedIn: true },
  { name: 'Kitchen', devices: ['light.kitchen_spots', 'light.kitchen_under_cabinet'] },
  { name: 'Hallway', devices: ['light.hallway', 'light.landing'], motion: { entity: 'binary_sensor.hallway_motion', minutes: 3, brightness: 60 }, lux: { entity: 'sensor.hallway_illuminance', threshold: 40 } },
  { name: 'Bedroom', devices: ['light.bedroom_ceiling', 'light.bedside_left', 'light.bedside_right'] },
  { name: 'Christmas lights', devices: ['switch.christmas_tree_plug', 'switch.garden_festoon_socket'] },
  { name: 'Office', devices: ['light.office_desk'] },
];
for (const g of groups) await j('POST', 'groups', g);

await j('PUT', 'schedules/lounge', { week: days(() => [
  { time: '07:00', on: true, brightness: 60, kelvin: 3500 },
  { time: '09:00', on: false },
  { anchor: 'sunset', offset: -30, on: true, brightness: 70, kelvin: 2700, fade: 300 },
  { time: '21:30', on: true, brightness: 35, kelvin: 2200, fade: 900 },
  { time: '23:30', on: false, fade: 60 },
]) } );
await j('PUT', 'schedules/kitchen', { week: days((d) => [
  { time: weekday(d) ? '06:45' : '08:00', on: true, brightness: 90, kelvin: 4500 },
  { time: weekday(d) ? '08:30' : '10:30', on: false },
  { anchor: 'sunset', offset: 0, on: true, brightness: 80, kelvin: 3500 },
  { time: '22:30', on: false },
]) });
await j('PUT', 'schedules/hallway', { week: days(() => [
  { anchor: 'sunset', offset: 0, on: true, brightness: 40 },
  { time: '23:00', on: true, brightness: 10 },
  { time: '00:30', on: false },
]) });
await j('PUT', 'schedules/bedroom', { week: days((d) => [
  { time: weekday(d) ? '06:30' : '08:30', on: true, brightness: 70, kelvin: 4000, fade: 1800 },
  { time: weekday(d) ? '07:30' : '09:30', on: false },
  { time: '22:00', on: true, brightness: 30, kelvin: 2200, fade: 900 },
  { time: '23:15', on: false, fade: 300 },
]) });
await j('PUT', 'schedules/christmas-lights', { week: days(() => [
  { anchor: 'sunset', offset: -15, on: true },
  { time: '23:00', on: false },
]) });
await j('POST', 'scenes', { name: 'Film night', until: 'next', others: 'leave', groups: { lounge: { action: 'on', brightness: 20, kelvin: 2200 }, kitchen: { action: 'off' }, hallway: { action: 'on', brightness: 10 } } });
await j('PUT', 'scenes/goodnight', { name: 'Goodnight', until: 'morning', others: 'off', groups: { hallway: { action: 'on', brightness: 5, minutes: 10 } } });
await j('PUT', 'groups/christmas-lights', { name: 'Christmas lights', devices: ['switch.christmas_tree_plug', 'switch.garden_festoon_socket'], season: { from: '12-01', to: '01-06' } });
await j('PUT', 'groups/hallway', { name: 'Hallway', devices: ['light.hallway', 'light.landing'], motion: { entity: 'binary_sensor.hallway_motion', minutes: 3, brightness: 60, night: { brightness: 5, from: '23:00', to: '06:00' } }, lux: { entity: 'sensor.hallway_illuminance', threshold: 40 } });
if (LIGHTS_ONLY) await j('PUT', 'settings', { autoAway: true, autoAwayDelay: 10, stepSize: 5 });
if (!LIGHTS_ONLY) {
  // Heating: boiler, two rooms, Away automatically from phones (shared with the lights)
  const h = async (m, p, b) => {
    const r = await fetch(HEAT + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const d = await r.json();
    if (!r.ok) throw new Error(`${p}: ${d.error}`);
    return d;
  };
  const heatWeek = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ time: '06:30', temp: 20 }, { time: '09:00', temp: 17 }, { time: '17:00', temp: 21 }, { time: '22:30', temp: 16 }]]));
  await h('PUT', 'settings', { boiler: { entity: 'climate.heating', onTemp: 30, offTemp: 7, minOnMinutes: 0, minOffMinutes: 0 }, presence: { enabled: true, people: [], delayMinutes: 10, nearMiles: 2 } });
  await h('POST', 'zones', { name: 'Lounge', trvs: ['climate.lounge_trv'], sensor: 'sensor.lounge_temperature', schedule: heatWeek });
  await h('POST', 'zones', { name: 'Bedroom', trvs: ['climate.bedroom_trv'], schedule: heatWeek });
}
// Some lights on, so screenshots show the light colours.
await j('POST', 'groups/lounge/set', { on: true, brightness: 45, kelvin: 2200 });
await j('POST', 'groups/kitchen/set', { on: true, brightness: 90, kelvin: 4500 });
await j('POST', 'groups/office/set', { on: true, brightness: 100, kelvin: 6000 });
await new Promise((r) => setTimeout(r, 4000));
await fetch('http://localhost:8124/human', { method: 'POST', body: JSON.stringify({ entity: 'light.bedside_left', on: true, brightness: 20 }) });
console.log('seeded');
