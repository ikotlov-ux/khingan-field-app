/* Offline app-shell cache + tile cache + Background Sync upload for Habitat 32. Bump CACHE on every release. */
const CACHE = 'fp-shell-v31';
const TILES = 'fp-tiles';
const SHELL = [
  './', './index.html', './app.js', './i18n.js', './habitats.js', './sync-core.js', './manifest.webmanifest',
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
  if (url.origin === self.location.origin && /\/habitats\.js$/.test(url.pathname)) {
    // Habitat database: network first (auto-update), cache as fallback.
    e.respondWith(fetch(new Request(url.href, { cache: 'no-cache' })).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(new Request(url.pathname), copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (url.origin === self.location.origin) {
    // App shell: network first (so updates arrive on the next online start), cache fallback offline / after 4 s.
    e.respondWith((async () => {
      const cached = caches.match(req, { ignoreSearch: true });
      try {
        // cache:'no-cache' revalidates with GitHub Pages instead of reusing the browser's 10-minute HTTP cache
        const res = await Promise.race([fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      } catch (_) {
        return (await cached) || fetch(req);
      }
    })());
  } else if (/tile\.openstreetmap\.org|arcgisonline\.com|tianditu\.gov\.cn/.test(url.host)) {
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
