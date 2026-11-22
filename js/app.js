// SolMate app entry point (v1.0): dashboard, control, presets, then the feature modules.
import { $, link, state, dev, on, controlState, isOnline, command, stopAll, emergencyStop, resetEstop,
  attachJog, gotoWithConfirm, confirmDlg, toast, stowNow, resumeTracking } from './core.js';
import * as S from './store.js';
import * as H from './history.js';
import { initSettings, refreshSettingsUI } from './settings.js';
import { initWizard } from './wizard.js';
import { initHistoryView, refreshHistory } from './historyview.js';
import { initEvents } from './events.js';
import { initMap } from './mapview.js';
import { initCare } from './care.js';
import { initDiag } from './diag.js';
import { initLock, initSecurityPanel, renderPanel } from './security.js';

const set = (id, v) => { $(id).textContent = v === undefined || v === null ? '--' : v; };
const num = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------- tabs ----------------
export function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'hist') refreshHistory();
  if (name === 'set') renderPanel();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------------- dashboard + banner ----------------
function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

function renderDashboard() {
  const t = dev.tel || {};
  set('power', t.power_w); set('voltage', t.voltage_v); set('current', t.current_a);
  set('az', t.az_deg); set('el', t.el_deg); set('imu', t.imu_pitch_deg);
  set('mode', t.estop ? 'E-STOP' : t.mode); set('temp', t.temp_c);
  set('fixedw', t.fixed_power_w); set('irr', t.irradiance_wm2); set('wind', t.wind_ms); set('water', t.water_pct);
  $('badge').classList.toggle('hidden', t.source !== 'simulator');

  $('broker').textContent = link.statusText('cloud');
  $('broker').className = link.cloud.state === 'up' ? 'online' : link.cloud.state === 'off' ? '' : 'offline';
  $('broker').title = link.cloud.error;
  $('localst').textContent = link.statusText('local');
  $('localst').className = link.local.state === 'up' ? 'online' : link.local.state === 'off' ? '' : 'offline';
  $('localst').title = link.local.error;

  const online = isOnline();
  $('device').textContent = online ? 'Online' : dev.lastSeen ? 'Offline' : 'Unknown';
  $('device').className = online ? 'online' : 'offline';
  $('last').textContent = dev.lastSeen ? `${ago(Date.now() - dev.lastSeen)} (${new Date(dev.lastSeen).toLocaleTimeString()})` : '--';
  $('stale').classList.toggle('hidden', online || !dev.tel);
  document.querySelector('#tab-dash .grid').classList.toggle('stale', !online);

  const r = link.route;
  $('route').textContent = r === 'local' ? 'Local' : r === 'cloud' ? 'Cloud' : 'No link';
  $('route').className = 'chip ' + (r ? 'online' : 'offline');
}

function renderBanner() {
  const t = dev.tel || {}; const b = $('banner'); const live = link.route && isOnline();
  let level = null; let text = ''; let btn = null;
  if (link.cloud.state === 'auth' && !link.route) { level = 'bad'; text = 'Cloud login refused. Check the username and password in Settings.'; }
  else if (live && t.estop) { level = 'bad'; text = 'EMERGENCY STOP ACTIVE'; btn = ['Reset', resetEstop]; }
  else if (live && t.mode === 'fault') { level = 'bad'; text = `FAULT: ${t.fault || 'unknown'}`; }
  else if (live && t.mode === 'local') { level = 'warn'; text = 'LOCAL CONTROL: app controls are disabled'; }
  else if (live && t.mode === 'stow') { level = 'warn'; text = 'STOWED: safe position (storm mode)'; btn = ['Resume', resumeTracking]; }
  else if (!link.route) { level = 'bad'; text = state.readOnly || state.locked ? 'Offline view: showing the last known values' : 'No connection'; }
  else if (!isOnline()) { level = 'warn'; text = 'Device offline: showing last known values'; }
  else if (state.readOnly) { level = 'info'; text = 'Read-only mode: controls are disabled'; }
  b.className = 'banner ' + (level || 'hidden');
  b.textContent = text;
  if (btn && !state.readOnly && !state.locked) { const x = document.createElement('button'); x.textContent = btn[0]; x.onclick = btn[1]; b.appendChild(x); }
}

// ---------------- control tab ----------------
const azS = $('azSlider'); const elS = $('elSlider');
let sliderTouched = false;

function applyLimitsToSliders() {
  const L = state.settings.limits;
  azS.min = L.az_min; azS.max = L.az_max; elS.min = L.el_min; elS.max = L.el_max;
  $('azTgtTxt').textContent = azS.value; $('elTgtTxt').textContent = elS.value;
}
function useCurrent() {
  const t = dev.tel; if (!t || !num(t.az_deg)) return;
  azS.value = t.az_deg; elS.value = t.el_deg;
  $('azTgtTxt').textContent = azS.value; $('elTgtTxt').textContent = elS.value;
  sliderTouched = false;
}
azS.oninput = () => { sliderTouched = true; $('azTgtTxt').textContent = azS.value; };
elS.oninput = () => { sliderTouched = true; $('elTgtTxt').textContent = elS.value; };
$('curBtn').onclick = useCurrent;
$('goBtn').onclick = () => gotoWithConfirm(Number(azS.value), Number(elS.value));
$('stopBtn').onclick = () => { stopAll(); toast('Stop sent'); };
$('estop').onclick = emergencyStop;
$('ctlStow').onclick = stowNow; $('ctlResume').onclick = resumeTracking;
attachJog($('manualPanel'));

document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', async () => {
  const mode = b.dataset.mode; const cs = controlState();
  if (!cs.modeOk) return toast(cs.why, 'bad');
  if ((dev.tel || {}).mode === mode) return;
  const r = await command('cmd/mode', { mode }, { qos: 1 });
  if (r.ok) toast(`Mode: ${mode}`, 'ok');
}));

function renderControl() {
  const cs = controlState(); const t = dev.tel || {};
  document.querySelectorAll('#modeSeg button').forEach((b) => {
    b.disabled = !cs.modeOk; b.classList.toggle('on', t.mode === b.dataset.mode && isOnline());
  });
  $('modeNote').textContent = cs.why;
  $('modeNote').className = 'note' + (cs.level === 'bad' ? ' warn' : '');
  document.querySelectorAll('#manualPanel .jogbtn, #goBtn, #curBtn, #azSlider, #elSlider').forEach((el) => { el.disabled = !cs.manual; });
  $('stopBtn').disabled = !link.route;
  document.querySelectorAll('#presetList .go').forEach((b) => { b.disabled = !cs.manual; });
  const stowed = t.mode === 'stow';
  $('ctlStow').disabled = !(cs.modeOk && !stowed); $('ctlResume').disabled = !(cs.modeOk && stowed);
}

// ---------------- presets ----------------
function renderPresets() {
  const ul = $('presetList'); ul.innerHTML = '';
  state.presets.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><small></small><button type="button" class="go primary">Go</button><button type="button" class="del">Delete</button>';
    li.querySelector('span').textContent = p.name;
    li.querySelector('small').textContent = `${p.az}\u00b0 / ${p.el}\u00b0`;
    li.querySelector('.go').onclick = () => gotoWithConfirm(p.az, p.el, p.name);
    li.querySelector('.del').onclick = async () => {
      if (await confirmDlg('Delete saved position?', `Remove "${p.name}"?`, 'Delete')) { state.presets.splice(i, 1); S.savePresets(state.presets); renderPresets(); renderControl(); }
    };
    ul.appendChild(li);
  });
}
$('presetSave').onclick = () => {
  const name = $('presetName').value.trim();
  if (!name) return toast('Type a name first', 'bad');
  const az = Number(azS.value); const el = Number(elS.value);
  const L = state.settings.limits;
  if (az < L.az_min || az > L.az_max || el < L.el_min || el > L.el_max) return toast('Position is outside the travel limits', 'bad');
  const i = state.presets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  if (i >= 0) state.presets[i] = { name, az, el };
  else if (state.presets.length >= 12) return toast('Maximum 12 saved positions', 'bad');
  else state.presets.push({ name, az, el });
  S.savePresets(state.presets); $('presetName').value = ''; renderPresets(); renderControl();
  toast('Position saved', 'ok');
};

// ---------------- render loop ----------------
function render() { renderDashboard(); renderBanner(); renderControl(); }
on('render', render);
on('telemetry', () => { if (!sliderTouched) useCurrent(); });
on('limits', () => { applyLimitsToSliders(); renderPresets(); });
setInterval(render, 1000);

// ---------------- PWA ----------------
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').classList.remove('hidden'); });
$('installBtn').onclick = async () => { if (deferred) { deferred.prompt(); deferred = null; $('installBtn').classList.add('hidden'); } };
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
if (isIOS && !navigator.standalone) $('iosNote').classList.remove('hidden');
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed', e));
}

// ---------------- start ----------------
$('ver').textContent = 'v' + S.VERSION; $('ver2').textContent = 'v' + S.VERSION;
await H.init();
initSettings();
initWizard();
initHistoryView();
await initEvents();
initMap();
initCare();
initDiag();
initSecurityPanel();
applyLimitsToSliders();
renderPresets();
if (dev.tel) useCurrent();
render();
refreshSettingsUI();
// With a PIN set the app waits at the lock screen; the connection starts after unlock (or local-only in view-only mode).
const waitingForPin = initLock((full) => link.start(full ? state.conn : { ...state.conn, cloudUrl: '' }));
if (!waitingForPin) link.start(state.conn);
window.__solmate = { link, state, dev };      // handy in the browser console for diagnostics
