// Settings tab (Week 2 connection + Week 4 device settings).
import { $, link, state, dev, on, emit, isOnline, confirmDlg, toast, saveConn, saveSettings } from './core.js';
import * as S from './store.js';
import { logEvent } from './events.js';

let pendingRev = null;
let pendingTimer = null;

const chip = (text, cls = '') => { const c = $('syncChip'); c.textContent = text; c.className = 'chip ' + cls; };

function tzList() {
  const fallback = ['Asia/Karachi', 'UTC', 'Asia/Dubai', 'Asia/Kolkata', 'Europe/London', 'America/New_York'];
  try { const l = Intl.supportedValuesOf('timeZone'); return l.length ? l : fallback; } catch { return fallback; }
}

export function initSettings() {
  const sel = $('tzSel');
  tzList().forEach((z) => { const o = document.createElement('option'); o.value = z; o.textContent = z; sel.appendChild(o); });

  $('connSave').onclick = saveConnection;
  $('setSave').onclick = () => { const s = readForm(); if (checkForm(s)) { state.settings = s; saveSettings(); emit('limits'); toast('Saved on this phone', 'ok'); } };
  $('setPublish').onclick = publish;
  $('setReset').onclick = async () => {
    if (!(await confirmDlg('Reset settings?', 'Restore default limits, thresholds and PID values on this phone. Nothing is sent to the device until you press Publish.', 'Reset'))) return;
    state.settings = { ...JSON.parse(JSON.stringify(S.DEVICE_DEFAULTS)), rev: state.settings.rev };
    saveSettings(); fillForm(); emit('limits'); toast('Defaults restored');
  };
  $('eraseAll').onclick = async () => {
    if (!(await confirmDlg('Erase all app data on this device?', 'Deletes settings, saved logins, PIN, presets, history, events and the offline copy of the app. The tracker itself is not changed.', 'Erase everything'))) return;
    try { localStorage.clear(); indexedDB.deleteDatabase('solmate-history'); (await caches.keys()).forEach((k) => caches.delete(k)); } catch { /* ignore */ }
    location.reload();
  };
  $('advToggle').onchange = () => $('advBox').classList.toggle('hidden', !$('advToggle').checked);
  $('gpsBtn').onclick = () => {
    if (!navigator.geolocation) return toast('Location is not available on this device', 'bad');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        document.querySelector('[data-s="location.lat"]').value = p.coords.latitude.toFixed(4);
        document.querySelector('[data-s="location.lon"]').value = p.coords.longitude.toFixed(4);
        $('tzSel').value = Intl.DateTimeFormat().resolvedOptions().timeZone;
        toast('Location filled in. Press Save.', 'ok');
      },
      () => toast('Could not get location (needs HTTPS or localhost, and permission)', 'bad'),
      { timeout: 10000 });
  };

  on('applied', onApplied);
  on('calibdone', refreshCalibInfo);
  on('limits', fillForm);
  on('render', () => { $('revDev').textContent = dev.applied ? `rev ${dev.applied.rev}` : (dev.tel && dev.tel.rev != null ? `rev ${dev.tel.rev}` : '--'); });
}

export function refreshSettingsUI() { fillForm(); refreshCalibInfo(); }

function fillForm() {
  document.querySelectorAll('[data-c]').forEach((el) => {
    const v = state.conn[el.dataset.c];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  });
  document.querySelectorAll('[data-s]').forEach((el) => { el.value = S.getPath(state.settings, el.dataset.s) ?? ''; el.classList.remove('bad'); });
  $('revLocal').textContent = state.settings.rev;
  $('mixedNote').textContent = location.protocol === 'https:'
    ? 'This page is served over HTTPS. The cloud URL must be wss://. The direct local link (ws://) is blocked by the browser here; use the cloud, or open the app from the local http:// address.'
    : 'This page is served over HTTP, so the direct local link works. Installing as an app and the cloud broker need HTTPS (GitHub Pages).';
  $('setErrors').textContent = '';
}

function readForm() {
  const s = JSON.parse(JSON.stringify(state.settings));
  document.querySelectorAll('[data-s]').forEach((el) => {
    const path = el.dataset.s;
    S.setPath(s, path, path === 'location.tz' ? el.value : (el.value === '' ? NaN : Number(el.value)));
  });
  return s;
}

function checkForm(s) {
  document.querySelectorAll('[data-s]').forEach((el) => el.classList.remove('bad'));
  const errs = S.validate(s);
  errs.forEach((e) => { const el = document.querySelector(`[data-s="${e.path}"]`); if (el) el.classList.add('bad'); });
  $('setErrors').textContent = errs.map((e) => e.msg).join('. ');
  if (errs.length) toast(`${errs.length} value(s) need fixing`, 'bad');
  return errs.length === 0;
}

function saveConnection() {
  const c = {};
  document.querySelectorAll('[data-c]').forEach((el) => { c[el.dataset.c] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
  const okUrl = (u) => !u || /^wss?:\/\/.+/i.test(u);
  if (!okUrl(c.cloudUrl) || !okUrl(c.localUrl)) return toast('URLs must start with ws:// or wss://', 'bad');
  state.conn = c; saveConn(); link.start(c);
  toast('Connection saved. Reconnecting...', 'ok');
}

async function publish() {
  const s = readForm();
  if (!checkForm(s)) return;
  if (!link.route) return toast('No connection to the device or broker', 'bad');
  const old = JSON.stringify({ l: state.settings.limits, p: state.settings.pid });
  if (old !== JSON.stringify({ l: s.limits, p: s.pid })) {
    const ok = await confirmDlg('Publish new limits / PID?',
      `Travel limits: Az ${s.limits.az_min}-${s.limits.az_max}\u00b0, El ${s.limits.el_min}-${s.limits.el_max}\u00b0.\nThese change where the tracker is allowed to move and how it controls. Continue?`, 'Publish');
    if (!ok) return;
  }
  const msg = { ...s, rev: state.settings.rev + 1 };
  state.settings = msg; saveSettings(); emit('limits');
  $('revLocal').textContent = msg.rev;
  // retained + sent on every link: the cloud broker keeps it for a device that is offline right now
  const sent = link.send('settings/set', msg, { qos: 1, retain: true, all: true });
  if (!sent) return chip('Not sent', 'offline');
  logEvent({ type: 'settings', msg: `Settings revision ${msg.rev} published` });
  pendingRev = msg.rev; chip('Sending...');
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    if (pendingRev !== msg.rev) return;
    if (link.cloud.state === 'up' && !isOnline()) chip('Stored in broker: applies when device reconnects', 'warn');
    else chip('No reply from device', 'offline');
  }, 6000);
}

function onApplied(p) {
  if (!p || p.rev !== pendingRev) return;
  pendingRev = null; clearTimeout(pendingTimer);
  logEvent({ type: 'settings', sev: p.ok ? 'info' : 'warn', msg: p.ok ? `Device applied settings revision ${p.rev}` : `Device rejected settings revision ${p.rev}: ${p.reason}` });
  if (p.ok) { chip(`Applied by device (rev ${p.rev})`, 'online'); toast('Settings applied by device', 'ok'); }
  else { chip(`Rejected: ${p.reason || 'unknown'}`, 'offline'); toast(`Device rejected settings: ${p.reason}`, 'bad', 5000); }
}

function refreshCalibInfo() {
  const c = S.load('calib', {});
  $('calibInfo').textContent = c.at
    ? `Last calibration: ${new Date(c.at).toLocaleString()}. Az ${c.marks.az_min}-${c.marks.az_max}\u00b0, El ${c.marks.el_min}-${c.marks.el_max}\u00b0.`
    : 'Not calibrated from this app yet.';
}
