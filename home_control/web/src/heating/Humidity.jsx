// Humidity: each room's reading, and what it means for damp and condensation (the room card's line,
// the room page's section, and the Insights check). The sums are on the server (heating/humidity.js).
import { deg } from './lib.js';
import { Icon } from './ui.jsx';

export const pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
export const LEVEL = { dry: 'Dry', ok: 'Comfortable', humid: 'Humid', damp: 'Very humid' };
export const VERDICT = { mould: 'Mould risk', watch: 'Damp at times', fine: 'Fine' };

/** The room card's flag: damp at its coldest spots this week, or the windows running wet now. */
export function dampFlag(h) {
  if (!h) return null;
  if (h.week?.verdict === 'mould') return { text: 'Damp', title: `Its coldest spots averaged ${pct(h.week.coldAvg)} humid this week: enough for mould` };
  if (h.windows) return { text: 'Condensation', title: 'The windows are likely to be running wet' };
  return null;
}

/** "62% humidity" under the room card's temperature, with its flag. */
export function HumidityLine({ h }) {
  if (!h) return null;
  const flag = dampFlag(h);
  return (
    <span className={`hum-line lv-${h.level}`}>
      <Icon.drop />{pct(h.now)} humidity
      {flag && <b className="damp-flag" title={flag.title}>{flag.text}</b>}
    </span>
  );
}

function whereFrom(h) {
  if (h.fromTrvs) return 'its radiators’ own readings';
  return `${h.name || h.entity}${h.auto ? ', found on the thermometer’s device' : ''}`;
}

/** The room page: what the humidity is, what it means this week, and what to do about it. */
export function HumiditySection({ z, onSettings }) {
  const h = z.humidity;
  if (!h) return null;
  const w = h.week;
  const cs = h.coldSpot;
  const verdict = w?.verdict;
  const worry = verdict === 'mould' || verdict === 'watch' || h.level === 'damp' || h.windows;
  return (
    <>
      <h3>Humidity</h3>
      <div className="hum-now">
        <span className="hum-big num">{pct(h.now)}</span>
        <span className={`hum-level lv-${h.level}`}>{LEVEL[h.level]}</span>
        {h.dew != null && <span className="hum-dew">dew point {deg(h.dew)}</span>}
      </div>
      <p className="lede">
        {h.level === 'dry' && 'Dry: the heating drying cold winter air. Nothing to do unless it bothers you (dry throats, static).'}
        {h.level === 'ok' && '40 to 60% is comfortable, and too dry for mould and dust mites.'}
        {h.level === 'humid' && 'A little above the comfortable 40 to 60%.'}
        {h.level === 'damp' && 'Well above the comfortable 40 to 60%.'}
        {cs && <> With {deg(h.out)} outside, the coldest bits of wall (corners, round the windows, behind furniture) will be about {deg(cs.temp)}, so the air against them is about {pct(cs.rh)} humid{cs.rh >= 80 ? ': damp enough for mould if it stays like that' : ''}.</>}
        {h.windows && <> Expect condensation on the windows: the glass is about {deg(h.glass)}, below the dew point.</>}
      </p>
      {w && (
        <div className={`hum-week v-${verdict}`}>
          <p>
            <b className="hum-verdict">{verdict === 'fine' ? 'No damp to worry about' : VERDICT[verdict]}</b>
            Over the last {w.days >= 6.5 ? 'week' : `${Math.round(w.days)} days`} it averaged {pct(w.avgRh)}
            {w.coldAvg != null
              ? <>, and its coldest spots about {pct(w.coldAvg)}{w.overHours > 0 ? <>, over 80% for {w.perDay >= 1 ? `about ${Math.round(w.perDay)} hours a day` : `${w.overHours} hour${w.overHours === 1 ? '' : 's'} in all`}{w.night >= 0.6 ? ', mostly overnight' : ''}</> : ''}.</>
              : '.'}
            {verdict === 'mould' && ' Mould grows where the air against a surface stays at 80% or more, so expect it in corners and round the windows.'}
            {verdict === 'watch' && ' Not enough for mould on its own, but worth keeping down.'}
          </p>
        </div>
      )}
      {worry && (
        <ul className="hum-tips">
          <li><b>Air it</b> with the window wide open for 10 to 15 minutes, best in the morning. A short blast loses less heat than a window on the latch all day.</li>
          <li><b>Showers and cooking:</b> door shut, extractor on, and keep it going for a few minutes after.</li>
          <li><b>Washing:</b> dry it outside or in a tumble dryer if you can. A dehumidifier brings it down fastest.</li>
          <li><b>Furniture:</b> leave a gap between wardrobes and outside walls so air reaches them.</li>
          {w?.warmerAvg != null && (verdict === 'mould' || verdict === 'watch') && <li><b>Warmth:</b> keeping it a degree warmer would bring its coldest spots to about {pct(w.warmerAvg)}.</li>}
        </ul>
      )}
      <p className="hum-src">From {whereFrom(h)}. <button type="button" className="btn link" onClick={onSettings}>Change</button></p>
    </>
  );
}

/** Insights: each room with humidity, its week, and its verdict. */
export function DampCheck({ state }) {
  const rooms = state.zones.filter((z) => z.enabled && z.humidity);
  if (!rooms.length) return null;
  const flagged = rooms.filter((z) => z.humidity.week?.verdict === 'mould' || z.humidity.week?.verdict === 'watch');
  return (
    <section className="chart-card">
      <div className="chart-head"><h2>Damp and condensation</h2></div>
      <p className="chart-explain">
        What matters for mould is how humid the air is against the coldest bits of wall (corners, round the windows), which are colder than the room, more so the colder it is outside.
        Mould grows where that stays at 80% or more. Worked out from each room's humidity and temperature and the outside temperature, every half hour.
      </p>
      {flagged.length > 0 && (
        <ul className="callouts">
          {flagged.map((z) => {
            const w = z.humidity.week;
            return <li key={z.id}><b>{z.name}:</b> {w.verdict === 'mould' ? 'mould risk' : 'damp at times'}, its coldest spots averaging {pct(w.coldAvg ?? w.avgRh)}{w.night >= 0.6 ? ', worst overnight' : ''}. Airing it each morning helps most{w.warmerAvg != null ? `; a degree warmer would bring it to about ${pct(w.warmerAvg)}` : ''}.</li>;
          })}
        </ul>
      )}
      <div className="table-wrap">
        <table className="data-table league">
          <thead><tr><th>Room</th><th>Now</th><th>Week average</th><th>Coldest spots</th><th>Over 80%</th><th>Damp</th></tr></thead>
          <tbody>
            {rooms.map((z) => {
              const h = z.humidity; const w = h.week;
              return (
                <tr key={z.id}>
                  <td data-label="Room">{z.name}</td>
                  <td data-label="Now">{pct(h.now)}{h.windows && <small className="cell-note">windows wet</small>}</td>
                  <td data-label="Week average">{w ? pct(w.avgRh) : <span className="muted">gathering</span>}</td>
                  <td data-label="Coldest spots">{w?.coldAvg != null ? pct(w.coldAvg) : '–'}</td>
                  <td data-label="Over 80%">{w?.perDay != null ? (w.overHours ? `${w.perDay >= 1 ? Math.round(w.perDay) : w.perDay} h a day` : 'never') : '–'}</td>
                  <td data-label="Damp" className={w ? `v-${w.verdict}` : ''}>{w ? VERDICT[w.verdict] : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
