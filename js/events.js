// Event log, alert detection, in-app alerts and notifications (Week 6).
import { $, state, dev, on, emit, toast, isOnline, confirmDlg, download } from './core.js';
import * as H from './history.js';
import * as S from './store.js';
import { toCSV } from './analysis.js';
import { distanceM } from './sun.js';

export const TYPES = {
  stall: ['Stall', 'crit'], overcurrent: ['Over-current', 'crit'], sensor_loss: ['Sensor loss', 'crit'], fault: ['Fault', 'crit'],
  estop: ['Emergency stop', 'crit'], gps_move: ['Location moved', 'crit'], mismatch: ['Angle mismatch', 'warn'],
  low_water: ['Low water', 'warn'], wind_stow: ['Wind / stow', 'warn'], rain: ['Rain', 'info'], offline: ['Device offline', 'warn'],
  online: ['Device online', 'info'], clean_start: ['Cleaning started', 'info'], clean_done: ['Cleaning done', 'info'],
  mode: ['Mode change', 'info'], settings: ['Settings', 'info'], calib: ['Calibration', 'info'], info: ['Info', 'info'],
};
const SEV = { info: 0, warn: 1, crit: 2 };
let notif = S.load('notif', S.NOTIFY_DEFAULTS);
let list = [];
let lastRead = Number(localStorage.getItem('solmate.eventsRead')) || 0;
const lastByType = new Map();

// ---------- logging ----------
export async function logEvent(ev) {
  ev.ts = ev.ts || Date.now(); ev.src = ev.src || 'app';
  ev.sev = ev.sev || (TYPES[ev.type] || TYPES.info)[1];
  const key = ev.type + ':' + ev.sev;                                   // the same event twice within 30 s is one event
  if (ev.src !== 'demo') { if (Date.now() - (lastByType.get(key) || 0) < 30000) return null; lastByType.set(key, Date.now()); }
  ev.id = await H.addEvent(ev);
  list.unshift(ev); emit('events'); raise(ev);
  return ev;
}

// ---------- alerts: banner/toast, sound, vibration, system notification ----------
let audio = null;
function beep(sev) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(); const g = audio.createGain(); o.connect(g); g.connect(audio.destination);
    o.frequency.value = sev === 'crit' ? 880 : 520; g.gain.value = 0.08; o.start(); o.stop(audio.currentTime + (sev === 'crit' ? 0.5 : 0.2));
  } catch { /* sound is optional */ }
}
function systemNotify(ev) {
  const [label] = TYPES[ev.type] || TYPES.info;
  const opts = { body: ev.msg, tag: ev.type, icon: 'icons/icon-192.png', renotify: true };
  const fallback = () => { try { new Notification('SolMate: ' + label, opts); } catch { /* not supported */ } };
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then((r) => (r ? r.showNotification('SolMate: ' + label, opts) : fallback())).catch(fallback);
  else fallback();
}
function raise(ev) {
  if (ev.src === 'demo' || !notif.enabled || SEV[ev.sev] < SEV[notif.minSev]) return;
  toast((ev.sev === 'crit' ? 'ALERT: ' : '') + ev.msg, ev.sev === 'crit' ? 'bad' : '', 6000);
  if (notif.sound) beep(ev.sev);
  if (notif.vibrate && navigator.vibrate) navigator.vibrate(ev.sev === 'crit' ? [250, 100, 250, 100, 250] : [150]);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') systemNotify(ev);
}

// ---------- detection from telemetry (device may also send its own events on the "event" topic) ----------
const flags = {};
function cond(name, active, evOn, evOff, holdMs = 0) {
  const f = flags[name] || (flags[name] = { since: 0, on: false });
  if (active) {
    if (!f.since) f.since = Date.now();
    if (!f.on && Date.now() - f.since >= holdMs) { f.on = true; logEvent(evOn); }
  } else { f.since = 0; if (f.on) { f.on = false; if (evOff) logEvent(evOff); } }
}
const num = (v) => typeof v === 'number' && Number.isFinite(v);
let prev = null; let cleanT0 = 0;

function derive(t) {
  const T = state.settings.thresholds; const L = state.settings.location;
  if (prev) {
    if (t.estop !== prev.estop) logEvent(t.estop ? { type: 'estop', sev: 'crit', msg: 'Emergency stop is active' } : { type: 'estop', sev: 'info', msg: 'Emergency stop released' });
    if (t.mode !== prev.mode) {
      if (t.mode === 'fault') logEvent({ type: TYPES[t.fault] ? t.fault : 'fault', sev: 'crit', msg: `Fault: ${t.fault || 'unknown'}. The tracker stopped` });
      else if (t.mode === 'stow') logEvent({ type: 'wind_stow', sev: 'warn', msg: 'Tracker moved to the safe (stow) position' });
      else logEvent({ type: 'mode', sev: 'info', msg: `Mode changed to ${t.mode}` });
    }
    const was = prev.cleaning === 'running';
    if (t.cleaning === 'running' && !was) { cleanT0 = Date.now(); logEvent({ type: 'clean_start', msg: 'Cleaning cycle started' }); }
    if (was && t.cleaning !== 'running') {
      const dur = Math.round((Date.now() - cleanT0) / 1000); const ok = t.cleaning !== 'fault';
      logEvent({ type: 'clean_done', sev: ok ? 'info' : 'warn', msg: ok ? `Cleaning cycle finished (${dur} s)` : 'Cleaning cycle stopped early' });
      H.addClean({ ts: Date.now(), src: 'device', dur, ok }).then(() => emit('cleans'));
    }
  }
  prev = { estop: t.estop, mode: t.mode, cleaning: t.cleaning };

  cond('mismatch', num(t.imu_pitch_deg) && num(t.el_deg) && Math.abs(t.imu_pitch_deg - t.el_deg) > T.mismatch_deg,
    { type: 'mismatch', msg: `IMU and elevation differ by ${num(t.imu_pitch_deg) ? Math.abs(t.imu_pitch_deg - t.el_deg).toFixed(1) : '?'} degrees` },
    { type: 'mismatch', sev: 'info', msg: 'Angle mismatch cleared' }, 20000);
  cond('water', num(t.water_pct) && t.water_pct <= T.low_water_pct,
    { type: 'low_water', msg: `Cleaning water at ${t.water_pct} percent` }, { type: 'low_water', sev: 'info', msg: 'Water level restored' });
  cond('wind', num(t.wind_ms) && t.wind_ms >= T.wind_stow_ms,
    { type: 'wind_stow', msg: `Wind ${t.wind_ms} m/s is above the stow limit (${T.wind_stow_ms})` }, { type: 'wind_stow', sev: 'info', msg: 'Wind is below the stow limit again' });
  cond('overcurrent', num(t.current_a) && t.current_a > T.overcurrent_a,
    { type: 'overcurrent', msg: `Current ${t.current_a} A is above the limit (${T.overcurrent_a} A)` }, null, 4000);
  cond('rain', t.rain === true, { type: 'rain', msg: 'Rain detected' }, { type: 'rain', sev: 'info', msg: 'Rain stopped' });
  if (num(t.lat) && num(t.lon) && num(L.lat) && num(L.lon)) {
    const d = distanceM(t.lat, t.lon, L.lat, L.lon);
    cond('gps', d > T.gps_move_m, { type: 'gps_move', msg: `Device is ${Math.round(d)} m from the installed position` },
      { type: 'gps_move', sev: 'info', msg: 'Device is back at the installed position' });
  }
}

let seenOnline = false; let wasOnline = false;
function watchOnline() {
  const o = isOnline();
  if (o) seenOnline = true;
  if (seenOnline && o !== wasOnline) logEvent(o ? { type: 'online', msg: 'Device is online' } : { type: 'offline', msg: 'Device went offline' });
  wasOnline = o;
}

// ---------- the Events tab ----------
const fmt = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });

function render() {
  const ft = $('evType').value; const fs = $('evSev').value;
  const rows = list.filter((e) => (ft === 'all' || e.type === ft) && (fs === 'all' || e.sev === fs));
  const ul = $('evList'); ul.innerHTML = '';
  if (!rows.length) { ul.innerHTML = '<li class="note">No events yet.</li>'; }
  rows.slice(0, 150).forEach((e) => {
    const li = document.createElement('li'); li.className = 'ev ' + e.sev + (e.ts > lastRead ? ' unread' : '');
    const [label] = TYPES[e.type] || TYPES.info;
    li.innerHTML = '<b></b><span class="msg"></span><small></small>';
    li.querySelector('b').textContent = label; li.querySelector('.msg').textContent = e.msg;
    li.querySelector('small').textContent = `${fmt(e.ts)} · ${e.src}`;
    ul.appendChild(li);
  });
  const unread = list.filter((e) => e.ts > lastRead && SEV[e.sev] >= 1).length;
  const b = $('evBadge'); b.textContent = unread > 99 ? '99+' : unread; b.classList.toggle('hidden', unread === 0);
}

function markRead() { lastRead = Date.now(); localStorage.setItem('solmate.eventsRead', lastRead); render(); }
const saveNotif = () => S.save('notif', notif);

export async function initEvents() {
  const sel = $('evType'); sel.innerHTML = '<option value="all">All types</option>' + Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('');
  list = await H.events();
  $('evType').onchange = $('evSev').onchange = render;
  $('evRead').onclick = markRead;
  $('evClear').onclick = async () => { if (await confirmDlg('Clear the event log?', 'All stored events on this device will be deleted.', 'Clear')) { await H.clearStore('events'); list = []; render(); toast('Event log cleared'); } };
  $('evCsv').onclick = () => download('solmate-events.csv', toCSV(list, [
    { label: 'time_iso', get: (e) => new Date(e.ts).toISOString() }, { label: 'type', get: (e) => e.type }, { label: 'severity', get: (e) => e.sev },
    { label: 'message', get: (e) => e.msg }, { label: 'source', get: (e) => e.src }]));
  const n = { nEnabled: 'enabled', nSound: 'sound', nVib: 'vibrate' };
  Object.entries(n).forEach(([id, k]) => { $(id).checked = !!notif[k]; $(id).onchange = () => { notif[k] = $(id).checked; saveNotif(); }; });
  $('nSev').value = notif.minSev; $('nSev').onchange = () => { notif.minSev = $('nSev').value; saveNotif(); };
  $('nPerm').onclick = async () => {
    if (!('Notification' in window)) return toast('This browser does not support notifications', 'bad');
    const r = await Notification.requestPermission(); toast(r === 'granted' ? 'System notifications allowed' : 'Notifications not allowed (' + r + ')', r === 'granted' ? 'ok' : 'bad');
    permNote();
  };
  $('nTest').onclick = () => { logEvent({ type: 'info', sev: 'crit', msg: 'This is a test alert', src: 'test', ts: Date.now() }); lastByType.delete('info:crit'); };
  permNote();
  on('telemetry', derive);
  on('devEvent', (p) => { if (p && p.type) logEvent({ type: p.type, sev: p.sev, msg: p.msg || p.type, src: 'device', ts: p.ts ? p.ts * (p.ts < 1e12 ? 1000 : 1) : undefined, data: p.data }); });
  on('events', render);
  on('imported', async () => { list = await H.events(); render(); });
  setInterval(watchOnline, 1000);
  document.querySelector('.tabs [data-tab="events"]').addEventListener('click', () => setTimeout(markRead, 1500));
  render();
}

function permNote() {
  $('nNote').textContent = !('Notification' in window) ? 'System notifications are not supported here. In-app alerts still work.'
    : Notification.permission === 'granted' ? 'System notifications are allowed. They appear when the app is in the background.'
      : Notification.permission === 'denied' ? 'System notifications are blocked in the browser settings for this site.' : 'System notifications are not enabled yet.';
}

export const eventList = () => list;
export async function reloadEvents() { list = await H.events(); render(); }
