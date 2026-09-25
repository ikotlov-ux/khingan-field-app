/* Offline app-shell cache + tile cache + Background Sync upload for Habitat 32. Bump CACHE on every release. */
const CACHE = 'fp-shell-v19';
const TILES = 'fp-tiles';
const SHELL = [
  './', './index.html', './app.js', './i18n.js', './classes.js', './sync-core.js', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png', './lab-logo.png',
  './vendor/ol.js', './vendor/ol.css', './vendor/jszip.min.js', './vendor/piexif.js', './vendor/qrcode.js'
];
importScripts('./sync-core.js');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // App shell: cache first, fall back to network and refresh cache.
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    })));
  } else if (/tile\.openstreetmap\.org|arcgisonline\.com/.test(url.host)) {
    // Map tiles: network first, fall back to whatever is cached.
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) caches.open(TILES).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req)));
  }
  // Everything else (Yandex Disk API etc.): default network handling.
});

// Background Sync: upload the outbox when connectivity returns, even if the page is closed (Chrome/Android).
self.addEventListener('sync', (e) => {
  if (e.tag !== 'h32-upload') return;
  e.waitUntil((async () => {
    const db = await H32Sync.openDb();
    if (!db.objectStoreNames.contains('outbox') || !db.objectStoreNames.contains('meta')) return;
    const token = await H32Sync.getMeta(db, 'ytoken');
    if (!token) return;
    if (!(await H32Sync.count(db, 'outbox'))) return;
    try {
      await H32Sync.processOutbox(db, token);
      const cs = await self.clients.matchAll({ type: 'window' });
      cs.forEach((c) => c.postMessage({ type: 'synced', at: Date.now() }));
    } catch (err) {
      if (err && err.name === 'AuthError') return; // do not retry with a bad token
      throw err;                                     // let the browser retry later
    }
  })());
});
