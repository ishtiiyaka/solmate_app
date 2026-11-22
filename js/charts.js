// Small canvas chart helpers: line chart (with hover), grouped bar chart. No libraries, works offline.
export const COLORS = { accent: '#f0b429', blue: '#58a6ff', green: '#3fb950', red: '#f85149', purple: '#bc8cff', muted: '#8b949e' };
const GRID = '#2a313c'; const TEXT = '#8b949e';

function setup(canvas, h) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 600;
  canvas.style.height = h + 'px'; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  g.font = '12px system-ui, Arial, sans-serif';
  return { g, w, h };
}

export function niceTicks(min, max, n = 5) {
  if (!(max > min)) max = min + 1;
  const raw = (max - min) / n; const mag = 10 ** Math.floor(Math.log10(raw)); const f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out = []; for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}

function empty(g, w, h, text) { g.fillStyle = TEXT; g.textAlign = 'center'; g.fillText(text, w / 2, h / 2); g.textAlign = 'left'; }

// series: [{name,color,pts:[[x,y]..],width,dashed}]  opts: {h,xMin,xMax,yMin,yMax,xFmt,yFmt,gapMs,hline,markers,emptyText,xTicks}
export function lineChart(canvas, series, opts = {}) {
  const h = opts.h || 220; const { g, w } = setup(canvas, h);
  const all = series.flatMap((s) => s.pts);
  if (!all.length) { empty(g, w, h, opts.emptyText || 'No data in this range'); return null; }
  const xMin = opts.xMin ?? Math.min(...all.map((p) => p[0])); const xMax = opts.xMax ?? Math.max(...all.map((p) => p[0]));
  let yMin = opts.yMin ?? Math.min(0, ...all.map((p) => p[1])); let yMax = opts.yMax ?? Math.max(...all.map((p) => p[1]), yMin + 1) * 1.08;
  if (opts.hline) yMax = Math.max(yMax, opts.hline.value * 1.1);
  const L = 46; const Rr = 10; const T = 12 + (series.length > 1 ? 16 : 0); const B = 24;
  const sx = (x) => L + ((x - xMin) / (xMax - xMin || 1)) * (w - L - Rr);
  const sy = (y) => h - B - ((y - yMin) / (yMax - yMin || 1)) * (h - B - T);
  const yFmt = opts.yFmt || ((v) => String(+v.toFixed(1))); const xFmt = opts.xFmt || ((v) => String(Math.round(v)));

  const draw = (hx) => {
    g.clearRect(0, 0, w, h); g.font = '12px system-ui, Arial, sans-serif'; g.lineWidth = 1;
    g.strokeStyle = GRID; g.fillStyle = TEXT; g.textAlign = 'right';
    niceTicks(yMin, yMax, 4).forEach((v) => { const y = sy(v); g.beginPath(); g.moveTo(L, y); g.lineTo(w - Rr, y); g.stroke(); g.fillText(yFmt(v), L - 6, y + 4); });
    const nx = opts.xTicks || 4;
    for (let i = 0; i <= nx; i++) {
      const v = xMin + ((xMax - xMin) * i) / nx;
      g.textAlign = i === 0 ? 'left' : i === nx ? 'right' : 'center';           // keep the first and last label inside the chart
      g.fillText(xFmt(v), i === 0 ? L : i === nx ? w - Rr : sx(v), h - 7);
    }
    g.textAlign = 'left'; let lx = L;
    if (opts.hline) { const y = sy(opts.hline.value); g.strokeStyle = opts.hline.color || COLORS.red; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(L, y); g.lineTo(w - Rr, y); g.stroke(); g.setLineDash([]); g.fillStyle = opts.hline.color || COLORS.red; g.fillText(opts.hline.label || '', L + 4, y - 4); }
    series.forEach((s) => {
      g.strokeStyle = s.color || COLORS.accent; g.lineWidth = s.width || 2; g.setLineDash(s.dashed ? [6, 4] : []); g.beginPath();
      const step = Math.max(1, Math.floor(s.pts.length / 1500)); let prev = null;
      for (let i = 0; i < s.pts.length; i += step) {
        const [x, y] = s.pts[i];
        if (prev === null || (opts.gapMs && x - prev > opts.gapMs)) g.moveTo(sx(x), sy(y)); else g.lineTo(sx(x), sy(y));
        prev = x;
      }
      g.stroke(); g.setLineDash([]);
      if (series.length > 1) { g.fillStyle = s.color; g.fillRect(lx, 4, 12, 4); g.fillStyle = TEXT; g.fillText(s.name, lx + 16, 10); lx += 16 + g.measureText(s.name).width + 12; }
    });
    (opts.markers || []).forEach((m) => { g.fillStyle = m.color || COLORS.red; g.beginPath(); g.arc(sx(m.x), sy(m.y), m.r || 5, 0, 7); g.fill(); if (m.label) { g.fillStyle = TEXT; g.fillText(m.label, sx(m.x) + 8, sy(m.y) - 6); } });
    if (hx !== undefined) { g.strokeStyle = TEXT; g.lineWidth = 1; g.beginPath(); g.moveTo(hx, T); g.lineTo(hx, h - B); g.stroke(); }
  };
  draw();

  const nearest = (pts, x) => { let lo = 0; let hi = pts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m][0] < x) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(pts[lo - 1][0] - x) < Math.abs(pts[lo][0] - x) ? pts[lo - 1] : pts[lo]; };
  return {
    at(px) {                                                    // px = pixel x inside the canvas -> text for a tooltip
      const x = xMin + ((px - L) / (w - L - Rr)) * (xMax - xMin);
      if (px < L || px > w - Rr) { draw(); return ''; }
      draw(px);
      return xFmt(x) + '\n' + series.filter((s) => s.pts.length).map((s) => { const p = nearest(s.pts, x); return `${s.name}: ${yFmt(p[1])}`; }).join('\n');
    },
    clear() { draw(); },
  };
}

export function attachHover(canvas, tipEl, chart) {
  canvas.onpointermove = (e) => { if (!chart) return; const r = canvas.getBoundingClientRect(); const t = chart.at(e.clientX - r.left); tipEl.textContent = t; };
  canvas.onpointerleave = () => { if (chart) chart.clear(); tipEl.textContent = ''; };
}

// cats: ['11-13',..]; groups: [{name,color,values:[..]}]
export function barChart(canvas, cats, groups, opts = {}) {
  const h = opts.h || 220; const { g, w } = setup(canvas, h);
  if (!cats.length) { empty(g, w, h, opts.emptyText || 'No data'); return; }
  const L = 46; const Rr = 8; const T = 22; const B = 24;
  const yMax = Math.max(...groups.flatMap((s) => s.values.map((v) => v || 0)), 1) * 1.1;
  const sy = (y) => h - B - (y / yMax) * (h - B - T);
  g.strokeStyle = GRID; g.fillStyle = TEXT; g.textAlign = 'right'; g.lineWidth = 1;
  niceTicks(0, yMax, 4).forEach((v) => { const y = sy(v); g.beginPath(); g.moveTo(L, y); g.lineTo(w - Rr, y); g.stroke(); g.fillText(String(Math.round(v)), L - 6, y + 4); });
  const slot = (w - L - Rr) / cats.length; const bw = Math.max(3, (slot * 0.8) / groups.length);
  cats.forEach((c, i) => {
    groups.forEach((s, gi) => {
      const v = s.values[i] || 0; const x = L + i * slot + slot * 0.1 + gi * bw;
      g.fillStyle = s.color; g.fillRect(x, sy(v), bw - 1, h - B - sy(v));
    });
    g.fillStyle = TEXT; g.textAlign = 'center'; g.fillText(c, L + i * slot + slot / 2, h - 7);
  });
  g.textAlign = 'left';
  let lx = L;
  groups.forEach((s) => { g.fillStyle = s.color; g.fillRect(lx, 6, 12, 4); g.fillStyle = TEXT; g.fillText(s.name, lx + 16, 12); lx += 16 + g.measureText(s.name).width + 12; });
}
