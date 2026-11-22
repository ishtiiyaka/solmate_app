// Charts tab (Weeks 4-5): history chart, daily energy and tracking gain, sun-path plot, CSV export/import, demo data.
import { $, state, dev, on, emit, confirmDlg, toast, download } from './core.js';
import * as H from './history.js';
import { lineChart, barChart, attachHover, COLORS } from './charts.js';
import { dailySummary, totalGain, toCSV, parseCSV, rowsToSamples, SAMPLE_COLS } from './analysis.js';
import { sunPath, sunTimes, solarPosition } from './sun.js';
import { makeDemo } from './demodata.js';

const active = () => $('tab-hist').classList.contains('active');
const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: state.settings.location.tz });
const fmt = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '--');
let mainChart = null;

export function initHistoryView() {
  $('hEvery').value = String(state.histEvery);
  $('hEvery').onchange = () => { state.histEvery = Number($('hEvery').value); localStorage.setItem('solmate.histEvery', state.histEvery); };
  $('hKeep').value = String(H.keepDays()); $('hKeep').onchange = () => localStorage.setItem('solmate.keepDays', $('hKeep').value);
  ['hRange', 'hMetric', 'sunDay'].forEach((id) => { $(id).onchange = refreshHistory; });
  $('hCsv').onclick = exportCsv; $('hDaily').onclick = exportDaily; $('hFile').onchange = importCsv;
  $('hDemo').onclick = loadDemo; $('hDemoDel').onclick = deleteDemo;
  $('hClear').onclick = async () => { if (await confirmDlg('Delete history?', 'All stored samples on this device will be removed (events and the cleaning log are kept).', 'Delete')) { await H.clearStore('samples'); refreshHistory(); toast('History deleted'); } };
  setInterval(() => { if (active()) refreshHistory(); }, 30000);
  on('limits', () => { if (active()) refreshHistory(); });
}

const fromMs = () => { const h = $('hRange').value; return h === 'all' ? 0 : Date.now() - Number(h) * 3600000; };
const tz = () => state.settings.location.tz;

export async function refreshHistory() {
  if (!H.ready()) { $('hCount').textContent = 'storage not available'; return; }
  $('hCount').textContent = await H.count('samples');
  const b = await H.bounds(); $('hFrom').textContent = fmt(b.first); $('hTo').textContent = fmt(b.last);
  const rows = await H.range(fromMs());
  drawMain(rows); await drawDaily(); drawSun();
}

function drawMain(rows) {
  const m = $('hMetric').value; const long = $('hRange').value === 'all' || Number($('hRange').value) > 24;
  const pts = (k, scale = 1) => rows.filter((r) => typeof r[k] === 'number').map((r) => [r.ts, r[k] * scale]);
  let series = []; let yFmt = (v) => String(Math.round(v * 10) / 10);
  if (m === 'power') series = [{ name: 'Tracker W', color: COLORS.accent, pts: pts('p') }, { name: 'Fixed panel W', color: COLORS.blue, pts: pts('pf'), dashed: true }];
  else if (m === 'voltage') series = [{ name: 'Voltage V', color: COLORS.green, pts: pts('v') }];
  else if (m === 'current') series = [{ name: 'Current A', color: COLORS.purple, pts: pts('i') }];
  else if (m === 'temp') series = [{ name: 'Temperature C', color: COLORS.red, pts: pts('t') }];
  else if (m === 'irr') series = [{ name: 'Irradiance W/m2', color: COLORS.accent, pts: pts('g') }];
  else series = [{ name: 'Azimuth', color: COLORS.blue, pts: pts('az') }, { name: 'Elevation', color: COLORS.green, pts: pts('el') }];
  series = series.filter((s) => s.pts.length);
  const to = Date.now(); const xMin = rows.length ? Math.min(rows[0].ts, fromMs() || rows[0].ts) : to - 3600000;
  mainChart = lineChart($('cMain'), series, { h: 230, xMin: $('hRange').value === 'all' ? rows[0] && rows[0].ts : xMin, xMax: to, gapMs: 15 * 60000, yFmt,
    xFmt: (v) => (long ? new Date(v).toLocaleDateString([], { month: '2-digit', day: '2-digit', timeZone: tz() }) + ' ' + hhmm(v) : hhmm(v)), emptyText: 'No data in this range yet. Leave the app open, or load demo data below.' });
  attachHover($('cMain'), $('cTip'), mainChart);
}

async function drawDaily() {
  const span = Math.max(7 * 86400000, Date.now() - fromMs());
  const rows = dailySummary(await H.range(Date.now() - Math.min(span, 30 * 86400000)), tz());
  barChart($('cDaily'), rows.map((r) => r.date.slice(5)), [
    { name: 'Tracker Wh', color: COLORS.accent, values: rows.map((r) => r.eT) }, { name: 'Fixed panel Wh', color: COLORS.blue, values: rows.map((r) => (r.hasFixed ? r.eF : 0)) }], { h: 200, emptyText: 'No data yet' });
  const g = totalGain(rows);
  $('gainText').innerHTML = g ? `Tracking gain over ${g.days} day(s) with fixed-panel data: <b>${g.gain >= 0 ? '+' : ''}${g.gain.toFixed(1)} %</b> (tracker ${g.eT.toFixed(0)} Wh, fixed ${g.eF.toFixed(0)} Wh).`
    : 'No fixed-panel data yet. The gain needs a fixed_power_w reading from the comparison rig. Load demo data, or import a CSV that has a fixed_power_w column.';
  $('dailyList').innerHTML = rows.slice(-10).reverse().map((r) => `<tr><td>${r.date}</td><td>${r.eT.toFixed(0)}</td><td>${r.hasFixed ? r.eF.toFixed(0) : '--'}</td><td>${r.gain === null ? '--' : (r.gain >= 0 ? '+' : '') + r.gain.toFixed(1) + '%'}</td></tr>`).join('');
}

function drawSun() {
  const L = state.settings.location; const now = new Date(); const y = now.getUTCFullYear();
  const pick = $('sunDay').value;
  const day = pick === 'today' ? now : new Date(Date.UTC(y, pick === 'spring' ? 2 : pick === 'summer' ? 5 : 11, pick === 'spring' ? 20 : 21, 7, 0, 0));
  const path = sunPath(day, L.lat, L.lon, L.tz, 10); const times = sunTimes(path);
  const ctx = [['Summer (Jun 21)', COLORS.blue, new Date(Date.UTC(y, 5, 21, 7))], ['Winter (Dec 21)', COLORS.purple, new Date(Date.UTC(y, 11, 21, 7))]];
  const series = [{ name: pick === 'today' ? 'Today' : $('sunDay').selectedOptions[0].textContent, color: COLORS.accent, width: 3, pts: path.map((p) => [p.az, p.el]) },
    ...ctx.map(([name, color, d]) => ({ name, color, dashed: true, width: 1.5, pts: sunPath(d, L.lat, L.lon, L.tz, 20).map((p) => [p.az, p.el]) }))];
  const sunNow = solarPosition(now, L.lat, L.lon); const t = dev.tel; const markers = [];
  if (sunNow.el > 0) markers.push({ x: sunNow.az, y: sunNow.el, color: COLORS.accent, label: 'Sun' });
  if (t && typeof t.az_deg === 'number') markers.push({ x: t.az_deg, y: t.el_deg, color: COLORS.green, label: 'Tracker' });
  const all = series.flatMap((s) => s.pts.map((p) => p[0])); const ch = lineChart($('cSun'), series, { h: 240, xMin: Math.floor(Math.min(...all) / 10) * 10, xMax: Math.ceil(Math.max(...all) / 10) * 10, yMin: 0, yMax: 90, markers,
    xFmt: (v) => Math.round(v) + '\u00b0', yFmt: (v) => Math.round(v) + '\u00b0' });
  attachHover($('cSun'), $('sunTip'), ch);
  let txt = times ? `Sunrise ${hhmm(times.rise)}, solar noon ${hhmm(times.noon)}, sunset ${hhmm(times.set)}, highest ${times.maxEl.toFixed(1)}\u00b0.` : 'The sun does not rise on this day at this latitude.';
  if (t && typeof t.az_deg === 'number' && sunNow.el > 0) {
    const r = Math.PI / 180; const e = Math.acos(Math.min(1, Math.sin(sunNow.el * r) * Math.sin(t.el_deg * r) + Math.cos(sunNow.el * r) * Math.cos(t.el_deg * r) * Math.cos((sunNow.az - t.az_deg) * r))) / r;
    txt += ` Sun now: az ${sunNow.az.toFixed(0)}\u00b0, el ${sunNow.el.toFixed(0)}\u00b0. Pointing error of the tracker: ${e.toFixed(1)}\u00b0.`;
  }
  $('sunInfo').textContent = txt;
}

async function exportCsv() {
  const rows = await H.range(fromMs()); if (!rows.length) return toast('No data in this range', 'bad');
  download(`solmate-history-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(rows, SAMPLE_COLS)); toast(`${rows.length} rows exported`, 'ok');
}
async function exportDaily() {
  const rows = dailySummary(await H.range(fromMs()), tz()); if (!rows.length) return toast('No data in this range', 'bad');
  download('solmate-daily-summary.csv', toCSV(rows, [{ label: 'date', get: (r) => r.date }, { label: 'samples', get: (r) => r.n }, { label: 'tracker_wh', get: (r) => r.eT.toFixed(1) },
    { label: 'fixed_wh', get: (r) => (r.hasFixed ? r.eF.toFixed(1) : '') }, { label: 'gain_pct', get: (r) => (r.gain === null ? '' : r.gain.toFixed(2)) }, { label: 'peak_w', get: (r) => r.peak.toFixed(1) }]));
}
async function importCsv(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const { samples, skipped } = rowsToSamples(parseCSV(await f.text()));
    if (!samples.length) return toast('No usable rows. The file needs a time column (time_iso or ts_ms) and power_w.', 'bad', 6000);
    await H.bulkPut('samples', samples); toast(`${samples.length} rows imported${skipped ? `, ${skipped} skipped` : ''}`, 'ok'); refreshHistory();
  } catch (err) { toast('Import failed: ' + err.message, 'bad'); }
  e.target.value = '';
}
async function loadDemo() {
  if (!(await confirmDlg('Load 7 days of demo data?', 'Creates simulated readings, a cleaning, and a few events so the charts can be shown. It is marked as demo and can be deleted.', 'Load'))) return;
  const L = state.settings.location; const T = state.settings.thresholds;
  const d = makeDemo({ days: 7, lat: L.lat, lon: L.lon, tz: L.tz, rated: T.panel_rated_w });
  await H.bulkPut('samples', d.samples); await H.bulkPut('cleans', d.cleans); for (const ev of d.events) await H.addEvent(ev);
  emit('imported'); emit('cleans'); toast(`Demo data loaded (${d.samples.length} samples)`, 'ok'); refreshHistory();
}
async function deleteDemo() {
  const n = await H.deleteWhere('samples', (x) => x.src === 'demo'); await H.deleteWhere('cleans', (x) => x.src === 'demo'); await H.deleteWhere('events', (x) => x.src === 'demo');
  emit('imported'); emit('cleans'); toast(`Demo data deleted (${n} samples)`); refreshHistory();
}
