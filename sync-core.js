/* Habitat 32 — Yandex Disk upload core. Shared by the page (app.js) and the service worker (sw.js).
 * Uploads every item of the IndexedDB "outbox" store ({path, blob, updated}) to Yandex Disk via the REST API:
 *   PUT  /v1/disk/resources?path=<dir>            (create folders, 409 = exists)
 *   GET  /v1/disk/resources/upload?path=<file>&overwrite=true  -> {href, method}
 *   PUT  <href> body=blob
 */
(function (root) {
  'use strict';
  const API = 'https://cloud-api.yandex.net/v1/disk/resources';
  const DB_NAME = 'field-points';

  function openDb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME); // current version; the page performs upgrades
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function req(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  const getAll = (db, store) => req(db, store, 'readonly', (s) => s.getAll());
  const get = (db, store, key) => req(db, store, 'readonly', (s) => s.get(key));
  const put = (db, store, obj) => req(db, store, 'readwrite', (s) => s.put(obj));
  const del = (db, store, key) => req(db, store, 'readwrite', (s) => s.delete(key));
  const count = (db, store) => req(db, store, 'readonly', (s) => s.count());
  async function getMeta(db, key) { const r = await get(db, 'meta', key); return r ? r.value : null; }
  const putMeta = (db, key, value) => put(db, 'meta', { key, value });

  class AuthError extends Error { constructor(m) { super(m); this.name = 'AuthError'; } }

  function hdr(token) { return { Authorization: 'OAuth ' + token }; }
  async function check(r, what) {
    if (r.status === 401 || r.status === 403) throw new AuthError(what + ' ' + r.status);
    return r;
  }
  const dirCache = new Set();
  async function ensureDir(token, dir) {
    if (dirCache.has(dir)) return;
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      if (dirCache.has(cur)) continue;
      const r = await check(await fetch(`${API}?path=${encodeURIComponent(cur)}`, { method: 'PUT', headers: hdr(token) }), 'mkdir');
      if (!(r.ok || r.status === 409)) throw new Error(`mkdir ${cur}: HTTP ${r.status}`);
      dirCache.add(cur);
    }
    dirCache.add(dir);
  }
  async function uploadOne(token, path, blob) {
    const full = path.startsWith('/') ? path : '/' + path;
    await ensureDir(token, full.slice(0, full.lastIndexOf('/')));
    const r = await check(await fetch(`${API}/upload?path=${encodeURIComponent(full)}&overwrite=true`, { headers: hdr(token) }), 'upload-url');
    if (!r.ok) throw new Error(`upload-url: HTTP ${r.status}`);
    const { href, method } = await r.json();
    const u = await fetch(href, { method: method || 'PUT', body: blob });
    if (!(u.ok || u.status === 201 || u.status === 202)) throw new Error(`put: HTTP ${u.status}`);
  }

  /** Upload all outbox items. Items re-queued while uploading (newer `updated`) are kept for the next run. */
  async function processOutbox(db, token, onProgress) {
    const items = (await getAll(db, 'outbox')).sort((a, b) => (a.updated || 0) - (b.updated || 0));
    let done = 0;
    for (const it of items) {
      await uploadOne(token, it.path, it.blob);
      const cur = await get(db, 'outbox', it.path);
      if (cur && cur.updated === it.updated) await del(db, 'outbox', it.path);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
    await putMeta(db, 'lastSync', Date.now());
    await putMeta(db, 'lastError', null);
    return done;
  }

  root.H32Sync = { openDb, getAll, get, put, del, count, getMeta, putMeta, processOutbox, AuthError };
})(typeof self !== 'undefined' ? self : window);
