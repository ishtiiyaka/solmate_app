// Care tab (Week 7): weather and stow, forecast, cleaning control and log, soiling ratio, next clean.
import { $, state, dev, on, emit, command, controlState, confirmDlg, toast, isOnline, stowNow, resumeTracking } from './core.js';
import * as H from './history.js';
import * as S from './store.js';
import { soiling } from './analysis.js';
import { lineChart, attachHover, COLORS } from './charts.js';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const active = () => $('tab-care').classList.contains('active');
let soilTimer = 0;

export function initCare() {
  $('stowBtn').onclick = stowNow;
  $('resumeBtn').onclick = resumeTracking;
  $('fcRefresh').onclick = () => loadForecast(true);
  $('clStart').onclick = async () => {
    const t = dev.tel || {};
    if (!(await confirmDlg('Start a cleaning cycle?', `Nobody should be near the panel. Water level: ${num(t.water_pct) ? t.water_pct + ' percent' : 'unknown'}. The tracker should be in the safe position.`, 'Start'))) return;
    const r = await command('cmd/clean', { action: 'start' }, { qos: 1 }); if (r.ok) toast('Cleaning started', 'ok');
  };
  $('clStop').onclick = async () => { const r = await command('cmd/clean', { action: 'stop' }, { qos: 1 }); if (r.ok) toast('Cleaning stopped'); };
  $('clManual').onclick = async () => {
    if (!(await confirmDlg('Log a manual cleaning?', 'Use this when you cleaned the panel by hand. It resets the soiling baseline.', 'Log it'))) return;
    await H.addClean({ ts: Date.now(), src: 'manual', dur: 0, ok: true }); refreshSoiling(); toast('Cleaning logged', 'ok');
  };
  document.querySelector('.tabs [data-tab="care"]').addEventListener('click', () => { refreshSoiling(); loadForecast(false); });
  on('cleans', refreshSoiling);
  on('render', renderLive);
  on('limits', () => { if (active()) { refreshSoiling(); renderForecast(); } });
  setInterval(() => { if (active()) refreshSoiling(); }, 60000);
  renderLive(); renderForecast();
}

function renderLive() {
  const t = dev.tel || {}; const T = state.settings.thresholds; const cs = controlState();
  $('wxWind').textContent = num(t.wind_ms) ? t.wind_ms.toFixed(1) : '--';
  $('wxRain').textContent = t.rain === true ? 'Rain' : t.rain === false ? 'Dry' : '--';
  $('wxLimit').textContent = T.wind_stow_ms;
  const stowed = t.mode === 'stow';
  $('wxStow').textContent = stowed ? 'Stowed (safe position)' : isOnline() ? 'Tracking / normal' : '--';
  $('wxStow').className = stowed ? 'offline' : '';
  $('stowBtn').disabled = !(cs.modeOk && !stowed); $('resumeBtn').disabled = !(cs.modeOk && stowed);
  const st = t.cleaning || (isOnline() ? 'idle' : '--');
  $('clState').textContent = st; $('clWater').textContent = num(t.water_pct) ? t.water_pct + ' %' : '--';
  $('clStart').disabled = !(cs.modeOk && st !== 'running'); $('clStop').disabled = !(link_ok() && st === 'running');
}
const link_ok = () => isOnline() && !state.readOnly && !state.locked;

// ---------- forecast (Open-Meteo, needs internet, cached for offline) ----------
let fc = S.load('forecast', {});
async function loadForecast(force) {
  const L = state.settings.location;
  if (!force && fc.at && Date.now() - fc.at < 30 * 60000 && fc.lat === L.lat && fc.lon === L.lon) return renderForecast();
  $('fcStatus').textContent = 'Loading forecast...';
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${L.lat}&longitude=${L.lon}&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation&wind_speed_unit=ms&forecast_days=2&timezone=${encodeURIComponent(L.tz)}`;
    const res = await fetch(url, { cache: 'no-store' }); if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json(); if (!j.hourly) throw new Error('no data');
    fc = { at: Date.now(), lat: L.lat, lon: L.lon, hourly: j.hourly }; S.save('forecast', fc);
  } catch (e) { $('fcStatus').textContent = 'Could not load the forecast (' + (e.message || e) + '). ' + (fc.at ? 'Showing the saved one.' : ''); }
  renderForecast();
}

function renderForecast() {
  const box = $('fcTable'); const T = state.settings.thresholds;
  if (!fc.hourly) { box.innerHTML = ''; lineChart($('fcChart'), [], { emptyText: 'No forecast yet. Open this tab with internet.' }); return; }
  const h = fc.hourly; const tz = state.settings.location.tz;
  const nowKey = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).slice(0, 13).replace(' ', 'T');
  let i0 = h.time.findIndex((x) => x.slice(0, 13) >= nowKey); if (i0 < 0) i0 = 0;
  const idx = [...Array(24).keys()].map((k) => i0 + k).filter((k) => k < h.time.length);
  const gust = idx.map((k) => h.wind_gusts_10m[k]); const wind = idx.map((k) => h.wind_speed_10m[k]); const rainP = idx.map((k) => h.precipitation_probability ? h.precipitation_probability[k] : 0);
  const peak = Math.max(...gust); const pk = idx[gust.indexOf(peak)];
  const stowLikely = peak >= T.wind_stow_ms;
  $('fcStatus').textContent = `Forecast saved ${new Date(fc.at).toLocaleTimeString()}. Peak gust in the next 24 h: ${peak.toFixed(1)} m/s at ${h.time[pk].slice(11, 16)}. ` +
    (stowLikely ? 'Stow is likely: gusts exceed your limit.' : 'No stow expected.') + ` Highest rain chance: ${Math.max(...rainP)} %.`;
  $('fcStatus').className = 'note' + (stowLikely ? ' warn' : '');
  box.innerHTML = '<table class="marks"><tr><td>Time</td><td>Wind</td><td>Gust</td><td>Rain</td></tr>' + idx.slice(0, 12).map((k, n) =>
    `<tr class="${gust[n] >= T.wind_stow_ms ? 'hot' : ''}"><td>${h.time[k].slice(11, 16)}</td><td>${wind[n].toFixed(1)}</td><td>${gust[n].toFixed(1)}</td><td>${rainP[n]}%</td></tr>`).join('') + '</table>';
  const labels = idx.map((k) => h.time[k].slice(11, 13) + 'h');
  const ch = lineChart($('fcChart'), [
    { name: 'Gust m/s', color: COLORS.red, pts: gust.map((v, n) => [n, v]) }, { name: 'Wind m/s', color: COLORS.blue, pts: wind.map((v, n) => [n, v]) }],
  { h: 180, xMin: 0, xMax: Math.max(1, idx.length - 1), yMin: 0, xFmt: (v) => labels[Math.round(v)] || '', hline: { value: T.wind_stow_ms, label: 'stow limit', color: COLORS.accent } });
  attachHover($('fcChart'), $('fcTip'), ch);
}

// ---------- soiling, next clean, cleaning log ----------
export async function refreshSoiling() {
  if (!H.ready()) return;
  const T = state.settings.thresholds; const tz = state.settings.location.tz;
  const samples = await H.range(Date.now() - 60 * 86400000); const cleans = await H.cleans();
  const so = soiling(samples, cleans, tz, T.panel_rated_w, T.soil_threshold_pct);
  const thr = T.soil_threshold_pct / 100;
  const last = so.lastClean; const sched = last ? last + T.clean_interval_days * 86400000 : null;
  const fmtD = (ms) => new Date(ms).toLocaleDateString([], { dateStyle: 'medium' });
  if (so.status === 'ok') {
    $('soilSR').textContent = (so.current * 100).toFixed(1) + ' %';
    $('soilSR').className = so.current < thr ? 'offline' : so.current < thr + 0.02 ? 'warnc' : 'online';
    $('soilNote').textContent = `Baseline efficiency ${(so.baseline * 100).toFixed(1)} % of rated. ` + (so.slope !== null ? `Trend ${(so.slope * 100).toFixed(2)} % per day.` : 'Trend needs 3 days after a cleaning.');
  } else {
    $('soilSR').textContent = '--'; $('soilSR').className = '';
    $('soilNote').textContent = 'Needs at least 2 sunny days of data after the last cleaning, with the irradiance reading. Load demo data in Charts to try it.';
  }
  $('soilLast').textContent = last ? `${fmtD(last)} (${cleans[cleans.length - 1].src})` : 'none logged';
  $('soilSched').textContent = sched ? fmtD(sched) : 'log a cleaning first';
  $('soilPred').textContent = so.daysToThreshold === null ? '--' : so.daysToThreshold <= 0 ? 'now' : fmtD(Date.now() + so.daysToThreshold * 86400000);
  let rec = 'OK. No cleaning needed yet.'; let cls = 'note';
  if (so.status === 'ok' && so.current < thr) { rec = `Clean now: soiling ratio is below ${T.soil_threshold_pct} %.`; cls = 'note warn'; }
  else if (sched && Date.now() > sched) { rec = `Clean due: more than ${T.clean_interval_days} days since the last cleaning.`; cls = 'note warn'; }
  else if (!last) { rec = 'No cleaning has been logged yet.'; }
  $('clRec').textContent = rec; $('clRec').className = cls;
  const ch = lineChart($('soilChart'), [{ name: 'Soiling ratio %', color: COLORS.green, pts: so.days.filter((d) => d.sr !== undefined).map((d) => [Date.parse(d.date + 'T12:00:00Z'), d.sr * 100]) }],
    { h: 150, yMin: Math.max(0, Math.min(90, T.soil_threshold_pct - 10)), yMax: 102, xFmt: (v) => new Date(v).toISOString().slice(5, 10), hline: { value: T.soil_threshold_pct, label: 'threshold', color: COLORS.accent }, emptyText: 'Soiling chart appears after 2 sunny days' });
  attachHover($('soilChart'), $('soilTip'), ch);
  const ul = $('clLog'); ul.innerHTML = '';
  [...cleans].reverse().slice(0, 15).forEach((c) => {
    const li = document.createElement('li'); li.className = 'ev info';
    li.innerHTML = '<b></b><span class="msg"></span><small></small>'; li.querySelector('b').textContent = c.src === 'manual' ? 'By hand' : c.src === 'demo' ? 'Demo' : 'Cleaning cycle';
    li.querySelector('.msg').textContent = c.ok === false ? 'Stopped early' : c.dur ? `Finished in ${c.dur} s` : 'Done';
    li.querySelector('small').textContent = new Date(c.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); ul.appendChild(li);
  });
  if (!cleans.length) ul.innerHTML = '<li class="note">No cleaning logged yet.</li>';
}
