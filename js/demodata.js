// Synthetic multi-day data so charts, gain and soiling can be shown without a long real run (Week 5).
import { solarPosition, startOfDay, cosIncidence } from './sun.js';

const R = Math.PI / 180;
const CLOUD = [1, 1, 0.55, 0.92, 1, 0.35, 0.95];              // per-day clearness: clear, clear, cloudy, hazy, clear, overcast, clear
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

export function makeDemo({ days = 7, stepS = 60, lat, lon, tz, rated = 300, endTs = Date.now(), cleanDay = 3 }) {
  seed = 7;
  const start = startOfDay(new Date(endTs), tz).getTime() - days * 86400000;
  const samples = []; const cleans = [];
  cleans.push({ ts: start + cleanDay * 86400000 + 7.5 * 3600000, src: 'demo', dur: 95, ok: true, note: 'Demo cleaning' });
  for (let t = start; t <= endTs; t += stepS * 1000) {
    const pos = solarPosition(new Date(t), lat, lon);
    if (pos.el <= 3) continue;
    const d = Math.floor((t - start) / 86400000);
    const cf = CLOUD[d % CLOUD.length] * (CLOUD[d % CLOUD.length] < 0.8 ? 0.8 + 0.4 * rnd() : 1);
    const g = Math.max(0, 1000 * Math.pow(Math.sin(pos.el * R), 0.35) * cf * (0.985 + 0.03 * rnd()));
    const sinceClean = d >= cleanDay ? d - cleanDay + ((t - start) % 86400000) / 86400000 : d + 5 + ((t - start) % 86400000) / 86400000;
    const soil = 1 - 0.006 * sinceClean;
    const p = rated * (g / 1000) * soil * 0.97;
    const pf = rated * (g / 1000) * soil * cosIncidence(pos.az, pos.el, lat, 180);
    const v = 18 + (rnd() - 0.5) * 0.6;
    samples.push({ ts: t, src: 'demo', p: +p.toFixed(1), v: +v.toFixed(2), i: +(p / v).toFixed(2),
      az: +Math.min(270, Math.max(90, pos.az)).toFixed(1), el: +Math.min(85, Math.max(5, pos.el)).toFixed(1),
      t: +(22 + 18 * (g / 1000) + rnd()).toFixed(1), m: 'auto', pf: +pf.toFixed(1), g: +g.toFixed(0) });
  }
  const ev = (dayI, hh, type, sev, msg) => ({ ts: start + dayI * 86400000 + hh * 3600000, type, sev, msg, src: 'demo' });
  const events = [
    ev(1, 11.2, 'wind_stow', 'warn', 'Wind 13.1 m/s above the stow threshold. Panel moved to the safe position'),
    ev(1, 12.4, 'wind_stow', 'info', 'Wind back to normal. Tracking resumed'),
    ev(2, 9.8, 'mismatch', 'warn', 'Angle mismatch 6.2 degrees between IMU and encoder for 20 s'),
    ev(3, 7.5, 'clean_done', 'info', 'Cleaning cycle finished (95 s)'),
    ev(4, 14.1, 'low_water', 'warn', 'Cleaning water at 18 percent'),
    ev(5, 10.3, 'stall', 'crit', 'Elevation actuator stall detected. Motor stopped'),
    ev(5, 10.4, 'estop', 'crit', 'Emergency stop pressed'),
    ev(5, 10.9, 'estop', 'info', 'Emergency stop released'),
  ].filter((e) => e.ts < endTs);
  return { samples, cleans, events };
}
