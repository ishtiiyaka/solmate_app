// Shared core: device state, commands with acknowledgements, safety rules, jog heartbeat, toasts, dialogs.
import { Link } from './link.js';
import * as S from './store.js';
import * as H from './history.js';

export const $ = (id) => document.getElementById(id);
export const OFFLINE_AFTER_MS = 10000;          // no telemetry for 10 s = device offline
export const link = new Link();

export const state = {
  conn: S.load('conn', S.CONN_DEFAULTS),
  settings: S.load('settings', S.DEVICE_DEFAULTS),
  presets: S.loadPresets(),
  histEvery: Number(localStorage.getItem('solmate.histEvery')) || 30,
  readOnly: localStorage.getItem('solmate.readonly') === '1',   // view-only: never sends commands
  locked: false,                                                // PIN lock screen is showing
};
export const hooks = {};                                        // security.js plugs in here (encrypted connection saving)

const last = S.load('last', {});                 // last known values, so the app is useful on open
export const dev = {
  tel: last.tel || null,
  lastSeen: last.seen || 0,
  live: false,                                    // true once a telemetry message arrived in THIS session
  status: 'unknown',
  via: null,
  applied: null,                                  // last settings/applied message
  calib: null,                                    // last calib/state message
};

// ---- tiny event bus ----
const handlers = {};
export const on = (ev, fn) => (handlers[ev] = handlers[ev] || []).push(fn);
export const emit = (ev, ...a) => (handlers[ev] || []).forEach((f) => f(...a));

// ---- device state helpers ----
export function isOnline() {
  return dev.live && dev.lastSeen > 0 && Date.now() - dev.lastSeen < OFFLINE_AFTER_MS && dev.status !== 'offline';
}

// What may the user do right now? One place decides, every screen uses it.
export function controlState() {
  const t = dev.tel || {};
  if (!link.route) return { modeOk: false, manual: false, level: 'bad', why: 'No connection. Check Settings > Connection.' };
  if (!isOnline()) return { modeOk: false, manual: false, level: 'warn', why: 'Device is offline. Controls are disabled.' };
  if (state.locked) return { modeOk: false, manual: false, level: 'warn', why: 'The app is locked. Enter your PIN to control the tracker.' };
  if (state.readOnly) return { modeOk: false, manual: false, level: 'info', why: 'Read-only mode is on. Turn it off in Settings > Security to control the tracker.' };
  if (t.estop) return { modeOk: false, manual: false, level: 'bad', why: 'Emergency stop is active.' };
  if (t.mode === 'fault') return { modeOk: false, manual: false, level: 'bad', why: `Fault: ${t.fault || 'unknown'}. Controls are disabled.` };
  if (t.mode === 'local') return { modeOk: false, manual: false, level: 'warn', why: 'Device is in LOCAL control (switch on the unit). App controls are disabled.' };
  if (t.mode === 'stow') return { modeOk: true, manual: false, level: 'warn', why: 'Stowed in the safe position (storm mode). Press Resume when the weather is safe.' };
  if (t.mode === 'auto') return { modeOk: true, manual: false, level: 'info', why: 'Auto mode is tracking the sun. Switch to Manual to move it yourself.' };
  return { modeOk: true, manual: true, level: 'ok', why: '' };
}

export const diagLog = [];
link.on('log', (msg) => { diagLog.unshift({ ts: Date.now(), msg }); if (diagLog.length > 80) diagLog.pop(); emit('diag'); });
link.on('route', (r) => { if (r) dev.via = r; emit('route', r); emit('render'); });
link.on('state', () => emit('render'));
link.on('message', (sub, p, via) => {
  if (sub === 'telemetry' && p && typeof p === 'object') {
    dev.tel = p; dev.lastSeen = Date.now(); dev.status = 'online'; dev.via = via; dev.live = true;
    if (estopT0 && p.estop) { dev.estopMs = Date.now() - estopT0; estopT0 = 0; emit('estopms', dev.estopMs); }
    persistLast(); record(p); emit('telemetry', p);
  } else if (sub === 'status') {
    dev.status = String(p); emit('render');
  } else if (sub === 'ack') {
    handleAck(p, via);
  } else if (sub === 'event') {
    emit('devEvent', p);
  } else if (sub === 'settings/applied') {
    dev.applied = p; emit('applied', p);
  } else if (sub === 'calib/state') {
    dev.calib = p; emit('calib', p);
  }
  emit('render');
});

let persistAt = 0;
function persistLast() {
  if (Date.now() - persistAt < 5000) return;
  persistAt = Date.now();
  S.save('last', { tel: dev.tel, seen: dev.lastSeen });
}

let recordAt = 0;
function record(t) {
  if (Date.now() - recordAt < state.histEvery * 1000) return;
  recordAt = Date.now();
  H.add({ ts: Date.now(), p: t.power_w, v: t.voltage_v, i: t.current_a, az: t.az_deg, el: t.el_deg, t: t.temp_c, m: t.mode,
    pf: t.fixed_power_w, g: t.irradiance_wm2 });
}

// ---- commands with acknowledgement ----
const pending = new Map();
let seq = 0;
const REASONS = {
  estop: 'Emergency stop is active', fault: 'Device has a fault', local_mode: 'Device is in local control',
  not_manual: 'Switch to Manual first', out_of_limits: 'Outside the travel limits', bad_args: 'Device rejected the values',
  bad_mode: 'Unknown mode', incomplete_marks: 'Mark all four end stops first', not_started: 'Calibration not started',
  unknown_cmd: 'Device does not know this command', wind_high: 'Wind is still too strong', stowed: 'The tracker is stowed. Press Resume first',
  low_water: 'Cleaning water is too low', busy: 'A cleaning cycle is already running', locked: 'The app is locked or read-only',
};
let lastRejectToast = 0;

function handleAck(p, via) {
  if (!p || typeof p !== 'object') return;
  emit('ack', p, via);
  const w = pending.get(p.id);
  if (w) { clearTimeout(w.to); pending.delete(p.id); w.resolve({ ok: !!p.ok, reason: p.reason }); }
  if (!p.ok && !(w && w.quiet)) {
    if (Date.now() - lastRejectToast > 2000) { lastRejectToast = Date.now(); toast(REASONS[p.reason] || `Rejected: ${p.reason}`, 'bad'); }
  }
}

export function command(sub, payload = {}, opts = {}) {
  if ((state.locked || state.readOnly) && sub !== 'cmd/estop' && sub !== 'cmd/stop') {
    toast(REASONS.locked, 'bad'); return Promise.resolve({ ok: false, reason: 'locked' });
  }
  const id = 'c' + Date.now().toString(36) + (seq++).toString(36);
  if (!link.send(sub, { ...payload, id }, opts)) {
    toast('Not sent: no connection', 'bad');
    return Promise.resolve({ ok: false, reason: 'no_link' });
  }
  return new Promise((resolve) => {
    const to = setTimeout(() => { pending.delete(id); toast('No reply from the device', 'bad'); resolve({ ok: false, reason: 'timeout' }); }, opts.timeout || 4000);
    pending.set(id, { resolve, to, quiet: false });
  });
}

// ---- stop and emergency stop ----
export function stopAll() {
  stopJogs();
  link.send('cmd/stop', { id: 'stop' }, { qos: 1, all: true });
}

let estopT0 = 0;
export function emergencyStop() {
  stopJogs(); estopT0 = Date.now();
  const fire = () => link.send('cmd/estop', { estop: true, id: 'estop' }, { qos: 1, all: true });
  if (!fire()) toast('E-STOP could not be sent: no connection. Use the physical stop!', 'bad', 6000);
  else toast('E-STOP sent', 'bad');
  setTimeout(fire, 150); setTimeout(fire, 500);        // repeated on purpose: one lost packet must not matter
}

export async function resetEstop() {
  if (!(await confirmDlg('Reset emergency stop?', 'Make sure nobody is near the tracker and nothing is blocking it.', 'Reset'))) return;
  const r = await command('cmd/estop', { estop: false }, { qos: 1 });
  if (r.ok) toast('E-stop released', 'ok');
}

// ---- jog buttons: hold to move, heartbeat every 200 ms, stop on release/blur/hidden ----
const jogStops = new Set();
export function stopJogs() { jogStops.forEach((f) => f(true)); }

export function attachJog(container) {
  container.querySelectorAll('.jogbtn').forEach((btn) => {
    const axis = btn.dataset.axis; const dir = Number(btn.dataset.dir);
    let timer = null; let n = 0;
    const beat = () => {
      if (!controlState().manual) return stop(true);         // state changed while held: stop at once
      link.send('cmd/jog', { axis, dir, seq: n++ });
    };
    const stop = (send) => {
      if (timer === null) return;
      clearInterval(timer); timer = null; btn.classList.remove('active');
      if (send) { link.send('cmd/stop', { id: 'jogstop' }, { qos: 1 }); setTimeout(() => link.send('cmd/stop', { id: 'jogstop' }, { qos: 1 }), 120); }
    };
    jogStops.add(stop);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const cs = controlState();
      if (!cs.manual) return toast(cs.why || 'Controls are disabled', 'bad');
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      btn.classList.add('active'); beat(); timer = setInterval(beat, 200);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, () => stop(true)));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}
window.addEventListener('blur', stopJogs);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopJogs(); });

// ---- toast and confirm dialog ----
export function toast(msg, kind = '', ms = 3000) {
  const d = document.createElement('div');
  d.className = 'toast ' + kind; d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), ms);
}

export function confirmDlg(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const dlg = $('dlgConfirm');
    $('cTitle').textContent = title; $('cText').textContent = text; $('cYes').textContent = okLabel;
    const done = (v) => { dlg.close(); $('cYes').onclick = $('cNo').onclick = null; dlg.oncancel = null; resolve(v); };
    $('cYes').onclick = () => done(true);
    $('cNo').onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
  });
}

// ---- go-to with confirmation for large moves (used by sliders and presets) ----
export async function gotoWithConfirm(az, el, label = 'this position') {
  const cs = controlState();
  if (!cs.manual) return toast(cs.why || 'Controls are disabled', 'bad');
  const L = state.settings.limits; const T = state.settings.thresholds;
  if (az < L.az_min || az > L.az_max || el < L.el_min || el > L.el_max)
    return toast(`${label} is outside the travel limits`, 'bad');
  const t = dev.tel || {};
  const daz = Math.abs(az - (t.az_deg ?? az)); const del = Math.abs(el - (t.el_deg ?? el));
  if (daz > T.confirm_az || del > T.confirm_el) {
    const ok = await confirmDlg('Large move', `Move to Az ${az}\u00b0, El ${el}\u00b0 (${label})?\nChange: Az ${daz.toFixed(0)}\u00b0, El ${del.toFixed(0)}\u00b0. Keep clear of the tracker.`, 'Move');
    if (!ok) return;
  }
  const r = await command('cmd/goto', { az, el }, { qos: 1 });
  if (r.ok) toast(`Moving to ${label}`, 'ok');
}

export async function stowNow() {
  const cs = controlState();
  if (!cs.modeOk && (dev.tel || {}).mode !== 'stow') return toast(cs.why || 'Not available now', 'bad');
  if (!(await confirmDlg('Move to the safe position?', 'The tracker will move to its storm (stow) position and stop tracking until you press Resume.', 'Stow'))) return;
  const r = await command('cmd/stow', {}, { qos: 1 });
  if (r.ok) toast('Stowing...', 'ok');
}
export async function resumeTracking() {
  const cs = controlState();
  if (!cs.modeOk) return toast(cs.why, 'bad');
  const r = await command('cmd/mode', { mode: 'auto' }, { qos: 1 });
  if (r.ok) toast('Tracking resumed', 'ok');
}

export function saveConn() { if (hooks.saveConn) hooks.saveConn(); else S.save('conn', state.conn); }
export function saveSettings() { S.save('settings', state.settings); }

// save text as a file download (CSV export)
export function download(filename, text, mime = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
}
