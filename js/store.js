// Settings, presets and validation. Everything is kept in localStorage on this phone/laptop.
export const VERSION = '1.0.0';
export const PREFIX = 'solmate/unit1';

export const CONN_DEFAULTS = {
  cloudUrl: 'ws://localhost:9001',      // dev broker from Week 1. Change to wss://<cluster>.s1.hivemq.cloud:8884/mqtt
  cloudUser: '',
  cloudPass: '',
  localUrl: 'ws://localhost:8081',      // simulator's ESP32-style link. Real device: ws://<esp32-ip>:8081
  localEnabled: true,
};

export const DEVICE_DEFAULTS = {
  rev: 0,
  location: { lat: 31.5204, lon: 74.3587, tz: 'Asia/Karachi' },
  limits: { az_min: 90, az_max: 270, el_min: 5, el_max: 85 },
  thresholds: { confirm_az: 30, confirm_el: 20, wind_stow_ms: 12, low_water_pct: 20, mismatch_deg: 5, overcurrent_a: 5,
    gps_move_m: 50, clean_interval_days: 14, soil_threshold_pct: 95, panel_rated_w: 300 },
  pid: { az: { kp: 1.0, ki: 0.0, kd: 0.0 }, el: { kp: 1.0, ki: 0.0, kd: 0.0 } },
};

export const NOTIFY_DEFAULTS = { enabled: true, sound: true, vibrate: true, minSev: 'warn' };
export const SEC_DEFAULTS = { on: false, salt: '', hash: '', salt2: '', iters: 150000, idleMin: 5, tries: 0, until: 0 };

export const DEFAULT_PRESETS = [
  { name: 'Stow', az: 180, el: 10 },
  { name: 'Morning', az: 110, el: 30 },
  { name: 'Noon', az: 180, el: 60 },
  { name: 'Evening', az: 250, el: 30 },
];

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function merge(base, extra) {            // fills missing keys so old saved data never breaks the app
  const out = clone(base);
  for (const k in extra || {}) {
    if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], extra[k]);
    else out[k] = extra[k];
  }
  return out;
}

export function load(key, defaults) {
  try {
    const raw = localStorage.getItem('solmate.' + key);
    if (!raw) return clone(defaults);
    const v = JSON.parse(raw);
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    return isObj(defaults) && isObj(v) ? merge(defaults, v) : v;     // defaults only merge into plain objects
  } catch { return clone(defaults); }
}

export function save(key, value) {
  try { localStorage.setItem('solmate.' + key, JSON.stringify(value)); return true; } catch { return false; }
}

export function loadPresets() {
  try {
    const raw = localStorage.getItem('solmate.presets');
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : clone(DEFAULT_PRESETS);
  } catch { return clone(DEFAULT_PRESETS); }
}
export function savePresets(list) { return save('presets', list); }

export function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
export function setPath(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
  target[last] = value;
}

// Returns a list of {path, msg}. Empty list = settings are safe to publish.
export function validate(s) {
  const e = []; const n = (p) => getPath(s, p);
  const need = (p, lo, hi, label) => {
    const v = n(p);
    if (typeof v !== 'number' || !Number.isFinite(v)) e.push({ path: p, msg: `${label} must be a number` });
    else if (v < lo || v > hi) e.push({ path: p, msg: `${label} must be between ${lo} and ${hi}` });
  };
  need('location.lat', -90, 90, 'Latitude');
  need('location.lon', -180, 180, 'Longitude');
  if (!n('location.tz')) e.push({ path: 'location.tz', msg: 'Choose a time zone' });
  need('limits.az_min', 0, 360, 'Azimuth min'); need('limits.az_max', 0, 360, 'Azimuth max');
  need('limits.el_min', 0, 90, 'Elevation min'); need('limits.el_max', 0, 90, 'Elevation max');
  if (n('limits.az_min') >= n('limits.az_max')) e.push({ path: 'limits.az_max', msg: 'Azimuth max must be greater than min' });
  if (n('limits.el_min') >= n('limits.el_max')) e.push({ path: 'limits.el_max', msg: 'Elevation max must be greater than min' });
  need('thresholds.confirm_az', 1, 360, 'Azimuth confirm'); need('thresholds.confirm_el', 1, 90, 'Elevation confirm');
  need('thresholds.wind_stow_ms', 1, 60, 'Wind stow'); need('thresholds.low_water_pct', 0, 100, 'Low water');
  need('thresholds.mismatch_deg', 0.5, 45, 'Mismatch'); need('thresholds.overcurrent_a', 0.1, 30, 'Over-current');
  need('thresholds.gps_move_m', 5, 5000, 'GPS movement'); need('thresholds.clean_interval_days', 1, 120, 'Cleaning interval');
  need('thresholds.soil_threshold_pct', 50, 100, 'Soiling threshold'); need('thresholds.panel_rated_w', 10, 1000, 'Panel rated power');
  for (const ax of ['az', 'el']) {
    need(`pid.${ax}.kp`, 0, 100, `${ax.toUpperCase()} Kp`);
    need(`pid.${ax}.ki`, 0, 100, `${ax.toUpperCase()} Ki`);
    need(`pid.${ax}.kd`, 0, 100, `${ax.toUpperCase()} Kd`);
  }
  return e;
}
