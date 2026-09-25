/* Habitat 32 — field points, track and photos for Bolshoy Khingan
 * OpenLayers map with offline tile prefetch, geolocation, IndexedDB + OPFS storage, CSV/GPX/ZIP export,
 * Web Share, in-app camera with compass overlay + EXIF, automatic upload to Yandex Disk.
 * UI languages: Russian / Chinese (i18n.js). Static, no build step. Requires HTTPS.
 */
(function () {
  'use strict';

  // ---------- constants ----------
  const OBSERVER_KEY = 'fp_observer';
  const LANG_KEY = 'fp_lang';
  const TRACK_MIN_SECONDS = 5;
  const TRACK_MIN_METERS = 5;
  const DB_NAME = 'field-points';
  const DB_VERSION = 3;
  const YD_ROOT = 'IPEE/Habitat32';               // Yandex Disk folder
  const YD_CLIENT_ID = '1a41c4a990134194996b23e022088a33'; // Yandex OAuth app "Habitat 32"
  const SYNC_DEBOUNCE_MS = 150 * 1000;             // quiet period after points/photos before upload
  const SYNC_TRACK_MS = 15 * 60 * 1000;            // track-only changes: at most every 15 min
  const SYNC_BACKOFF_MIN = [1, 5, 15, 60];
  const PREFETCH_ZOOMS = [15, 14, 13, 12, 11, 10];
  const PREFETCH_RADIUS_M = 2500;
  const PREFETCH_MAX = 500;
  const CAM_FOV_H = 50;                            // approx. horizontal field of view of a phone camera in portrait, degrees
  const MAX_SIDE = 1600;

  // ---------- i18n ----------
  const I18N = window.H32_I18N || { ru: {}, zh: {} };
  let lang = localStorage.getItem(LANG_KEY) || 'ru';
  if (!I18N[lang]) lang = 'ru';
  function t(key, params) {
    let s = (I18N[lang] && I18N[lang][key]) || (I18N.ru && I18N.ru[key]) || key;
    if (params) for (const k of Object.keys(params)) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
    return s;
  }
  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'ru';
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
  }

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  function todayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fileDate(d = new Date()) { return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`; }
  function localDateTime(d) { return `${todayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function hm(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function safeName(s) { return String(s || 'Observer').trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'Observer'; }
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function xmlEsc(s) { return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])); }
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function setStatus(msg, isError) { const el = $('status'); el.textContent = msg; el.style.color = isError ? '#ff8a80' : ''; }
  function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} }
  const S = window.H32Sync;

  // ---------- IndexedDB ----------
  let db;
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('points')) d.createObjectStore('points', { keyPath: 'id', autoIncrement: true }).createIndex('byDay', ['observer', 'date_local'], { unique: false });
        if (!d.objectStoreNames.contains('track')) d.createObjectStore('track', { keyPath: 'id', autoIncrement: true }).createIndex('byDay', ['observer', 'date_local'], { unique: false });
        if (!d.objectStoreNames.contains('photos')) {
          const p = d.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
          p.createIndex('byDay', ['observer', 'date_local'], { unique: false });
          p.createIndex('byPoint', 'point_id', { unique: false });
        }
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbAdd(store, obj) {
    return new Promise((resolve, reject) => {
      const r = db.transaction(store, 'readwrite').objectStore(store).add(obj);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  function dbGetDay(store, observer, day) {
    return new Promise((resolve, reject) => {
      const r = db.transaction(store, 'readonly').objectStore(store).index('byDay').getAll(IDBKeyRange.only([observer, day]));
      r.onsuccess = () => resolve(r.result.sort((a, b) => a.id - b.id)); r.onerror = () => reject(r.error);
    });
  }
  function dbDeleteDay(store, observer, day) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const r = tx.objectStore(store).index('byDay').openCursor(IDBKeyRange.only([observer, day]));
      r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  }

  // ---------- OPFS mirror (best effort) ----------
  let opfsRoot = null;
  async function initOpfs() {
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        opfsRoot = await navigator.storage.getDirectory();
        if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
      }
    } catch (_) { opfsRoot = null; }
  }
  async function opfsWrite(name, text) {
    if (!opfsRoot) return;
    try { const fh = await opfsRoot.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close(); } catch (_) {}
  }
  async function opfsRemove(name) { if (!opfsRoot) return; try { await opfsRoot.removeEntry(name); } catch (_) {} }

  // ---------- state ----------
  let observer = null;
  let day = todayKey();
  let points = [];
  let track = [];
  let photos = [];
  let tracking = false;
  let watchId = null;
  let lastFix = null;
  let wakeLock = null;
  let firstFixCentered = false;

  const classes = (window.HABITAT_CLASSES || []).slice();
  const classById = new Map(classes.map((c) => [String(c.id), c]));
  function className(p) {
    const c = classById.get(String(p.class_id));
    if (lang === 'zh') return p.class_zh || (c && c.zh) || p.class_en || '';
    return p.class_ru || (c && c.ru) || p.class_en || '';
  }

  // ---------- compass ----------
  const RUMBS = [
    { en: 'N', ru: 'С', zh: '北' }, { en: 'NE', ru: 'СВ', zh: '东北' }, { en: 'E', ru: 'В', zh: '东' }, { en: 'SE', ru: 'ЮВ', zh: '东南' },
    { en: 'S', ru: 'Ю', zh: '南' }, { en: 'SW', ru: 'ЮЗ', zh: '西南' }, { en: 'W', ru: 'З', zh: '西' }, { en: 'NW', ru: 'СЗ', zh: '西北' }
  ];
  function rumbOf(h) { return RUMBS[Math.round(((h % 360) + 360) % 360 / 45) % 8]; }
  const rumbLabel = (r) => (lang === 'zh' ? r.zh : r.ru);
  let heading = null, headingAt = 0, compassOn = false;
  const D2R = Math.PI / 180;
  // W3C "compass heading of the device's back" for a phone held upright (portrait).
  function backHeading(alpha, beta, gamma) {
    const x = (beta || 0) * D2R, y = (gamma || 0) * D2R, z = (alpha || 0) * D2R;
    const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    const Vx = -cZ * sY - sZ * sX * cY, Vy = -sZ * sY + cZ * sX * cY;
    let h = Math.atan(Vx / Vy);
    if (Vy < 0) h += Math.PI; else if (Vx < 0) h += 2 * Math.PI;
    return h / D2R;
  }
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading; // iOS
    else if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) h = backHeading(e.alpha, e.beta, e.gamma);
    if (h == null) return;
    heading = ((h % 360) + 360) % 360; headingAt = Date.now();
    updateCompassUi();
  }
  async function startCompass() {
    if (compassOn) return;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
    } catch (_) {}
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient, true);
    window.addEventListener('deviceorientation', onOrient, true);
    compassOn = true;
    $('compassState').textContent = `${t('compass')}: …`;
  }
  function updateCompassUi() {
    $('compassState').textContent = heading == null ? `${t('compass')}: —` : `${t('compass')}: ${Math.round(heading)}° ${rumbLabel(rumbOf(heading))}`;
    if ($('camModal').classList.contains('hidden')) return;
    if (heading == null) { $('camRumb').firstChild.nodeValue = '—'; $('camRumbSub').textContent = compassOn ? t('cam_wait') : t('cam_none'); }
    else { $('camRumb').firstChild.nodeValue = rumbLabel(rumbOf(heading)); $('camRumbSub').textContent = `${Math.round(heading)}${t('cam_mag')}`; }
    $('roseDial').setAttribute('transform', `rotate(${heading == null ? 0 : -heading} 50 50)`);
    drawCamOverlay();
  }
  // Vertical lines for the 8 rumbs + frames of photos already taken at this point (for overlap planning).
  function drawCamOverlay() {
    const svg = $('camOverlay');
    const W = svg.clientWidth || window.innerWidth, H = svg.clientHeight || window.innerHeight;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (heading == null) { svg.innerHTML = ''; return; }
    const pxPerDeg = W / CAM_FOV_H;
    const diff = (a) => ((a - heading + 540) % 360) - 180;
    let s = '';
    const p = selectedPoint();
    const taken = p ? photos.filter((x) => x.point_id === p.id && x.heading_deg != null) : [];
    taken.forEach((ph, i) => {
      const d = diff(ph.heading_deg);
      if (Math.abs(d) > CAM_FOV_H + 5) return;
      const cx = W / 2 + d * pxPerDeg, half = W / 2, inset = 135 + (i % 5) * 14;
      const x1 = Math.max(2, cx - half), x2 = Math.min(W - 2, cx + half);
      if (x2 - x1 < 4) return;
      s += `<rect x="${x1}" y="${inset}" width="${x2 - x1}" height="${H - inset * 2}" fill="rgba(255,213,79,0.10)" stroke="#ffd54f" stroke-width="2" stroke-dasharray="8 5"/>`;
      s += `<text x="${(x1 + x2) / 2}" y="${inset + 18}" fill="#ffd54f" font-size="14" font-weight="700" text-anchor="middle">#${ph.seq} · ${Math.round(ph.heading_deg)}°</text>`;
    });
    for (let k = 0; k < 8; k++) {
      const a = k * 45, d = diff(a);
      if (Math.abs(d) > CAM_FOV_H / 2 + 3) continue;
      const x = W / 2 + d * pxPerDeg;
      const col = k === 0 ? '#e53935' : '#ffffff';
      s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${col}" stroke-width="${k === 0 ? 3 : 2}" stroke-opacity="0.85"/>`;
      s += `<text x="${x}" y="${H / 2 - 22}" fill="${col}" font-size="22" font-weight="800" text-anchor="middle" stroke="#000" stroke-width="0.6">${rumbLabel(RUMBS[k])}</text>`;
      s += `<text x="${x}" y="${H / 2 + 26}" fill="#fff" font-size="13" text-anchor="middle" stroke="#000" stroke-width="0.4">${a}°</text>`;
    }
    // centre crosshair
    s += `<circle cx="${W / 2}" cy="${H / 2}" r="13" fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2"/>`;
    svg.innerHTML = s;
  }

  // ---------- map ----------
  const pointSource = new ol.source.Vector();
  const trackSource = new ol.source.Vector();
  const posSource = new ol.source.Vector();
  const pointStyle = new ol.style.Style({ image: new ol.style.Circle({ radius: 7, fill: new ol.style.Fill({ color: '#43a047' }), stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 }) }) });
  const trackStyle = new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#1976d2', width: 3 }) });
  const posStyle = (f) => f.get('kind') === 'acc'
    ? new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(25,118,210,0.15)' }), stroke: new ol.style.Stroke({ color: 'rgba(25,118,210,0.6)', width: 1 }) })
    : new ol.style.Style({ image: new ol.style.Circle({ radius: 6, fill: new ol.style.Fill({ color: '#1976d2' }), stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 }) }) });

  const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const osmLayer = new ol.layer.Tile({ source: new ol.source.OSM({ url: OSM_URL, crossOrigin: 'anonymous' }) });
  const satLayer = new ol.layer.Tile({ visible: false, source: new ol.source.XYZ({ url: SAT_URL, attributions: 'Imagery © Esri, Maxar, Earthstar Geographics', maxZoom: 19, crossOrigin: 'anonymous' }) });
  let satOn = localStorage.getItem('fp_basemap') === 'sat';
  function applyBasemap() {
    osmLayer.setVisible(!satOn); satLayer.setVisible(satOn);
    $('baseToggle').textContent = satOn ? t('base_map') : t('base_sat');
    $('baseToggle').classList.toggle('active', satOn);
  }
  const map = new ol.Map({
    target: 'map',
    layers: [osmLayer, satLayer, new ol.layer.Vector({ source: trackSource, style: trackStyle }), new ol.layer.Vector({ source: posSource, style: posStyle }), new ol.layer.Vector({ source: pointSource, style: pointStyle })],
    view: new ol.View({ center: ol.proj.fromLonLat([124.5, 52.0]), zoom: 8 }),
    controls: ol.control.defaults.defaults({ rotate: false, zoom: false })
  });
  $('baseToggle').addEventListener('click', () => { satOn = !satOn; localStorage.setItem('fp_basemap', satOn ? 'sat' : 'osm'); applyBasemap(); });
  $('zoomIn').addEventListener('click', () => map.getView().animate({ zoom: map.getView().getZoom() + 1, duration: 200 }));
  $('zoomOut').addEventListener('click', () => map.getView().animate({ zoom: map.getView().getZoom() - 1, duration: 200 }));
  $('centerMe').addEventListener('click', () => {
    if (!lastFix) { setStatus(t('no_gps'), true); return; }
    map.getView().animate({ center: ol.proj.fromLonLat([lastFix.coords.longitude, lastFix.coords.latitude]), zoom: Math.max(map.getView().getZoom(), 16), duration: 300 });
  });

  const popupEl = $('popup');
  const popup = new ol.Overlay({ element: popupEl, positioning: 'bottom-center', stopEvent: false });
  map.addOverlay(popup);
  map.on('singleclick', (evt) => {
    let hit = null;
    map.forEachFeatureAtPixel(evt.pixel, (f) => { if (f.get('point')) { hit = f; return true; } }, { hitTolerance: 8 });
    if (!hit) { popupEl.classList.add('hidden'); return; }
    const p = hit.get('point');
    const nph = photos.filter((x) => x.point_id === p.id).length;
    popupEl.innerHTML = `<b>#${p.id} · ${xmlEsc(p.class_code)}</b><br>${xmlEsc(className(p))}<br>${xmlEsc(p.time_local)}${p.description ? '<br><i>' + xmlEsc(p.description) + '</i>' : ''}${nph ? `<br>📷 ${nph}` : ''}`;
    $('photoPoint').value = String(p.id);
    refreshPhotoUi();
    popupEl.classList.remove('hidden');
    popup.setPosition(hit.getGeometry().getCoordinates());
  });

  function redrawPoints() {
    pointSource.clear();
    for (const p of points) { const f = new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat([p.longitude, p.latitude]))); f.set('point', p); pointSource.addFeature(f); }
    $('pointCount').textContent = `${t('points_today')}: ${points.length}`;
  }
  function redrawTrack() {
    trackSource.clear();
    if (track.length >= 2) trackSource.addFeature(new ol.Feature(new ol.geom.LineString(track.map((v) => ol.proj.fromLonLat([v.longitude, v.latitude])))));
    $('trackStats').textContent = `${t('track_lbl')}: ${track.length}`;
  }
  function pointLabel(p) { return `#${p.id} · ${p.class_code} · ${p.time_local}`; }
  function refreshPhotoUi(selectId) {
    const sel = $('photoPoint');
    const prev = selectId != null ? String(selectId) : sel.value;
    sel.innerHTML = '';
    if (!points.length) sel.innerHTML = `<option value="">${t('record_first')}</option>`;
    else {
      for (const p of points) {
        const o = document.createElement('option'); o.value = String(p.id);
        const n = photos.filter((x) => x.point_id === p.id).length;
        o.textContent = pointLabel(p) + (n ? ` · 📷${n}` : ''); sel.appendChild(o);
      }
      sel.value = points.some((p) => String(p.id) === prev) ? prev : String(points[points.length - 1].id);
    }
    $('takePhoto').disabled = !points.length;
    const pid = Number(sel.value);
    const nPt = photos.filter((x) => x.point_id === pid).length;
    $('photoCount').textContent = `${t('photos_today')}: ${photos.length}${points.length ? ` · ${t('photos_point')}: ${nPt}` : ''}`;
  }
  $('photoPoint').addEventListener('change', () => refreshPhotoUi());

  function drawPosition(pos) {
    posSource.clear();
    const c = ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]);
    if (pos.coords.accuracy) { const acc = new ol.Feature(new ol.geom.Circle(c, pos.coords.accuracy)); acc.set('kind', 'acc'); posSource.addFeature(acc); }
    const dot = new ol.Feature(new ol.geom.Point(c)); dot.set('kind', 'pos'); posSource.addFeature(dot);
  }

  // ---------- offline tile prefetch (zoom 10–15, view + 2.5 km around centre) ----------
  const tileGrid = ol.tilegrid.createXYZ({ maxZoom: 19 });
  let prefetchRun = 0;
  async function prefetchTiles() {
    if (!navigator.onLine || !('caches' in window)) return;
    const my = ++prefetchRun;
    const view = map.getView();
    const center = view.getCenter();
    const lat = ol.proj.toLonLat(center)[1];
    const r = PREFETCH_RADIUS_M / Math.cos(lat * D2R); // ground metres -> Web Mercator units
    const ext = ol.extent.extend(view.calculateExtent(map.getSize()), [center[0] - r, center[1] - r, center[0] + r, center[1] + r]);
    const urls = [];
    for (const z of PREFETCH_ZOOMS) {
      const tr = tileGrid.getTileRangeForExtentAndZ(ext, z);
      for (let x = tr.minX; x <= tr.maxX; x++) for (let y = tr.minY; y <= tr.maxY; y++) {
        urls.push(OSM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        urls.push(SAT_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      }
    }
    if (urls.length > PREFETCH_MAX) urls.length = PREFETCH_MAX;
    const cache = await caches.open('fp-tiles');
    const missing = [];
    for (const u of urls) if (!(await cache.match(u))) missing.push(u);
    if (my !== prefetchRun) return;
    let done = 0;
    const show = () => { $('tileState').textContent = missing.length ? t('tiles', { a: done, b: missing.length }) : ''; };
    show();
    const worker = async () => {
      while (missing.length && my === prefetchRun && navigator.onLine) {
        const u = missing.shift();
        try { const res = await fetch(u, { mode: 'cors' }); if (res.ok) await cache.put(u, res); } catch (_) {}
        done++; if (done % 5 === 0) show();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (my === prefetchRun) setTimeout(() => { $('tileState').textContent = ''; }, 2500);
  }
  map.on('moveend', () => { if (map.getView().getZoom() >= 9) prefetchTiles(); });
  window.addEventListener('online', () => prefetchTiles());

  // ---------- file builders ----------
  function fileBase() { return `${safeName(observer)}-${fileDate(new Date(day + 'T12:00:00'))}`; }
  function buildCsv() {
    const header = ['observer', 'date_local', 'time_local', 'datetime_utc', 'class_code', 'class_id', 'class_ru', 'class_zh', 'class_en', 'description', 'latitude', 'longitude', 'altitude_m', 'accuracy_m', 'n_photos'];
    const lines = [header.join(',')];
    for (const p of points) {
      const c = classById.get(String(p.class_id)) || {};
      lines.push([
        p.observer, p.date_local, p.time_local, p.datetime_utc, p.class_code, p.class_id, p.class_ru || c.ru || '', p.class_zh || c.zh || '', p.class_en || c.en || '', p.description,
        p.latitude.toFixed(7), p.longitude.toFixed(7), p.altitude_m == null ? '' : p.altitude_m.toFixed(1), p.accuracy_m == null ? '' : p.accuracy_m.toFixed(1),
        photos.filter((x) => x.point_id === p.id).length
      ].map(csvCell).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  function buildPhotosCsv() {
    const header = ['filename', 'observer', 'date_local', 'point_id', 'photo_seq', 'datetime_utc', 'latitude', 'longitude', 'altitude_m', 'accuracy_m', 'heading_deg_magnetic', 'rumb_en', 'rumb_ru', 'rumb_zh', 'class_code', 'class_ru', 'class_en'];
    const lines = [header.join(',')];
    for (const ph of photos) {
      const p = points.find((x) => x.id === ph.point_id) || {};
      lines.push([
        ph.filename, ph.observer, ph.date_local, ph.point_id, ph.seq, ph.datetime_utc,
        ph.latitude == null ? '' : ph.latitude.toFixed(7), ph.longitude == null ? '' : ph.longitude.toFixed(7),
        ph.altitude_m == null ? '' : ph.altitude_m.toFixed(1), ph.accuracy_m == null ? '' : ph.accuracy_m.toFixed(1),
        ph.heading_deg == null ? '' : ph.heading_deg.toFixed(1), ph.rumb_en || '', ph.rumb_ru || '', ph.rumb_zh || '',
        p.class_code || '', p.class_ru || '', p.class_en || ''
      ].map(csvCell).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }
  function buildGpx() {
    const name = `${safeName(observer)} ${day}`;
    let s = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Habitat 32" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${xmlEsc(name)}</name><time>${new Date().toISOString()}</time></metadata>\n`;
    for (const p of points) {
      s += `<wpt lat="${p.latitude.toFixed(7)}" lon="${p.longitude.toFixed(7)}">`;
      if (p.altitude_m != null) s += `<ele>${p.altitude_m.toFixed(1)}</ele>`;
      s += `<time>${p.datetime_utc}</time><name>${xmlEsc(`#${p.id} ${p.class_code} ${p.class_ru || p.class_en || ''}`)}</name>`;
      if (p.description) s += `<desc>${xmlEsc(p.description)}</desc>`;
      s += `</wpt>\n`;
    }
    s += `<trk><name>${xmlEsc(name)}</name><trkseg>\n`;
    for (const v of track) {
      s += `<trkpt lat="${v.latitude.toFixed(7)}" lon="${v.longitude.toFixed(7)}">`;
      if (v.altitude_m != null) s += `<ele>${v.altitude_m.toFixed(1)}</ele>`;
      s += `<time>${v.datetime_utc}</time>`;
      if (v.accuracy_m != null) s += `<hdop>${(v.accuracy_m / 5).toFixed(1)}</hdop>`;
      s += `</trkpt>\n`;
    }
    s += `</trkseg></trk>\n</gpx>\n`;
    return s;
  }
  async function mirrorFiles() {
    const base = fileBase();
    await opfsWrite(`${base}.csv`, buildCsv());
    await opfsWrite(`${base}.gpx`, buildGpx());
    if (photos.length) await opfsWrite(`${base}-photos.csv`, buildPhotosCsv());
  }
  async function buildZipBlob() {
    const base = fileBase();
    const zip = new JSZip();
    zip.file(`${base}.csv`, buildCsv(), { compression: 'DEFLATE' });
    zip.file(`${base}.gpx`, buildGpx(), { compression: 'DEFLATE' });
    if (photos.length) {
      zip.file(`${base}-photos.csv`, buildPhotosCsv(), { compression: 'DEFLATE' });
      for (const ph of photos) zip.file(`photos/${ph.filename}`, ph.blob, { compression: 'STORE' });
    }
    return zip.generateAsync({ type: 'blob' });
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }

  // ---------- Yandex Disk sync ----------
  let ytoken = localStorage.getItem('fp_ytoken') || '';
  let dirtyData = false, dirtyTrack = false, debounceT = null, trackT = null, retryT = null, syncing = false, attempts = 0;
  let lastSync = null, lastError = null;
  const dayDir = () => `${YD_ROOT}/${safeName(observer)}/${fileDate(new Date(day + 'T12:00:00'))}`;
  async function outboxPut(path, blob) { await S.put(db, 'outbox', { path, blob, updated: Date.now() }); }
  async function outboxCount() { try { return await S.count(db, 'outbox'); } catch (_) { return 0; } }
  async function showSync(extra) {
    const el = $('syncState');
    if (!ytoken) { el.textContent = t('sync_none'); return; }
    if (extra) { el.textContent = extra; return; }
    const n = await outboxCount();
    if (lastError) el.textContent = lastError;
    else if (n) el.textContent = navigator.onLine ? t('sync_pending', { n }) : `${t('sync_wait_net')} · ${t('sync_pending', { n })}`;
    else if (lastSync) el.textContent = t('sync_ok', { t: hm(lastSync) });
    else el.textContent = '—';
  }
  function markDirty(kind) {
    if (kind === 'track') {
      dirtyTrack = true;
      if (!trackT) trackT = setTimeout(() => { trackT = null; flushAndSync(); }, SYNC_TRACK_MS);
    } else {
      dirtyData = true;
      clearTimeout(debounceT);
      debounceT = setTimeout(() => { debounceT = null; flushAndSync(); }, SYNC_DEBOUNCE_MS);
    }
    showSync();
  }
  async function enqueueDayFiles() {
    if (!observer) return;
    const base = fileBase(), dir = dayDir();
    await outboxPut(`${dir}/${base}.csv`, new Blob([buildCsv()], { type: 'text/csv' }));
    await outboxPut(`${dir}/${base}.gpx`, new Blob([buildGpx()], { type: 'application/gpx+xml' }));
    if (photos.length) await outboxPut(`${dir}/${base}-photos.csv`, new Blob([buildPhotosCsv()], { type: 'text/csv' }));
  }
  async function flushAndSync() {
    if (dirtyData || dirtyTrack) { dirtyData = dirtyTrack = false; await enqueueDayFiles(); }
    registerBgSync();
    runSync();
  }
  function registerBgSync() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then((reg) => { if (reg.sync) return reg.sync.register('h32-upload'); }).catch(() => {});
  }
  async function runSync() {
    if (syncing || !ytoken || !db) { showSync(); return; }
    if (!navigator.onLine) { showSync(); return; }
    if (!(await outboxCount())) { showSync(); return; }
    syncing = true; lastError = null;
    try {
      await S.processOutbox(db, ytoken, (a, b) => showSync(t('sync_uploading', { a, b })));
      lastSync = Date.now(); attempts = 0;
      if (retryT) { clearTimeout(retryT); retryT = null; }
    } catch (e) {
      const isAuth = e && e.name === 'AuthError';
      const m = SYNC_BACKOFF_MIN[Math.min(attempts, SYNC_BACKOFF_MIN.length - 1)];
      attempts++;
      lastError = isAuth ? t('sync_auth') : t('sync_err', { e: (e && e.message) || e, m });
      if (!isAuth) { clearTimeout(retryT); retryT = setTimeout(() => { retryT = null; runSync(); }, m * 60000); }
    } finally { syncing = false; showSync(); }
  }
  async function initSync() {
    // token may arrive in the URL: ...?yt=TOKEN or #yt=TOKEN (then removed from the address bar)
    const m = (location.search + location.hash).match(/[?&#](?:yt|access_token)=([^&#]+)/);
    if (m) { ytoken = decodeURIComponent(m[1]); localStorage.setItem('fp_ytoken', ytoken); history.replaceState(null, '', location.pathname); }
    if (!ytoken) { try { ytoken = (await S.getMeta(db, 'ytoken')) || ''; } catch (_) {} }
    if (ytoken) { try { await S.putMeta(db, 'ytoken', ytoken); } catch (_) {} }
    try { lastSync = await S.getMeta(db, 'lastSync'); } catch (_) {}
    $('ytoken').value = ytoken;
    showSync();
  }
  $('tokenGet').addEventListener('click', () => {
    window.open(`https://oauth.yandex.ru/authorize?response_type=token&client_id=${YD_CLIENT_ID}`, '_blank');
  });
  $('qrBtn').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}${ytoken ? '?yt=' + encodeURIComponent(ytoken) : ''}`;
    try {
      const q = qrcode(0, 'M'); q.addData(url); q.make();
      $('qrBox').innerHTML = q.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
      $('qrBox').firstChild.style.width = '260px'; $('qrBox').firstChild.style.height = '260px';
    } catch (e) { $('qrBox').textContent = String(e); }
    $('qrLink').textContent = ytoken ? url.replace(/yt=.{6}[^&]*/, (m) => m.slice(0, 9) + '…') : url;
    $('qrModal').classList.remove('hidden');
  });
  $('qrClose').addEventListener('click', () => $('qrModal').classList.add('hidden'));
  $('tokenSave').addEventListener('click', async () => {
    ytoken = $('ytoken').value.trim();
    localStorage.setItem('fp_ytoken', ytoken);
    await S.putMeta(db, 'ytoken', ytoken);
    lastError = null; attempts = 0;
    setStatus(t('token_saved'));
    if (ytoken && observer) { dirtyData = true; flushAndSync(); } else showSync();
  });
  $('syncNow').addEventListener('click', async () => { if (observer) { dirtyData = true; await flushAndSync(); } });
  window.addEventListener('online', () => { showSync(); runSync(); });
  window.addEventListener('offline', () => showSync());
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'synced') { lastSync = e.data.at || Date.now(); showSync(); } });

  // ---------- geolocation / track ----------
  function onFix(pos) {
    lastFix = pos;
    const { latitude, longitude, accuracy } = pos.coords;
    $('lat').textContent = latitude.toFixed(6); $('lon').textContent = longitude.toFixed(6);
    const accTxt = accuracy != null ? `±${Math.round(accuracy)} m` : '';
    $('gpsState').textContent = `GPS: ${accTxt}`;
    $('gpsState').style.color = accuracy <= 10 ? '#8be28f' : accuracy <= 30 ? '#ffd54f' : '#ff8a80';
    setStatus(`${t('pos_acquired')} ${accTxt}`);
    $('record').disabled = false;
    drawPosition(pos);
    if (!firstFixCentered) { firstFixCentered = true; map.getView().animate({ center: ol.proj.fromLonLat([longitude, latitude]), zoom: 16, duration: 400 }); }
    if (tracking) maybeAddVertex(pos);
  }
  function onGeoError(err) {
    const msgs = { 1: t('geo_denied'), 2: t('geo_unavail'), 3: t('geo_timeout') };
    setStatus(msgs[err.code] || err.message, err.code !== 3);
    $('gpsState').textContent = t('gps_error'); $('gpsState').style.color = '#ff8a80';
  }
  function startWatch() {
    if (!('geolocation' in navigator)) { setStatus(t('geo_unsupported'), true); return; }
    if (!window.isSecureContext) setStatus(t('https_req'), true);
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  async function maybeAddVertex(pos) {
    const now = new Date(pos.timestamp || Date.now());
    const c = pos.coords;
    const prev = track[track.length - 1];
    if (prev) {
      const dt = (now - new Date(prev.datetime_utc)) / 1000;
      const dd = haversine(prev.latitude, prev.longitude, c.latitude, c.longitude);
      if (dt < TRACK_MIN_SECONDS && dd < TRACK_MIN_METERS) return;
    }
    const v = { observer, date_local: day, datetime_utc: now.toISOString(), latitude: c.latitude, longitude: c.longitude, altitude_m: c.altitude == null ? null : c.altitude, accuracy_m: c.accuracy == null ? null : c.accuracy };
    v.id = await dbAdd('track', v);
    track.push(v);
    redrawTrack();
    mirrorFiles();
    markDirty('track');
  }
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (_) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (tracking) requestWakeLock(); checkDayRollover(); runSync(); }
  });
  function setTracking(on) {
    tracking = on;
    $('trackToggle').textContent = on ? t('track_stop') : t('track_start');
    $('trackToggle').classList.toggle('blue', on);
    if (on) { requestWakeLock(); if (lastFix) maybeAddVertex(lastFix); }
    else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  // ---------- day handling ----------
  async function loadDay() {
    day = todayKey();
    points = await dbGetDay('points', observer, day);
    track = await dbGetDay('track', observer, day);
    photos = await dbGetDay('photos', observer, day);
    refreshPhotoUi();
    $('dateLabel').textContent = day;
    $('observerLabel').textContent = `${t('observer_lbl')}: ${observer}`;
    redrawPoints(); redrawTrack();
    mirrorFiles();
    showSync();
  }
  function checkDayRollover() { if (observer && todayKey() !== day) loadDay(); }
  setInterval(checkDayRollover, 60000);

  // ---------- UI: language ----------
  function refreshDynamicTexts() {
    applyBasemap();
    if (!lastFix) { $('gpsState').textContent = t('gps_starting'); if (!observer || !$('status').textContent) setStatus(t('wait_gps')); }
    $('trackToggle').textContent = tracking ? t('track_stop') : t('track_start');
    fillClasses();
    if (observer) { $('observerLabel').textContent = `${t('observer_lbl')}: ${observer}`; redrawPoints(); redrawTrack(); refreshPhotoUi(); showSync(); }
    else { $('pointCount').textContent = `${t('points_today')}: 0`; $('trackStats').textContent = `${t('track_lbl')}: 0`; $('photoCount').textContent = `${t('photos_today')}: 0`; refreshPhotoUi(); showSync(); }
    updateCompassUi();
  }
  $('langBtn').addEventListener('click', () => {
    lang = lang === 'ru' ? 'zh' : 'ru';
    localStorage.setItem(LANG_KEY, lang);
    applyLang(); refreshDynamicTexts();
  });

  // ---------- UI: observer modal ----------
  function showObserverModal() {
    const sel = $('observerSelect');
    const saved = localStorage.getItem(OBSERVER_KEY);
    const known = Array.from(sel.options).some((o) => o.value === saved && o.value && o.value !== '__other__');
    if (saved) {
      if (known) { sel.value = saved; $('observerOther').classList.add('hidden'); }
      else { sel.value = '__other__'; $('observerOther').value = saved; $('observerOther').classList.remove('hidden'); }
    }
    $('observerModal').classList.remove('hidden');
  }
  $('observerSelect').addEventListener('change', () => {
    const other = $('observerSelect').value === '__other__';
    $('observerOther').classList.toggle('hidden', !other);
    if (other) $('observerOther').focus();
  });
  $('observerConfirm').addEventListener('click', async () => {
    let v = $('observerSelect').value;
    if (v === '__other__') v = $('observerOther').value.trim();
    if (!v) { $('observerSelect').focus(); return; }
    observer = safeName(v);
    localStorage.setItem(OBSERVER_KEY, observer);
    $('observerModal').classList.add('hidden');
    await loadDay();
    startWatch();
    setTracking(true);
    runSync();
    prefetchTiles();
  });
  $('changeObserver').addEventListener('click', () => { setTracking(false); showObserverModal(); });

  // ---------- UI: class select ----------
  function fillClasses() {
    const sel = $('category');
    const cur = sel.value || localStorage.getItem('fp_last_class');
    sel.innerHTML = '';
    for (const c of classes) {
      const o = document.createElement('option'); o.value = String(c.id);
      o.textContent = `${c.code} — ${lang === 'zh' ? c.zh : (c.ru || c.en)}`;
      sel.appendChild(o);
    }
    if (cur && classById.has(cur)) sel.value = cur;
  }
  $('category').addEventListener('change', () => localStorage.setItem('fp_last_class', $('category').value));

  // ---------- UI: record point ----------
  $('record').disabled = true;
  $('record').addEventListener('click', async () => {
    if (!lastFix) { setStatus(t('no_gps'), true); return; }
    const c = lastFix.coords;
    const cls = classById.get($('category').value);
    const now = new Date();
    const p = {
      observer, date_local: todayKey(now), time_local: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, datetime_utc: now.toISOString(),
      class_code: cls ? cls.code : '', class_id: cls ? cls.id : '', class_en: cls ? cls.en : '', class_ru: cls ? cls.ru : '', class_zh: cls ? cls.zh : '',
      description: $('note').value.trim(),
      latitude: c.latitude, longitude: c.longitude, altitude_m: c.altitude == null ? null : c.altitude, accuracy_m: c.accuracy == null ? null : c.accuracy
    };
    if (p.date_local !== day) await loadDay();
    p.id = await dbAdd('points', p);
    points.push(p);
    redrawPoints(); refreshPhotoUi(p.id);
    await mirrorFiles();
    markDirty('data');
    vibrate(60);
    $('note').value = '';
    setStatus(t('saved_point', { id: p.id, code: p.class_code, t: p.time_local, acc: Math.round(p.accuracy_m || 0) }));
  });

  $('clearToday').addEventListener('click', async () => {
    if (!observer) return;
    if (!confirm(t('confirm_clear', { o: observer }))) return;
    await dbDeleteDay('points', observer, day); await dbDeleteDay('track', observer, day); await dbDeleteDay('photos', observer, day);
    for (const n of [`${fileBase()}.csv`, `${fileBase()}.gpx`, `${fileBase()}-photos.csv`, `${fileBase()}-track.csv`]) await opfsRemove(n);
    try { const items = await S.getAll(db, 'outbox'); for (const it of items) if (it.path.startsWith(dayDir() + '/')) await S.del(db, 'outbox', it.path); } catch (_) {}
    points = []; track = []; photos = [];
    redrawPoints(); redrawTrack(); refreshPhotoUi(); showSync();
    setStatus(t('cleared'));
  });
  $('trackToggle').addEventListener('click', () => setTracking(!tracking));

  // ---------- photos: in-app camera with compass overlay, EXIF GPS + heading ----------
  let camStream = null;
  function selectedPoint() { return points.find((p) => String(p.id) === $('photoPoint').value) || null; }
  async function openCamera() {
    const p = selectedPoint();
    if (!p) { setStatus(t('record_first_status'), true); return; }
    startCompass();
    $('camModal').classList.remove('hidden');
    $('camMeta').textContent = pointLabel(p);
    updateCompassUi();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      $('camVideo').srcObject = camStream;
    } catch (e) { closeCamera(); $('photoFile').click(); } // no in-app camera: system camera app
  }
  function closeCamera() {
    $('camModal').classList.add('hidden');
    if (camStream) { camStream.getTracks().forEach((tr) => tr.stop()); camStream = null; }
    $('camVideo').srcObject = null;
  }
  function stampAndEncode(source, sw, sh, info) {
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    const fs = Math.max(14, Math.round(w / 48));
    const lines = [
      `${info.filename}  ·  ${info.datetime_local}`,
      `${info.latitude != null ? info.latitude.toFixed(6) + ', ' + info.longitude.toFixed(6) : 'no GPS'}${info.accuracy_m != null ? ' ±' + Math.round(info.accuracy_m) + ' m' : ''}${info.altitude_m != null ? '  h ' + Math.round(info.altitude_m) + ' m' : ''}`,
      `${info.heading_deg != null ? 'Az ' + Math.round(info.heading_deg) + '° ' + info.rumb_en + ' · ' + info.rumb_ru + ' · ' + info.rumb_zh + ' (magn.)' : 'Az: n/a'}  ·  ${info.class_code} ${info.class_ru || info.class_en}`
    ];
    const pd = Math.round(fs * 0.5), bh = lines.length * (fs * 1.3) + pd * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, h - bh, w, bh);
    ctx.fillStyle = '#fff'; ctx.font = `${fs}px system-ui, sans-serif`; ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, pd, h - bh + pd + i * fs * 1.3, w - 2 * pd));
    return cv.toDataURL('image/jpeg', 0.86);
  }
  function addExif(dataUrl, info) {
    try {
      const d = new Date(info.datetime_utc);
      const exifDate = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const zeroth = {}, exif = {}, gps = {};
      zeroth[piexif.ImageIFD.Make] = 'Habitat 32'; zeroth[piexif.ImageIFD.Software] = 'Habitat 32 PWA';
      zeroth[piexif.ImageIFD.Artist] = info.observer; zeroth[piexif.ImageIFD.Copyright] = `(c) ${d.getFullYear()} I. P. Kotlov, IEE RAS`;
      zeroth[piexif.ImageIFD.ImageDescription] = `Point #${info.point_id} ${info.class_code} ${info.class_en}; heading ${info.heading_deg != null ? Math.round(info.heading_deg) + ' deg ' + info.rumb_en : 'n/a'}`;
      zeroth[piexif.ImageIFD.Orientation] = 1;
      exif[piexif.ExifIFD.DateTimeOriginal] = exifDate; exif[piexif.ExifIFD.DateTimeDigitized] = exifDate; exif[piexif.ExifIFD.UserComment] = info.filename;
      if (info.latitude != null) {
        gps[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
        gps[piexif.GPSIFD.GPSLatitudeRef] = info.latitude >= 0 ? 'N' : 'S'; gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(info.latitude));
        gps[piexif.GPSIFD.GPSLongitudeRef] = info.longitude >= 0 ? 'E' : 'W'; gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(info.longitude));
        if (info.altitude_m != null) { gps[piexif.GPSIFD.GPSAltitudeRef] = info.altitude_m >= 0 ? 0 : 1; gps[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(info.altitude_m) * 100), 100]; }
        if (info.accuracy_m != null) gps[piexif.GPSIFD.GPSHPositioningError] = [Math.round(info.accuracy_m * 100), 100];
        gps[piexif.GPSIFD.GPSDateStamp] = `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())}`;
        gps[piexif.GPSIFD.GPSTimeStamp] = [[d.getUTCHours(), 1], [d.getUTCMinutes(), 1], [d.getUTCSeconds(), 1]];
      }
      if (info.heading_deg != null) { gps[piexif.GPSIFD.GPSImgDirectionRef] = 'M'; gps[piexif.GPSIFD.GPSImgDirection] = [Math.round(info.heading_deg * 100), 100]; }
      return piexif.insert(piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': gps }), dataUrl);
    } catch (e) { return dataUrl; }
  }
  function dataUrlToBlob(u) {
    const [meta, b64] = u.split(',');
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg' });
  }
  async function savePhoto(source, sw, sh) {
    const p = selectedPoint();
    if (!p) return;
    const now = new Date();
    const seq = photos.filter((x) => x.point_id === p.id).length + 1;
    const h = (heading != null && Date.now() - headingAt < 15000) ? heading : null;
    const r = h != null ? rumbOf(h) : null;
    const c = lastFix ? lastFix.coords : null;
    const info = {
      observer, date_local: todayKey(now), point_id: p.id, seq,
      filename: `${safeName(observer)}-${fileDate(now)}-${p.id}-${seq}.jpg`,
      datetime_utc: now.toISOString(), datetime_local: localDateTime(now),
      latitude: c ? c.latitude : (p.latitude ?? null), longitude: c ? c.longitude : (p.longitude ?? null),
      altitude_m: c && c.altitude != null ? c.altitude : null, accuracy_m: c && c.accuracy != null ? c.accuracy : null,
      heading_deg: h, rumb_en: r ? r.en : '', rumb_ru: r ? r.ru : '', rumb_zh: r ? r.zh : '',
      class_code: p.class_code, class_en: p.class_en, class_ru: p.class_ru || ''
    };
    const blob = dataUrlToBlob(addExif(stampAndEncode(source, sw, sh, info), info));
    const rec = Object.assign({}, info, { blob });
    delete rec.datetime_local; delete rec.class_code; delete rec.class_en; delete rec.class_ru;
    rec.id = await dbAdd('photos', rec);
    photos.push(rec);
    vibrate(40);
    refreshPhotoUi(p.id);
    mirrorFiles();
    try { await outboxPut(`${dayDir()}/photos/${info.filename}`, blob); } catch (_) {}
    markDirty('data');
    drawCamOverlay();
    setStatus(t('photo_saved', { f: info.filename }) + (h != null ? ` (${Math.round(h)}° ${rumbLabel(r)})` : ''));
  }
  $('takePhoto').addEventListener('click', openCamera);
  $('camClose').addEventListener('click', closeCamera);
  $('camShutter').addEventListener('click', async () => {
    const v = $('camVideo');
    if (!v.videoWidth) return;
    $('camShutter').disabled = true;
    try { await savePhoto(v, v.videoWidth, v.videoHeight); } finally { $('camShutter').disabled = false; }
  });
  $('photoFile').addEventListener('change', async () => {
    const f = $('photoFile').files[0];
    $('photoFile').value = '';
    if (!f) return;
    try {
      let bmp;
      try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); }
      catch (_) { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(f); }); }
      await savePhoto(bmp, bmp.width || bmp.naturalWidth, bmp.height || bmp.naturalHeight);
    } catch (e) { setStatus(t('photo_failed', { e: (e && e.message) || (e && e.type) || e }), true); }
  });
  window.addEventListener('resize', () => { if (!$('camModal').classList.contains('hidden')) drawCamOverlay(); });

  // ---------- share: ZIP to Downloads, then Web Share ----------
  // Android Chrome only shares "safe" file types (.csv, .txt, images, .pdf); a .zip is rejected with NotAllowedError.
  // iOS shares any file. So: always save the ZIP to Downloads, then try to share it; on rejection offer CSV / photos.
  const canShareFiles = (files) => !!(navigator.share && navigator.canShare && navigator.canShare({ files }));
  function shareFiles(files, title) {
    return navigator.share({ files, title })
      .then(() => setStatus(t('shared', { f: files.length === 1 ? files[0].name : files.length })))
      .catch((e) => { if (e && e.name === 'AbortError') setStatus(t('share_cancel')); else setStatus(t('share_fail', { e: (e && e.message) || e }), true); });
  }
  $('share').addEventListener('click', async () => {
    if (!observer) return;
    const name = `${fileBase()}.zip`;
    const blob = await buildZipBlob();
    downloadBlob(blob, name);
    setStatus(t('zip_saved', { f: name }));
    const zipFile = new File([blob], name, { type: 'application/zip' });
    if (canShareFiles([zipFile])) {
      try { await navigator.share({ files: [zipFile], title: name }); setStatus(t('shared', { f: name })); return; }
      catch (e) { if (e && e.name === 'AbortError') { setStatus(t('share_cancel')); return; } }
    }
    $('shareModal').classList.remove('hidden'); // ZIP not shareable here: offer the permitted types
  });
  $('sharePoints').addEventListener('click', () => {
    $('shareModal').classList.add('hidden');
    const f = new File([buildCsv()], `${fileBase()}.csv`, { type: 'text/csv' });
    if (!canShareFiles([f])) { setStatus(t('share_unsupported'), true); return; }
    shareFiles([f], f.name);
  });
  $('sharePhotos').addEventListener('click', () => {
    $('shareModal').classList.add('hidden');
    const p = selectedPoint();
    const files = photos.filter((x) => p && x.point_id === p.id).map((x) => new File([x.blob], x.filename, { type: 'image/jpeg' }));
    if (!files.length) { setStatus(t('no_photos'), true); return; }
    if (!canShareFiles(files)) { setStatus(t('share_unsupported'), true); return; }
    shareFiles(files, `${fileBase()} #${p.id}`);
  });
  $('shareCancel').addEventListener('click', () => $('shareModal').classList.add('hidden'));

  // ---------- service worker ----------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // ---------- boot ----------
  applyLang();
  (async function boot() {
    try { db = await openDb(); } catch (e) { setStatus(t('db_fail', { e: e.message }), true); return; }
    await initOpfs();
    await initSync();
    refreshDynamicTexts();
    $('dateLabel').textContent = todayKey();
    showObserverModal();
  })();
})();
