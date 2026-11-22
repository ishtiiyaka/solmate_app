// Browser storage (IndexedDB v2): samples (history), events (alerts log), cleans (cleaning log).
// Samples marked src:'demo' or src:'csv' are never auto-deleted.
const DB = 'solmate-history';
let db = null;

export const keepDays = () => Number(localStorage.getItem('solmate.keepDays')) || 30;

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB not available'));
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('samples')) d.createObjectStore('samples', { keyPath: 'ts' });
      if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { keyPath: 'id', autoIncrement: true }).createIndex('ts', 'ts');
      if (!d.objectStoreNames.contains('cleans')) d.createObjectStore('cleans', { keyPath: 'ts' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function init() {
  try { db = await open(); await prune(); return true; } catch (e) { console.warn('history disabled', e); return false; }
}
export const ready = () => !!db;

// ---- generic helpers ----
export async function bulkPut(name, list) {
  if (!db || !list.length) return 0;
  const tx = db.transaction(name, 'readwrite'); const s = tx.objectStore(name);
  list.forEach((x) => s.put(x));
  await done(tx); return list.length;
}
export async function clearStore(name) { if (db) await wrap(store(name, 'readwrite').clear()); }
export async function count(name = 'samples') { return db ? wrap(store(name).count()) : 0; }
export async function deleteWhere(name, pred) {
  if (!db) return 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite'); let n = 0;
    const c = tx.objectStore(name).openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) return; if (pred(cur.value)) { cur.delete(); n++; } cur.continue(); };
    tx.oncomplete = () => resolve(n); tx.onerror = () => reject(tx.error);
  });
}

// ---- samples ----
export async function add(sample) { if (db) try { await wrap(store('samples', 'readwrite').put(sample)); } catch (e) { console.warn(e); } }
export async function range(fromMs, toMs = Infinity) {
  if (!db) return [];
  const rng = toMs === Infinity ? IDBKeyRange.lowerBound(fromMs) : IDBKeyRange.bound(fromMs, toMs);
  return wrap(store('samples').getAll(rng));
}
export async function prune() {
  if (!db) return;
  const cutoff = Date.now() - keepDays() * 86400000;
  await deleteWhere('samples', (x) => x.ts < cutoff && !x.src);
}
export async function bounds() {
  if (!db) return { first: null, last: null };
  const edge = (dir) => new Promise((res) => { const c = store('samples').openCursor(null, dir); c.onsuccess = () => res(c.result ? c.result.key : null); c.onerror = () => res(null); });
  return { first: await edge('next'), last: await edge('prev') };
}

// ---- events ----
export async function addEvent(ev) {
  if (!db) return null;
  const id = await wrap(store('events', 'readwrite').add(ev));
  if ((await count('events')) > 1200) {                         // keep the newest 1000
    const all = await wrap(store('events').getAll()); all.sort((a, b) => a.ts - b.ts);
    const drop = new Set(all.slice(0, all.length - 1000).map((x) => x.id));
    await deleteWhere('events', (x) => drop.has(x.id));
  }
  return id;
}
export async function events() {
  if (!db) return [];
  const all = await wrap(store('events').getAll()); return all.sort((a, b) => b.ts - a.ts);
}

// ---- cleaning log ----
export const addClean = (c) => (db ? wrap(store('cleans', 'readwrite').put(c)) : null);
export async function cleans() { if (!db) return []; const a = await wrap(store('cleans').getAll()); return a.sort((x, y) => x.ts - y.ts); }
