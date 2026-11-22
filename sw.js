// Service worker: caches the app files so the app opens instantly and also with no internet.
// Live data (MQTT / WebSocket) is not touched by this file.
// IMPORTANT: change VERSION every time you change any app file, otherwise phones keep the old copy.
const VERSION = 'solmate-v1.0.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/core.js', 'js/link.js', 'js/store.js', 'js/settings.js', 'js/wizard.js', 'js/history.js', 'js/historyview.js',
  'js/sun.js', 'js/charts.js', 'js/analysis.js', 'js/demodata.js', 'js/events.js', 'js/mapview.js', 'js/care.js', 'js/security.js', 'js/diag.js',
  'vendor/mqtt.min.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// stale-while-revalidate: answer from cache at once, refresh the cache in the background
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || fresh;
    }));
});

// A tap on a system notification brings the app to the front.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list.length ? list[0].focus() : self.clients.openWindow('./'))));
});
