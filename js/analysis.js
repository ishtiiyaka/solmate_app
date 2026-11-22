// Energy, tracking gain, soiling and CSV helpers. Pure functions: no DOM, easy to test.
import { dayKey } from './sun.js';

const MAX_GAP_MS = 5 * 60 * 1000;           // a gap longer than this is "no data", not interpolated

export function energyWh(samples, key = 'p') {
  let wh = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]; const b = samples[i]; const dt = b.ts - a.ts;
    if (dt <= 0 || dt > MAX_GAP_MS || typeof a[key] !== 'number' || typeof b[key] !== 'number') continue;
    wh += ((a[key] + b[key]) / 2) * (dt / 3600000);
  }
  return wh;
}

// One row per local day: tracker energy, fixed-panel energy, gain %.
export function dailySummary(samples, tz) {
  const by = new Map();
  for (const s of samples) { const k = dayKey(s.ts, tz); if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
  const rows = [...by.entries()].sort().map(([date, list]) => {
    list.sort((a, b) => a.ts - b.ts);
    const pairs = list.filter((s) => typeof s.pf === 'number' && typeof s.p === 'number');
    const eT = energyWh(list, 'p'); const eF = energyWh(pairs, 'pf');
    const eTpaired = energyWh(pairs, 'p');                                    // like-for-like with the fixed panel
    return { date, n: list.length, eT, eF, hasFixed: pairs.length > 1 && eF > 0,
      gain: pairs.length > 1 && eF > 0 ? ((eTpaired - eF) / eF) * 100 : null,
      peak: Math.max(0, ...list.map((s) => s.p || 0)) };
  });
  return rows;
}

export function totalGain(rows) {
  const r = rows.filter((x) => x.hasFixed);
  if (!r.length) return null;
  const eT = r.reduce((a, x) => a + x.eT, 0); const eF = r.reduce((a, x) => a + x.eF, 0);
  return { eT, eF, gain: ((eT - eF) / eF) * 100, days: r.length };
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Soiling ratio = today's normalised efficiency / efficiency just after the last cleaning.
// Normalised efficiency = power / (irradiance/1000 * rated power), median of the sunny part of each day.
export function soiling(samples, cleans, tz, rated, thresholdPct = 95) {
  const by = new Map();
  for (const s of samples) {
    if (typeof s.p !== 'number' || typeof s.g !== 'number' || s.g < 500) continue;
    const eta = s.p / ((s.g / 1000) * rated);
    if (eta > 0 && eta < 1.5) { const k = dayKey(s.ts, tz); if (!by.has(k)) by.set(k, []); by.get(k).push(eta); }
  }
  const days = [...by.entries()].filter(([, v]) => v.length >= 5).sort().map(([date, v]) => ({ date, eta: median(v) }));
  const out = { days, status: 'need_data', baseline: null, current: null, slope: null, daysToThreshold: null, lastClean: null, daysSinceClean: null };
  if (cleans.length) out.lastClean = cleans[cleans.length - 1].ts;
  if (days.length < 2) return out;
  const startKey = out.lastClean ? dayKey(out.lastClean, tz) : days[0].date;
  const epoch = days.filter((d) => d.date >= startKey);
  if (epoch.length < 2) { out.status = 'need_data'; return out; }
  const base = median(epoch.slice(0, 2).map((d) => d.eta)); out.baseline = base;
  const d0 = Date.parse(epoch[0].date + 'T00:00:00Z');
  epoch.forEach((d) => { d.sr = d.eta / base; d.x = (Date.parse(d.date + 'T00:00:00Z') - d0) / 86400000; });
  out.days = epoch; out.current = epoch[epoch.length - 1].sr; out.status = 'ok';
  out.daysSinceClean = out.lastClean ? (Date.now() - out.lastClean) / 86400000 : null;
  if (epoch.length >= 3) {
    const n = epoch.length; const sx = epoch.reduce((a, d) => a + d.x, 0); const sy = epoch.reduce((a, d) => a + d.sr, 0);
    const sxy = epoch.reduce((a, d) => a + d.x * d.sr, 0); const sxx = epoch.reduce((a, d) => a + d.x * d.x, 0);
    const den = n * sxx - sx * sx;
    if (den) {
      const slope = (n * sxy - sx * sy) / den; const b = (sy - slope * sx) / n; out.slope = slope;
      const thr = thresholdPct / 100;
      if (slope < -1e-5 && out.current > thr) out.daysToThreshold = Math.max(0, (thr - b) / slope - epoch[epoch.length - 1].x);
      else if (out.current <= thr) out.daysToThreshold = 0;
    }
  }
  return out;
}

// ---------- CSV ----------
const q = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function toCSV(rows, cols) { return [cols.map((c) => c.label).join(','), ...rows.map((r) => cols.map((c) => q(c.get(r))).join(','))].join('\r\n') + '\r\n'; }

export function parseCSV(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export const SAMPLE_COLS = [
  { label: 'time_iso', get: (s) => new Date(s.ts).toISOString() }, { label: 'ts_ms', get: (s) => s.ts },
  { label: 'power_w', get: (s) => s.p }, { label: 'voltage_v', get: (s) => s.v }, { label: 'current_a', get: (s) => s.i },
  { label: 'az_deg', get: (s) => s.az }, { label: 'el_deg', get: (s) => s.el }, { label: 'temp_c', get: (s) => s.t },
  { label: 'mode', get: (s) => s.m }, { label: 'fixed_power_w', get: (s) => s.pf }, { label: 'irradiance_wm2', get: (s) => s.g },
];

const pick = (r, ...keys) => { for (const k of keys) if (r[k] !== undefined && r[k] !== '') return r[k]; return undefined; };
const num = (v) => { if (v === undefined) return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };

// Turn parsed CSV rows into samples. Returns {samples, skipped}.
export function rowsToSamples(rows) {
  const samples = []; let skipped = 0;
  for (const r of rows) {
    let ts = num(pick(r, 'ts_ms', 'ts'));
    if (ts === undefined) { const iso = pick(r, 'time_iso', 'timestamp', 'time', 'datetime', 'date_time'); ts = iso ? Date.parse(iso) : NaN; }
    if (!Number.isFinite(ts) || ts <= 0) { skipped++; continue; }
    const s = { ts, src: 'csv', p: num(pick(r, 'power_w', 'p', 'power')), v: num(pick(r, 'voltage_v', 'v', 'voltage')), i: num(pick(r, 'current_a', 'i', 'current')),
      az: num(pick(r, 'az_deg', 'az')), el: num(pick(r, 'el_deg', 'el')), t: num(pick(r, 'temp_c', 't', 'temp')), m: pick(r, 'mode', 'm'),
      pf: num(pick(r, 'fixed_power_w', 'pf', 'fixed_w', 'fixed_power')), g: num(pick(r, 'irradiance_wm2', 'g', 'irradiance')) };
    Object.keys(s).forEach((k) => s[k] === undefined && delete s[k]);
    samples.push(s);
  }
  return { samples, skipped };
}
