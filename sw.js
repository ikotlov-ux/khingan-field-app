/* Offline app-shell cache for Habitat 32. Bump CACHE on every release. */
const CACHE = 'fp-shell-v6';
const SHELL = [
  './', './index.html', './app.js', './classes.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-180.png',
  './vendor/ol.js', './vendor/ol.css', './vendor/jszip.min.js'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
  } else {
    // Map tiles: network first, fall back to whatever is cached.
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && /tile\.openstreetmap\.org|arcgisonline\.com/.test(url.host)) caches.open('fp-tiles').then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req)));
  }
});
