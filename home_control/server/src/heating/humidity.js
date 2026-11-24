// Humidity: where each room's reading comes from, and what it means for damp and condensation.
//
// What matters for mould isn't so much the room's humidity as how humid the air is right against
// the coldest bits of wall (corners, round the windows, behind wardrobes): the same air is more
// humid there because it's colder, and the colder it is outside, the colder they are. Mould grows
// where the air at a surface stays at about 80% or more (BS 5250, BS EN ISO 13788: a monthly
// average of 80% at the surface). Those cold spots are taken as three quarters of the way from
// outside to the room's temperature (BRE's temperature factor of 0.75, the least a sound wall in a
// home should manage; older houses can be worse), and the glass of older double glazing at 0.65.

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const BAD = new Set(['unavailable', 'unknown']);
const localDate = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const r1 = (x) => Math.round(x * 10) / 10;
const mean = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : null);

export const MOULD_RH = 80;      // % at a surface, kept up, where mould grows
export const COLD_SPOT_F = 0.75; // the coldest bits of a sound wall
export const GLASS_F = 0.65;     // the glass of older double glazing (newer is warmer, its edges colder)

const esat = (t) => 6.112 * Math.exp((17.62 * t) / (243.12 + t)); // water vapour at saturation, hPa (Magnus)

/** The temperature the room's air would start to condense at. */
export function dewPoint(temp, rh) {
  if (temp == null || rh == null || rh <= 0) return null;
  const g = Math.log(Math.min(rh, 100) / 100) + (17.62 * temp) / (243.12 + temp);
  return (243.12 * g) / (17.62 - g);
}

/** A surface's temperature: f of the way from outside to the room (1: as warm as the room). */
export const surfaceTemp = (temp, out, f) => out + f * (temp - out);

/** How humid the room's air is against the coldest spots (warmer: the room that many degrees warmer, the same moisture). */
export function coldSpotRh(temp, rh, out, { warmer = 0, f = COLD_SPOT_F } = {}) {
  if (temp == null || rh == null || out == null) return null;
  if (out >= temp) return Math.min(100, rh); // (no colder than the room)
  const e = (rh / 100) * esat(temp);
  return Math.min(100, (100 * e) / esat(surfaceTemp(temp + warmer, out, f)));
}

/** The room's humidity on its own: under 40% dry, up to 60% comfortable, up to 70% humid, then very humid. */
export const levelOf = (rh) => (rh == null ? null : rh < 40 ? 'dry' : rh < 60 ? 'ok' : rh < 70 ? 'humid' : 'damp');

/** What the humidity means now: its level, the dew point, and whether the windows will be running wet. */
export function humidityNow({ temp, rh, out }) {
  if (rh == null) return null;
  const dew = temp != null ? dewPoint(temp, rh) : null;
  const res = { now: r1(rh), level: levelOf(rh), dew: dew == null ? null : r1(dew), out: out ?? null, glass: null, windows: false, coldSpot: null };
  if (temp != null && out != null && out < temp) {
    const glass = surfaceTemp(temp, out, GLASS_F);
    res.glass = r1(glass);
    res.windows = dew != null && glass <= dew;
    res.coldSpot = { temp: r1(surfaceTemp(temp, out, COLD_SPOT_F)), rh: Math.round(coldSpotRh(temp, rh, out)) };
  }
  return res;
}

/**
 * The last week, from the half-hourly figures [{ at, temp, rh, out }]: how humid the room was, and
 * how damp its coldest spots got. verdict: 'mould' (the cold spots averaged 80% or more: mould will
 * grow), 'watch' (70% or more, or over 80% for four hours or more a day), 'fine'. Needs a day and a
 * half of figures.
 */
export function dampWeek(points, { tz = 'UTC', minHours = 36 } = {}) {
  const ok = points.filter((p) => p.rh != null);
  if (ok.length / 2 < minHours) return null;
  const days = ok.length / 48;
  const res = { hours: ok.length / 2, avgRh: Math.round(mean(ok.map((p) => p.rh))), coldAvg: null, overHours: null, perDay: null, warmerAvg: null, night: null, verdict: null };
  const withOut = ok.filter((p) => p.out != null && p.temp != null);
  if (withOut.length / 2 < minHours) {
    // nothing for outside: the room's own humidity
    res.verdict = res.avgRh >= 70 ? 'mould' : res.avgRh >= 60 ? 'watch' : 'fine';
    return res;
  }
  const cold = withOut.map((p) => coldSpotRh(p.temp, p.rh, p.out));
  const over = withOut.filter((_, k) => cold[k] >= MOULD_RH);
  const hour = (t) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
  res.coldAvg = Math.round(mean(cold));
  res.overHours = Math.round(over.length / 2);
  res.perDay = r1(over.length / 2 / (withOut.length / 48));
  // a degree warmer, with the same moisture in the air
  res.warmerAvg = Math.round(mean(withOut.map((p) => coldSpotRh(p.temp, p.rh, p.out, { warmer: 1 }))));
  // mostly overnight (22:00–08:00)?
  if (over.length >= 4) res.night = Math.round((over.filter((p) => { const h = hour(p.at); return h >= 22 || h < 8; }).length / over.length) * 100) / 100;
  res.verdict = res.coldAvg >= MOULD_RH ? 'mould' : res.coldAvg >= 70 || res.perDay >= 4 ? 'watch' : 'fine';
  res.days = Math.round(days * 10) / 10;
  res.lastDay = localDate(ok[ok.length - 1].at, tz);
  return res;
}

/** The cold spots' humidity alongside a chart's room temperatures, humidity and outside. */
export function coldSeries(temps, rhs, outs) {
  return (rhs || []).map((rh, k) => {
    const v = coldSpotRh(temps?.[k] ?? null, rh, outs?.[k] ?? null);
    return v == null ? null : Math.round(v);
  });
}

/** A Home Assistant humidity sensor. */
export const isHumiditySensor = (id, st) => id.startsWith('sensor.')
  && (st?.attributes?.device_class === 'humidity' || (/humid/i.test(id) && st?.attributes?.unit_of_measurement === '%'));

/**
 * The humidity sensor that goes with a thermometer: on the same device (most temperature and
 * humidity monitors are one device with two sensors), or named the same way (sensor.lounge_temperature
 * and sensor.lounge_humidity).
 */
export function findHumidity(ha, sensorId) {
  if (!sensorId) return null;
  const any = isHumiditySensor;
  const same = ha.companionFor?.(sensorId, any);
  if (same) return same;
  const stem = sensorId.split('.')[1].replace(/(^|_)(temperature|temp)(_|$)/, '$1').replace(/_+$/, '');
  if (stem.length < 3) return null;
  const exact = `sensor.${stem}_humidity`;
  if (ha.states.has(exact) && any(exact, ha.states.get(exact))) return exact;
  for (const [id, st] of ha.states) if (id.startsWith(`sensor.${stem}_`) && any(id, st)) return id;
  return null;
}

/** A humidity reading from a history row (a sensor's state, or a thermostat's current_humidity). */
export const humidOf = (id) => (r) => {
  if (BAD.has(r.s)) return null;
  if (id.startsWith('climate.')) return num(r.a?.current_humidity);
  return num(r.s);
};

/** A humidity reading now. */
export function readHumidity(ha, id) {
  const st = ha.get(id);
  if (!st || BAD.has(st.state)) return null;
  const v = id.startsWith('climate.') ? num(st.attributes?.current_humidity) : num(st.state);
  return v != null && v >= 0 && v <= 100 ? v : null;
}
