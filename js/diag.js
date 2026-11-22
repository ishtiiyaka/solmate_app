// Diagnostics (Week 9): link test (round trip and loss on each link), E-stop timing, link log, report download.
import { $, link, state, dev, on, diagLog, toast, download, confirmDlg } from './core.js';
import * as S from './store.js';
import { toCSV } from './analysis.js';

const waiters = new Map();
let runs = S.load('linktests', { list: [] }).list || [];
let busy = false;

export function initDiag() {
  on('ack', (p, via) => { const w = waiters.get(p.id); if (w && w.route === via) { waiters.delete(p.id); w.done(performance.now() - w.t0); } });
  $('dgLocal').onclick = () => runTest('local'); $('dgCloud').onclick = () => runTest('cloud');
  $('dgCsv').onclick = () => download('solmate-link-tests.csv', toCSV(runs, [
    { label: 'time_iso', get: (r) => new Date(r.ts).toISOString() }, { label: 'link', get: (r) => r.route }, { label: 'situation', get: (r) => r.label },
    { label: 'sent', get: (r) => r.sent }, { label: 'received', get: (r) => r.got }, { label: 'loss_pct', get: (r) => r.loss },
    { label: 'min_ms', get: (r) => r.min }, { label: 'avg_ms', get: (r) => r.avg }, { label: 'median_ms', get: (r) => r.med },
    { label: 'p95_ms', get: (r) => r.p95 }, { label: 'max_ms', get: (r) => r.max }, { label: 'jitter_ms', get: (r) => r.jit }]));
  $('dgClear').onclick = async () => { if (await confirmDlg('Delete test results?', 'All saved link tests will be removed.', 'Delete')) { runs = []; S.save('linktests', { list: runs }); renderRuns(); } };
  $('dgReport').onclick = report;
  on('diag', renderLog); on('estopms', renderEstop); on('render', renderBtns);
  renderRuns(); renderLog(); renderEstop(); renderBtns();
}

function ping(route, timeout = 3000) {
  return new Promise((resolve) => {
    const id = 'p' + Math.random().toString(36).slice(2, 8);
    const to = setTimeout(() => { waiters.delete(id); resolve(null); }, timeout);
    waiters.set(id, { route, t0: performance.now(), done: (ms) => { clearTimeout(to); resolve(ms); } });
    if (!link.sendVia(route, 'cmd/ping', { id, t: Date.now() }, { qos: 1 })) { clearTimeout(to); waiters.delete(id); resolve(null); }
  });
}

async function runTest(route) {
  if (busy) return;
  const st = route === 'local' ? link.local.state : link.cloud.state;
  if (st !== 'up') return toast(`The ${route} link is not connected`, 'bad');
  busy = true; renderBtns(); const N = 20; const rtts = []; $('dgStatus').textContent = `Testing ${route}...`;
  for (let i = 0; i < N; i++) {
    const r = await ping(route); if (r !== null) rtts.push(r);
    $('dgStatus').textContent = `Testing ${route}: ${i + 1}/${N}`;
    await new Promise((r2) => setTimeout(r2, 250));
  }
  busy = false;
  const s = [...rtts].sort((a, b) => a - b); const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  const sd = s.length ? Math.sqrt(s.reduce((a, b) => a + (b - avg) ** 2, 0) / s.length) : 0; const f = (v) => +v.toFixed(1);
  const run = { ts: Date.now(), route, label: $('dgLabel').value.trim() || '-', sent: N, got: s.length, loss: f(((N - s.length) / N) * 100),
    min: s.length ? f(s[0]) : '', avg: s.length ? f(avg) : '', med: s.length ? f(s[s.length >> 1]) : '', p95: s.length ? f(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]) : '', max: s.length ? f(s[s.length - 1]) : '', jit: f(sd) };
  runs.unshift(run); runs = runs.slice(0, 30); S.save('linktests', { list: runs });
  $('dgStatus').textContent = s.length ? `Done: ${s.length}/${N} replies, average ${run.avg} ms.` : 'No replies. Is the device (or simulator) running?';
  renderRuns(); renderBtns();
}

function renderRuns() {
  const ul = $('dgRuns'); ul.innerHTML = '';
  if (!runs.length) { ul.innerHTML = '<li class="note">No tests yet.</li>'; return; }
  runs.slice(0, 8).forEach((r) => {
    const li = document.createElement('li'); li.className = 'ev ' + (r.loss > 0 ? 'warn' : 'info'); li.innerHTML = '<b></b><span class="msg"></span><small></small>';
    li.querySelector('b').textContent = r.route; li.querySelector('.msg').textContent = `avg ${r.avg} ms, p95 ${r.p95} ms, loss ${r.loss}% (${r.got}/${r.sent})`;
    li.querySelector('small').textContent = `${new Date(r.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · ${r.label}`; ul.appendChild(li);
  });
}
function renderBtns() { $('dgLocal').disabled = busy || link.local.state !== 'up'; $('dgCloud').disabled = busy || link.cloud.state !== 'up'; }
function renderEstop() { $('dgEstop').textContent = dev.estopMs ? `${dev.estopMs} ms (press E-STOP to message-back time, last measured)` : 'not measured yet. Press E-STOP once while connected.'; }
function renderLog() { $('dgLog').textContent = diagLog.slice(0, 30).map((l) => `${new Date(l.ts).toLocaleTimeString()}  ${l.msg}`).join('\n') || 'No link events yet.'; }

function report() {
  const t = dev.tel || {};
  const txt = [`SolMate diagnostics report ${new Date().toISOString()}`, `App version ${S.VERSION}`, `Page ${location.href}`, `Browser ${navigator.userAgent}`,
    `Online (browser) ${navigator.onLine}`, `Route ${link.route || 'none'}`, `Cloud ${link.statusText('cloud')} ${link.cloud.error}`, `Local ${link.statusText('local')} ${link.local.error}`,
    `Device mode ${t.mode} estop ${t.estop} fault ${t.fault} settings rev ${t.rev}`, `Last E-stop round trip ${dev.estopMs || 'n/a'} ms`, '', 'Link tests:',
    ...runs.map((r) => `${new Date(r.ts).toISOString()} ${r.route} [${r.label}] avg ${r.avg} p95 ${r.p95} loss ${r.loss}%`), '', 'Link log:',
    ...diagLog.map((l) => `${new Date(l.ts).toISOString()} ${l.msg}`)].join('\n');
  download('solmate-diagnostics.txt', txt, 'text/plain');
}
