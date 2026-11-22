// Map view and GPS movement check (Week 6). Tiles come from OpenStreetMap when online; offline shows a plain grid.
import { $, state, dev, on, toast, confirmDlg, saveSettings, emit } from './core.js';
import { distanceM } from './sun.js';

const TILE = 256;
let zoom = 16; let lastSig = '';
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function tileXY(lat, lon, z) {
  const n = 2 ** z; const rl = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(rl) + 1 / Math.cos(rl)) / Math.PI) / 2) * n };
}
const mPerPx = (lat, z) => (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

export function initMap() {
  $('mapIn').onclick = () => { zoom = Math.min(18, zoom + 1); lastSig = ''; renderMap(); };
  $('mapOut').onclick = () => { zoom = Math.max(3, zoom - 1); lastSig = ''; renderMap(); };
  $('mapSet').onclick = async () => {
    const t = dev.tel || {};
    if (!num(t.lat) || !num(t.lon)) return toast('The device is not sending a GPS position', 'bad');
    if (!(await confirmDlg('Set the installed position?', `Use the device GPS (${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}) as the installed location. Press Publish in Settings afterwards so the device gets it too.`, 'Set'))) return;
    state.settings.location.lat = +t.lat.toFixed(5); state.settings.location.lon = +t.lon.toFixed(5);
    saveSettings(); emit('limits'); lastSig = ''; renderMap(); toast('Installed position updated', 'ok');
  };
  on('render', renderMap);
}

export function renderMap() {
  const box = $('mapBox'); const W = box.clientWidth; if (!W) return;
  const H = 240; const L = state.settings.location; const t = dev.tel || {};
  if (!num(L.lat) || !num(L.lon)) return;
  const hasGps = num(t.lat) && num(t.lon);
  const dist = hasGps ? distanceM(t.lat, t.lon, L.lat, L.lon) : 0;
  const limit = state.settings.thresholds.gps_move_m;
  let z = zoom; let c = { lat: L.lat, lon: L.lon };
  if (hasGps && dist > limit) {                                   // moved: centre between both points, zoom out to fit
    c = { lat: (L.lat + t.lat) / 2, lon: (L.lon + t.lon) / 2 };
    for (z = 17; z > 3; z--) if (dist / mPerPx(c.lat, z) < Math.min(W, H) * 0.6) break;
  }
  const sig = [W, z, c.lat.toFixed(5), c.lon.toFixed(5), hasGps ? t.lat.toFixed(5) + t.lon.toFixed(5) : '-', L.lat, L.lon].join('|');
  $('mapInfo').textContent = !hasGps ? 'No GPS from the device. Showing the installed position.'
    : dist > limit ? `MOVED: the device is ${Math.round(dist)} m from the installed position (limit ${limit} m).` : `At the installed position (${Math.round(dist)} m away, limit ${limit} m).`;
  $('mapInfo').className = 'note' + (hasGps && dist > limit ? ' warn' : '');
  if (sig === lastSig) return;
  lastSig = sig;

  const cp = tileXY(c.lat, c.lon, z); const n = 2 ** z;
  box.innerHTML = '';
  const cols = Math.ceil(W / TILE / 2) + 1; const rows = Math.ceil(H / TILE / 2) + 1;
  for (let dx = -cols; dx <= cols; dx++) for (let dy = -rows; dy <= rows; dy++) {
    const tx = Math.floor(cp.x) + dx; const ty = Math.floor(cp.y) + dy;
    if (ty < 0 || ty >= n) continue;
    const img = document.createElement('img'); img.className = 'tile'; img.alt = ''; img.loading = 'lazy';
    img.style.left = Math.round(W / 2 + (tx - cp.x) * TILE) + 'px'; img.style.top = Math.round(H / 2 + (ty - cp.y) * TILE) + 'px';
    img.onerror = () => img.remove();
    img.src = `https://tile.openstreetmap.org/${z}/${((tx % n) + n) % n}/${ty}.png`;
    box.appendChild(img);
  }
  const pin = (lat, lon, cls, label) => {
    const p = tileXY(lat, lon, z); const d = document.createElement('div'); d.className = 'pin ' + cls; d.title = label;
    d.style.left = Math.round(W / 2 + (p.x - cp.x) * TILE) + 'px'; d.style.top = Math.round(H / 2 + (p.y - cp.y) * TILE) + 'px'; box.appendChild(d);
  };
  pin(L.lat, L.lon, 'home', 'Installed position');
  if (hasGps) pin(t.lat, t.lon, 'dev', 'Device GPS');
  const at = document.createElement('div'); at.className = 'attrib'; at.textContent = '\u00a9 OpenStreetMap contributors'; box.appendChild(at);
}
