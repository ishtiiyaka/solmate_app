// Calibration wizard (Week 4). The DEVICE records the positions; the app only guides and shows the result.
import { $, state, dev, on, emit, controlState, command, attachJog, stopAll, toast, saveSettings } from './core.js';
import * as S from './store.js';
import { logEvent } from './events.js';

const STEPS = [
  { id: 'intro', title: 'Before you start' },
  { id: 'el_min', title: 'Elevation: low end stop' },
  { id: 'el_max', title: 'Elevation: high end stop' },
  { id: 'az_min', title: 'Azimuth: first end stop' },
  { id: 'az_max', title: 'Azimuth: last end stop' },
  { id: 'imu', title: 'Level the IMU' },
  { id: 'azref', title: 'Azimuth reference' },
  { id: 'review', title: 'Review and save' },
];
let i = 0; let started = false; let busy = false;
const dlg = () => $('dlgCalib');
const marks = () => (dev.calib && dev.calib.marks) || {};

const HELP = {
  el_min: 'Jog the elevation DOWN slowly until just before the mechanical end stop. Tap "Mark here". Keep your hand near the power switch.',
  el_max: 'Jog the elevation UP slowly until just before the upper end stop. Tap "Mark here".',
  az_min: 'Jog the azimuth to the first end (east side). Move slowly. Tap "Mark here".',
  az_max: 'Jog the azimuth to the other end (west side). Tap "Mark here".',
  imu: 'Use a spirit level on the panel frame and jog elevation until the panel is truly level. Then tap "Zero IMU". The tilt sensor reading will be set to match the elevation angle.',
  azref: 'Point the panel at a known direction using a compass (true south is 180\u00b0 in the northern hemisphere; allow for magnetic declination). Enter that angle and tap "Set reference".',
};

export function initWizard() {
  attachJog($('wJog'));
  $('wStop').onclick = stopAll;
  $('calibOpen').onclick = openWizard;
  $('wBack').onclick = () => { if (i > 0 && !busy) { i--; render(); } };
  $('wCancel').onclick = cancel;
  dlg().oncancel = (e) => { e.preventDefault(); cancel(); };
  $('wAction').onclick = act;
  on('telemetry', live);
  on('calib', () => { if (dlg().open) render(); });
}

function openWizard() {
  const cs = controlState();
  if (!cs.modeOk) return toast(cs.why, 'bad');
  i = 0; started = false; busy = false;
  render(); dlg().showModal(); live();
}

async function cancel() {
  stopAll();
  if (started) await command('cmd/calib', { action: 'cancel' }, { qos: 1 });
  started = false; dlg().close();
}

function live() {
  const t = dev.tel || {};
  $('wAz').textContent = t.az_deg ?? '--'; $('wEl').textContent = t.el_deg ?? '--'; $('wImu').textContent = t.imu_pitch_deg ?? '--';
}

function render() {
  const s = STEPS[i];
  $('wTitle').textContent = `${i + 1}/${STEPS.length}  ${s.title}`;
  $('wDots').innerHTML = STEPS.map((_, k) => `<i class="${k < i ? 'done' : k === i ? 'cur' : ''}"></i>`).join('');
  const body = $('wBody');
  $('wJog').classList.toggle('hidden', s.id === 'intro' || s.id === 'review');
  $('wBack').disabled = i === 0;
  const m = marks();
  if (s.id === 'intro') {
    body.innerHTML = '<p>This teaches the tracker where its mechanical limits are. It moves the tracker, so:</p>' +
      '<label class="check"><input type="checkbox" id="wOk"> The area around the tracker is clear and I can reach the power switch.</label>' +
      '<p class="note">The app will switch the device to Manual mode. Movement stops when you release a button.</p>';
    $('wAction').textContent = 'Start';
  } else if (s.id === 'azref') {
    body.innerHTML = `<p>${HELP.azref}</p><label>Current true azimuth (degrees)<input id="wRef" type="number" value="180" step="0.5"></label>`;
    $('wAction').textContent = 'Set reference';
  } else if (s.id === 'review') {
    const rows = ['az_min', 'az_max', 'el_min', 'el_max'].map((k) => `<tr><td>${k.replace('_', ' ')}</td><td><b>${m[k] ?? 'not marked'}</b></td></tr>`).join('');
    body.innerHTML = `<table class="marks">${rows}<tr><td>IMU offset</td><td><b>${dev.calib ? dev.calib.imu_offset : '--'}</b></td></tr></table>` +
      '<p class="note">Saving makes these the device\'s hard limits. The app then sets your soft limits 2\u00b0 inside them. Publish the settings afterwards.</p>';
    $('wAction').textContent = 'Save calibration';
  } else {
    body.innerHTML = `<p>${HELP[s.id]}</p>` + (m[s.id] !== undefined ? `<p class="note">Already marked at <b>${m[s.id]}\u00b0</b>. Marking again replaces it.</p>` : '');
    $('wAction').textContent = s.id === 'imu' ? 'Zero IMU' : 'Mark here';
  }
}

async function act() {
  if (busy) return;
  const s = STEPS[i]; const t = dev.tel || {};
  busy = true; $('wAction').disabled = true;
  try {
    if (s.id === 'intro') {
      if (!$('wOk').checked) return toast('Tick the box to continue', 'bad');
      if (t.mode !== 'manual') { const r = await command('cmd/mode', { mode: 'manual' }, { qos: 1 }); if (!r.ok) return; }
      const r = await command('cmd/calib', { action: 'start' }, { qos: 1 }); if (!r.ok) return;
      started = true; i++;
    } else if (['el_min', 'el_max', 'az_min', 'az_max'].includes(s.id)) {
      const m = marks();
      if (s.id === 'el_max' && t.el_deg - m.el_min < 5) return toast('Move the elevation well away from the low mark first', 'bad');
      if (s.id === 'az_max' && t.az_deg - m.az_min < 5) return toast('Move the azimuth well away from the first mark first', 'bad');
      const r = await command('cmd/calib', { action: 'mark', what: s.id }, { qos: 1 }); if (!r.ok) return;
      i++;
    } else if (s.id === 'imu') {
      const r = await command('cmd/calib', { action: 'zero_imu' }, { qos: 1 }); if (!r.ok) return;
      i++;
    } else if (s.id === 'azref') {
      const v = Number($('wRef').value);
      if (!Number.isFinite(v) || v < 0 || v > 360) return toast('Enter an angle from 0 to 360', 'bad');
      const r = await command('cmd/calib', { action: 'set_az_ref', az: v }, { qos: 1 }); if (!r.ok) return;
      i++;
    } else if (s.id === 'review') {
      const r = await command('cmd/calib', { action: 'commit' }, { qos: 1 }); if (!r.ok) return;
      finish();
      return;
    }
    render();
  } finally { busy = false; $('wAction').disabled = false; }
}

function finish() {
  const m = marks(); const L = state.settings.limits;
  S.save('calib', { at: Date.now(), marks: { ...m }, imu_offset: dev.calib ? dev.calib.imu_offset : 0 });
  L.az_min = Math.ceil(m.az_min + 2); L.az_max = Math.floor(m.az_max - 2);
  L.el_min = Math.ceil(m.el_min + 2); L.el_max = Math.floor(m.el_max - 2);
  saveSettings(); started = false; dlg().close();
  logEvent({ type: 'calib', msg: `Calibration saved: azimuth ${m.az_min}-${m.az_max}, elevation ${m.el_min}-${m.el_max}` });
  emit('limits'); emit('calibdone');
  toast('Calibration saved. Go to Settings and press Publish to send the new limits.', 'ok', 6000);
}
