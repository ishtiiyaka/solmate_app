// App security (Week 8): PIN lock, encrypted cloud password, auto-lock, read-only mode, checklist.
// Honest scope: the PIN protects the app on a shared phone and the saved broker password. The broker login
// and (where available) broker topic rules are what really protect the tracker.
import { $, state, dev, link, hooks, toast, confirmDlg, saveConn } from './core.js';
import * as S from './store.js';

const enc = new TextEncoder(); const dec = new TextDecoder();
let sec = S.load('sec', S.SEC_DEFAULTS);
let key = null;                       // AES key, only in memory while unlocked
let viewOnlySession = false; let lastAct = Date.now(); let hiddenAt = 0; let onUnlocked = () => {};

export const available = () => !!(globalThis.crypto && crypto.subtle);
export const pinOn = () => !!sec.on;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const saveSec = () => S.save('sec', sec);

async function base(pin) { return crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits', 'deriveKey']); }
async function hashOf(pin, salt) { return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: sec.iters }, await base(pin), 256)); }
async function keyOf(pin, salt) { return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: sec.iters }, await base(pin), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
async function encryptText(text) { const iv = rand(12); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)); return { iv: b64(iv), ct: b64(ct) }; }
async function decryptText(o) { return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.ct))); }

// connection settings are stored without the password; the password is stored encrypted
async function persistConn() {
  if (sec.on && key) {
    const c = { ...state.conn }; const pass = c.cloudPass; c.cloudPass = '';
    S.save('conn', c); S.save('connsec', pass ? await encryptText(pass) : null);
  } else { S.save('conn', state.conn); S.save('connsec', null); }
}

async function verify(pin) {
  if (Date.now() < sec.until) return { ok: false, wait: Math.ceil((sec.until - Date.now()) / 1000) };
  const ok = (await hashOf(pin, sec.salt)) === sec.hash;
  if (ok) { sec.tries = 0; sec.until = 0; saveSec(); return { ok: true }; }
  sec.tries++; if (sec.tries >= 5) sec.until = Date.now() + Math.min(900, 30 * 2 ** (sec.tries - 5)) * 1000;
  saveSec(); return { ok: false, wait: sec.until > Date.now() ? Math.ceil((sec.until - Date.now()) / 1000) : 0, left: Math.max(0, 5 - sec.tries) };
}

// ---------- lock screen ----------
function showLock(msg = '') { state.locked = true; $('lock').classList.remove('hidden'); $('lockMsg').textContent = msg; $('lockPin').value = ''; setTimeout(() => $('lockPin').focus(), 50); refreshHeader(); }
function hideLock() { state.locked = false; $('lock').classList.add('hidden'); refreshHeader(); }
function refreshHeader() {
  const b = $('lockBtn'); b.classList.toggle('hidden', !sec.on);
  b.textContent = state.locked || viewOnlySession ? 'Unlock' : 'Lock';
}

async function tryUnlock() {
  const pin = $('lockPin').value.trim(); if (!pin) return;
  const r = await verify(pin);
  if (!r.ok) { $('lockMsg').textContent = r.wait ? `Too many tries. Wait ${r.wait} s.` : `Wrong PIN. ${r.left} tries left before a delay.`; $('lockPin').value = ''; return; }
  key = await keyOf(pin, sec.salt2);
  const stored = S.load('connsec', null);
  try { state.conn.cloudPass = stored && stored.ct ? await decryptText(stored) : state.conn.cloudPass || ''; } catch { state.conn.cloudPass = ''; toast('Could not read the saved cloud password. Enter it again in Settings.', 'bad'); }
  const wasView = viewOnlySession; viewOnlySession = false; state.readOnly = localStorage.getItem('solmate.readonly') === '1';
  hideLock(); lastAct = Date.now();
  if (wasView) link.stop();
  onUnlocked(true);
}

export function lockNow() { if (!sec.on || !key) return; showLock(); }

export function initLock(callback) {
  onUnlocked = callback;
  $('lockGo').onclick = tryUnlock;
  $('lockPin').onkeydown = (e) => { if (e.key === 'Enter') tryUnlock(); };
  $('lockView').onclick = () => { viewOnlySession = true; state.readOnly = true; hideLock(); onUnlocked(false); toast('View only. Use Unlock to control the tracker.'); };
  $('lockBtn').onclick = () => { if (state.locked || viewOnlySession) showLock(); else lockNow(); };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { lastAct = Date.now(); }, { passive: true }));
  setInterval(() => { if (sec.on && key && !state.locked && !viewOnlySession && sec.idleMin > 0 && Date.now() - lastAct > sec.idleMin * 60000) lockNow(); }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (sec.on && key && sec.idleMin > 0 && hiddenAt && Date.now() - hiddenAt > sec.idleMin * 60000) lockNow();
  });
  hooks.saveConn = persistConn;
  refreshHeader();
  if (sec.on) { showLock(); return true; }     // PIN set: wait for unlock before connecting
  return false;
}

// ---------- Settings > Security panel ----------
const chk = (k) => localStorage.getItem('solmate.chk.' + k) === '1';

export function initSecurityPanel() {
  $('roToggle').checked = state.readOnly && localStorage.getItem('solmate.readonly') === '1';
  $('roToggle').onchange = () => { localStorage.setItem('solmate.readonly', $('roToggle').checked ? '1' : '0'); state.readOnly = $('roToggle').checked; toast(state.readOnly ? 'Read-only mode on' : 'Read-only mode off'); renderPanel(); };
  $('idleSel').value = String(sec.idleMin); $('idleSel').onchange = () => { sec.idleMin = Number($('idleSel').value); saveSec(); renderPanel(); };
  ['sep', 'acl', 'pw'].forEach((k) => { const el = $('chk_' + k); el.checked = chk(k); el.onchange = () => { localStorage.setItem('solmate.chk.' + k, el.checked ? '1' : '0'); renderPanel(); }; });

  $('pinSet').onclick = async () => {
    if (!available()) return toast('A PIN needs HTTPS or localhost (the browser blocks encryption on plain http addresses)', 'bad');
    const p = $('pinNew').value.trim(); const p2 = $('pinNew2').value.trim();
    if (!/^\d{4,8}$/.test(p)) return toast('The PIN must be 4 to 8 digits', 'bad');
    if (p !== p2) return toast('The two PINs do not match', 'bad');
    if (sec.on) { const r = await verify($('pinOld').value.trim()); if (!r.ok) return toast('Current PIN is wrong', 'bad'); }
    const salt = b64(rand(16)); const salt2 = b64(rand(16));
    sec = { ...S.SEC_DEFAULTS, ...sec, on: true, salt, salt2, tries: 0, until: 0 }; sec.hash = await hashOf(p, salt); key = await keyOf(p, salt2); saveSec();
    await persistConn(); ['pinNew', 'pinNew2', 'pinOld'].forEach((i) => { $(i).value = ''; });
    refreshHeader(); renderPanel(); toast('PIN saved. The cloud password is now stored encrypted.', 'ok');
  };
  $('pinRemove').onclick = async () => {
    if (!sec.on) return;
    const r = await verify($('pinOld').value.trim()); if (!r.ok) return toast('Enter the current PIN in the Current PIN box first', 'bad');
    if (!(await confirmDlg('Remove the PIN?', 'The app will no longer lock, and the cloud password will be stored unencrypted again.', 'Remove'))) return;
    sec = { ...S.SEC_DEFAULTS }; saveSec(); key = null; await persistConn(); $('pinOld').value = ''; refreshHeader(); renderPanel(); toast('PIN removed');
  };
  link.on('state', () => { if ($('tab-set').classList.contains('active')) renderPanel(); });
  renderPanel();
}

export function renderPanel() {
  $('secState').textContent = !available() ? 'PIN is not available here (needs HTTPS or localhost).' : sec.on ? `PIN is on. Auto-lock ${sec.idleMin ? 'after ' + sec.idleMin + ' min idle' : 'is off'}.` : 'No PIN set.';
  $('pinOldRow').classList.toggle('hidden', !sec.on); $('pinRemove').classList.toggle('hidden', !sec.on);
  const c = state.conn; const url = c.cloudUrl || '';
  const local = /^wss?:\/\/(localhost|127\.0\.0\.1)/i.test(url);
  const items = [
    [!url ? null : /^wss:/i.test(url) ? true : local ? null : false, 'Cloud connection is encrypted (wss://)', local ? 'localhost test broker, fine for development' : ''],
    [location.protocol === 'https:' || location.hostname === 'localhost' ? true : false, 'App is served over HTTPS (or localhost)', ''],
    [sec.on, 'PIN lock is enabled', ''],
    [sec.on && !!S.load('connsec', null) ? true : (!c.cloudPass ? null : false), 'Cloud password is stored encrypted on this device', 'needs a PIN'],
    [sec.on && sec.idleMin > 0, 'Auto-lock timer is on', ''],
    [chk('sep'), 'Phone uses its own broker login, not the device login', 'confirm by ticking'],
    [chk('acl'), 'Broker topic rules restrict what the phone login can publish', 'confirm by ticking'],
    [chk('pw'), 'Test and shared passwords have been changed', 'confirm by ticking'],
  ];
  $('secList').innerHTML = items.map(([ok, text, hint]) => `<li class="ev ${ok === true ? 'info' : ok === false ? 'warn' : ''}"><b>${ok === true ? 'OK' : ok === false ? 'FIX' : 'n/a'}</b><span class="msg">${text}</span><small>${hint}</small></li>`).join('');
}
