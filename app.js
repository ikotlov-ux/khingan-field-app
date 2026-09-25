/* Habitat 32 — field points for Bolshoy Khingan
 * OpenLayers map, geolocation, IndexedDB + OPFS storage, CSV/GPX/ZIP export and Web Share.
 * Bilingual UI (English / 中文). Static, no build step. Requires a secure (HTTPS) context for geolocation, OPFS and sharing.
 */
(function () {
  'use strict';

  // ---------- constants ----------
  const OBSERVER_KEY = 'fp_observer';
  const TRACK_MIN_SECONDS = 5;
  const TRACK_MIN_METERS = 5;
  const DB_NAME = 'field-points';
  const DB_VERSION = 2;

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  function todayKey(d = new Date()) {
    // YYYY-MM-DD in local time
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fileDate(d = new Date()) {
    // dd-mm-yy in local time (filename base: Surname-dd-mm-yy)
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
  }
  function localDateTime(d) {
    return `${todayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function safeName(s) {
    return String(s || 'Observer').trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'Observer';
  }
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function xmlEsc(s) {
    return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg;
    el.style.color = isError ? '#ff8a80' : '';
  }
  function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} }

  // ---------- IndexedDB ----------
  let db;
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('points')) {
          const s = d.createObjectStore('points', { keyPath: 'id', autoIncrement: true });
          s.createIndex('byDay', ['observer', 'date_local'], { unique: false });
        }
        if (!d.objectStoreNames.contains('track')) {
          const t = d.createObjectStore('track', { keyPath: 'id', autoIncrement: true });
          t.createIndex('byDay', ['observer', 'date_local'], { unique: false });
        }
        if (!d.objectStoreNames.contains('photos')) {
          const p = d.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
          p.createIndex('byDay', ['observer', 'date_local'], { unique: false });
          p.createIndex('byPoint', 'point_id', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbAdd(store, obj) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const r = tx.objectStore(store).add(obj);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function dbGetDay(store, observer, day) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const r = tx.objectStore(store).index('byDay').getAll(IDBKeyRange.only([observer, day]));
      r.onsuccess = () => resolve(r.result.sort((a, b) => a.id - b.id));
      r.onerror = () => reject(r.error);
    });
  }
  function dbDelete(store, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const r = tx.objectStore(store).delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }
  function dbDeleteDay(store, observer, day) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const idx = tx.objectStore(store).index('byDay');
      const r = idx.openCursor(IDBKeyRange.only([observer, day]));
      r.onsuccess = () => { const c = r.result; if (c) { c.delete(); c.continue(); } };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
    try {
      const fh = await opfsRoot.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
    } catch (_) { /* OPFS writable may be unsupported (e.g. Safari main thread) */ }
  }
  async function opfsRemove(name) {
    if (!opfsRoot) return;
    try { await opfsRoot.removeEntry(name); } catch (_) {}
  }

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

  // ---------- compass (camera heading) ----------
  const RUMBS = [
    { en: 'N', ru: 'С', zh: '北' }, { en: 'NE', ru: 'СВ', zh: '东北' }, { en: 'E', ru: 'В', zh: '东' }, { en: 'SE', ru: 'ЮВ', zh: '东南' },
    { en: 'S', ru: 'Ю', zh: '南' }, { en: 'SW', ru: 'ЮЗ', zh: '西南' }, { en: 'W', ru: 'З', zh: '西' }, { en: 'NW', ru: 'СЗ', zh: '西北' }
  ];
  function rumbOf(h) { return RUMBS[Math.round(((h % 360) + 360) % 360 / 45) % 8]; }
  let heading = null;          // degrees, 0..360, magnetic north, direction the rear camera points
  let headingAt = 0;
  let compassOn = false;
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
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission(); // iOS 13+, needs a user gesture
        if (r !== 'granted') { $('compassState').textContent = 'Compass · 罗盘: denied · 被拒绝'; return; }
      }
    } catch (_) {}
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient, true);
    window.addEventListener('deviceorientation', onOrient, true);
    compassOn = true;
    $('compassState').textContent = 'Compass · 罗盘: on · 开';
  }
  function headingText(h) {
    if (h == null) return { big: '—', sub: 'no compass · нет компаса · 无罗盘' };
    const r = rumbOf(h);
    return { big: `${r.en} · ${r.ru} · ${r.zh}`, sub: `${Math.round(h)}° magnetic · 磁方位` };
  }
  function updateCompassUi() {
    const t = headingText(heading);
    $('compassState').textContent = heading == null ? 'Compass · 罗盘: —' : `Compass · 罗盘: ${Math.round(heading)}° ${rumbOf(heading).en}·${rumbOf(heading).ru}`;
    if (!$('camModal').classList.contains('hidden')) {
      $('camRumb').firstChild.nodeValue = t.big;
      $('camRumbSub').textContent = t.sub;
      $('roseDial').setAttribute('transform', `rotate(${heading == null ? 0 : -heading} 50 50)`);
    }
  }

  // ---------- map ----------
  const pointSource = new ol.source.Vector();
  const trackSource = new ol.source.Vector();
  const posSource = new ol.source.Vector();

  const pointStyle = new ol.style.Style({
    image: new ol.style.Circle({
      radius: 7,
      fill: new ol.style.Fill({ color: '#43a047' }),
      stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 })
    })
  });
  const trackStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: '#1976d2', width: 3 })
  });
  const posStyle = (f) => {
    const t = f.get('kind');
    if (t === 'acc') {
      return new ol.style.Style({
        fill: new ol.style.Fill({ color: 'rgba(25,118,210,0.15)' }),
        stroke: new ol.style.Stroke({ color: 'rgba(25,118,210,0.6)', width: 1 })
      });
    }
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius: 6,
        fill: new ol.style.Fill({ color: '#1976d2' }),
        stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 })
      })
    });
  };

  const osmLayer = new ol.layer.Tile({ source: new ol.source.OSM() });
  const satLayer = new ol.layer.Tile({
    visible: false,
    source: new ol.source.XYZ({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attributions: 'Imagery © Esri, Maxar, Earthstar Geographics',
      maxZoom: 19, crossOrigin: 'anonymous'
    })
  });
  let satOn = localStorage.getItem('fp_basemap') === 'sat';
  function applyBasemap() {
    osmLayer.setVisible(!satOn); satLayer.setVisible(satOn);
    const b = $('baseToggle');
    b.innerHTML = satOn ? 'Map<br>地图' : 'Sat<br>卫星';
    b.classList.toggle('active', satOn);
  }

  const map = new ol.Map({
    target: 'map',
    layers: [
      osmLayer, satLayer,
      new ol.layer.Vector({ source: trackSource, style: trackStyle }),
      new ol.layer.Vector({ source: posSource, style: posStyle }),
      new ol.layer.Vector({ source: pointSource, style: pointStyle })
    ],
    view: new ol.View({ center: ol.proj.fromLonLat([124.5, 52.0]), zoom: 8 }),
    controls: ol.control.defaults.defaults({ rotate: false, zoom: false })
  });
  applyBasemap();
  $('baseToggle').addEventListener('click', () => { satOn = !satOn; localStorage.setItem('fp_basemap', satOn ? 'sat' : 'osm'); applyBasemap(); });
  $('zoomIn').addEventListener('click', () => map.getView().animate({ zoom: map.getView().getZoom() + 1, duration: 200 }));
  $('zoomOut').addEventListener('click', () => map.getView().animate({ zoom: map.getView().getZoom() - 1, duration: 200 }));
  $('centerMe').addEventListener('click', () => {
    if (!lastFix) { setStatus('No GPS position yet. · 尚未获取 GPS 位置。', true); return; }
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
    popupEl.innerHTML = `<b>#${p.id} · ${xmlEsc(p.class_code)}</b><br>${xmlEsc(p.class_en)}<br>${xmlEsc(p.time_local)}${p.description ? '<br><i>' + xmlEsc(p.description) + '</i>' : ''}${nph ? `<br>📷 ${nph}` : ''}`;
    $('photoPoint').value = String(p.id);
    popupEl.classList.remove('hidden');
    popup.setPosition(hit.getGeometry().getCoordinates());
  });

  function redrawPoints() {
    pointSource.clear();
    for (const p of points) {
      const f = new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat([p.longitude, p.latitude])));
      f.set('point', p);
      pointSource.addFeature(f);
    }
    $('pointCount').textContent = `Today's points · 今日点数: ${points.length}`;
  }
  function redrawTrack() {
    trackSource.clear();
    if (track.length >= 2) {
      const coords = track.map((v) => ol.proj.fromLonLat([v.longitude, v.latitude]));
      trackSource.addFeature(new ol.Feature(new ol.geom.LineString(coords)));
    }
    $('trackStats').textContent = `Track · 轨迹: ${track.length}`;
  }
  function pointLabel(p) { return `#${p.id} · ${p.class_code} · ${p.time_local}`; }
  function refreshPhotoUi(selectId) {
    const sel = $('photoPoint');
    const prev = selectId != null ? String(selectId) : sel.value;
    sel.innerHTML = '';
    if (!points.length) {
      sel.innerHTML = '<option value="">— Record a point first · 请先记录点 —</option>';
    } else {
      for (const p of points) {
        const o = document.createElement('option');
        o.value = String(p.id);
        const n = photos.filter((x) => x.point_id === p.id).length;
        o.textContent = pointLabel(p) + (n ? ` · 📷${n}` : '');
        sel.appendChild(o);
      }
      sel.value = points.some((p) => String(p.id) === prev) ? prev : String(points[points.length - 1].id);
    }
    $('takePhoto').disabled = !points.length;
    $('photoCount').textContent = `Today's photos · 今日照片: ${photos.length}`;
    const th = $('thumbs');
    th.querySelectorAll('img').forEach((im) => URL.revokeObjectURL(im.src));
    th.innerHTML = '';
    const pid = Number(sel.value);
    for (const ph of photos.filter((x) => x.point_id === pid)) {
      const box = document.createElement('div');
      const im = document.createElement('img');
      im.src = URL.createObjectURL(ph.blob); im.alt = ph.filename; im.title = ph.filename;
      im.addEventListener('click', async () => {
        if (!confirm(`Delete photo ${ph.filename}?\n删除照片 ${ph.filename}？`)) return;
        await dbDelete('photos', ph.id);
        photos = photos.filter((x) => x.id !== ph.id);
        refreshPhotoUi(); mirrorFiles();
      });
      const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = `${ph.seq} · ${Math.round(ph.heading_deg ?? NaN) || '—'}° ${ph.rumb_en || ''}`;
      box.appendChild(im); box.appendChild(cap); th.appendChild(box);
    }
  }
  $('photoPoint').addEventListener('change', () => refreshPhotoUi());

  function drawPosition(pos) {
    posSource.clear();
    const c = ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]);
    if (pos.coords.accuracy) {
      const acc = new ol.Feature(new ol.geom.Circle(c, pos.coords.accuracy)); // Web Mercator metres (approx.)
      acc.set('kind', 'acc');
      posSource.addFeature(acc);
    }
    const dot = new ol.Feature(new ol.geom.Point(c));
    dot.set('kind', 'pos');
    posSource.addFeature(dot);
  }

  // ---------- file builders ----------
  function fileBase() { return `${safeName(observer)}-${fileDate(new Date(day + 'T12:00:00'))}`; }

  function buildCsv() {
    const header = ['observer', 'date_local', 'time_local', 'datetime_utc', 'class_code', 'class_id', 'class_en', 'class_zh', 'description', 'latitude', 'longitude', 'altitude_m', 'accuracy_m', 'n_photos'];
    const lines = [header.join(',')];
    for (const p of points) {
      lines.push([
        p.observer, p.date_local, p.time_local, p.datetime_utc, p.class_code, p.class_id, p.class_en, p.class_zh || '', p.description,
        p.latitude.toFixed(7), p.longitude.toFixed(7),
        p.altitude_m == null ? '' : p.altitude_m.toFixed(1),
        p.accuracy_m == null ? '' : p.accuracy_m.toFixed(1),
        photos.filter((x) => x.point_id === p.id).length
      ].map(csvCell).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function buildPhotosCsv() {
    const header = ['filename', 'observer', 'date_local', 'point_id', 'photo_seq', 'datetime_utc', 'latitude', 'longitude', 'altitude_m', 'accuracy_m', 'heading_deg_magnetic', 'rumb_en', 'rumb_ru', 'rumb_zh', 'class_code', 'class_en'];
    const lines = [header.join(',')];
    for (const ph of photos) {
      const p = points.find((x) => x.id === ph.point_id) || {};
      lines.push([
        ph.filename, ph.observer, ph.date_local, ph.point_id, ph.seq, ph.datetime_utc,
        ph.latitude == null ? '' : ph.latitude.toFixed(7), ph.longitude == null ? '' : ph.longitude.toFixed(7),
        ph.altitude_m == null ? '' : ph.altitude_m.toFixed(1), ph.accuracy_m == null ? '' : ph.accuracy_m.toFixed(1),
        ph.heading_deg == null ? '' : ph.heading_deg.toFixed(1), ph.rumb_en || '', ph.rumb_ru || '', ph.rumb_zh || '',
        p.class_code || '', p.class_en || ''
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
      s += `<time>${p.datetime_utc}</time><name>${xmlEsc(p.class_code + ' ' + p.class_en)}</name>`;
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

  function buildTrackCsv() {
    const header = ['observer', 'date_local', 'seq', 'datetime_utc', 'latitude', 'longitude', 'altitude_m', 'accuracy_m'];
    const lines = [header.join(',')];
    track.forEach((v, i) => {
      lines.push([
        v.observer, v.date_local, i + 1, v.datetime_utc,
        v.latitude.toFixed(7), v.longitude.toFixed(7),
        v.altitude_m == null ? '' : v.altitude_m.toFixed(1),
        v.accuracy_m == null ? '' : v.accuracy_m.toFixed(1)
      ].map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  async function mirrorFiles() {
    const base = fileBase();
    await opfsWrite(`${base}.csv`, buildCsv());
    await opfsWrite(`${base}.gpx`, buildGpx());
    await opfsWrite(`${base}-track.csv`, buildTrackCsv());
    if (photos.length) await opfsWrite(`${base}-photos.csv`, buildPhotosCsv());
  }

  async function buildZipBlob() {
    const base = fileBase();
    const zip = new JSZip();
    zip.file(`${base}.csv`, buildCsv());
    zip.file(`${base}.gpx`, buildGpx());
    zip.file(`${base}-track.csv`, buildTrackCsv());
    if (photos.length) {
      zip.file(`${base}-photos.csv`, buildPhotosCsv());
      for (const ph of photos) zip.file(`photos/${ph.filename}`, ph.blob);
    }
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  // ---------- geolocation / track ----------
  function onFix(pos) {
    lastFix = pos;
    const { latitude, longitude, accuracy } = pos.coords;
    $('lat').textContent = latitude.toFixed(6);
    $('lon').textContent = longitude.toFixed(6);
    const accTxt = accuracy != null ? `±${Math.round(accuracy)} m` : '';
    $('gpsState').textContent = `GPS: ${accTxt}`;
    $('gpsState').style.color = accuracy <= 10 ? '#8be28f' : accuracy <= 30 ? '#ffd54f' : '#ff8a80';
    setStatus(`Position acquired · 已定位 ${accTxt}`);
    $('record').disabled = false;
    drawPosition(pos);
    if (!firstFixCentered) {
      firstFixCentered = true;
      map.getView().animate({ center: ol.proj.fromLonLat([longitude, latitude]), zoom: 16, duration: 400 });
    }
    if (tracking) maybeAddVertex(pos);
  }
  function onGeoError(err) {
    const msgs = { 1: 'Location permission denied. Allow location access for this site. · 定位权限被拒绝，请允许此网站访问位置。', 2: 'Position unavailable. · 无法获取位置。', 3: 'GPS timeout — waiting for a better signal… · GPS 超时，等待更好的信号…' };
    setStatus(msgs[err.code] || err.message, err.code !== 3);
    $('gpsState').textContent = 'GPS: error · 错误';
    $('gpsState').style.color = '#ff8a80';
  }
  function startWatch() {
    if (!('geolocation' in navigator)) { setStatus('Geolocation is not supported by this browser. · 此浏览器不支持定位。', true); return; }
    if (!window.isSecureContext) { setStatus('Geolocation requires HTTPS. · 定位需要 HTTPS。', true); }
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
    const v = {
      observer, date_local: day, datetime_utc: now.toISOString(),
      latitude: c.latitude, longitude: c.longitude,
      altitude_m: c.altitude == null ? null : c.altitude,
      accuracy_m: c.accuracy == null ? null : c.accuracy
    };
    v.id = await dbAdd('track', v);
    track.push(v);
    redrawTrack();
    mirrorFiles();
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (tracking) requestWakeLock();
      checkDayRollover();
    }
  });

  function setTracking(on) {
    tracking = on;
    $('trackToggle').innerHTML = on ? '⏸ Stop track<span class="zh">停止轨迹</span>' : '▶ Start track<span class="zh">开始轨迹</span>';
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
    $('observerLabel').textContent = `Observer · 观察者: ${observer}`;
    redrawPoints();
    redrawTrack();
    mirrorFiles();
  }
  function checkDayRollover() {
    if (observer && todayKey() !== day) loadDay();
  }
  setInterval(checkDayRollover, 60000);

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
  });
  $('changeObserver').addEventListener('click', () => {
    setTracking(false);
    showObserverModal();
  });

  // ---------- UI: class select ----------
  (function fillClasses() {
    const sel = $('category');
    sel.innerHTML = '';
    for (const c of classes) {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = `${c.code} — ${c.en} · ${c.zh}`;
      sel.appendChild(o);
    }
    const last = localStorage.getItem('fp_last_class');
    if (last && classById.has(last)) sel.value = last;
    sel.addEventListener('change', () => localStorage.setItem('fp_last_class', sel.value));
  })();

  // ---------- UI: record point ----------
  $('record').disabled = true;
  $('record').addEventListener('click', async () => {
    if (!lastFix) { setStatus('No GPS position yet. · 尚未获取 GPS 位置。', true); return; }
    const c = lastFix.coords;
    const cls = classById.get($('category').value);
    const now = new Date();
    const p = {
      observer, date_local: todayKey(now), time_local: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      datetime_utc: now.toISOString(),
      class_code: cls ? cls.code : '', class_id: cls ? cls.id : '', class_en: cls ? cls.en : '', class_zh: cls ? cls.zh : '',
      description: $('note').value.trim(),
      latitude: c.latitude, longitude: c.longitude,
      altitude_m: c.altitude == null ? null : c.altitude,
      accuracy_m: c.accuracy == null ? null : c.accuracy
    };
    if (p.date_local !== day) await loadDay();
    p.id = await dbAdd('points', p);
    points.push(p);
    redrawPoints();
    refreshPhotoUi(p.id);
    await mirrorFiles();
    vibrate(60);
    $('note').value = '';
    setStatus(`Saved point · 已保存点 #${p.id} (${p.class_code}) ${p.time_local}, ±${Math.round(p.accuracy_m || 0)} m`);
  });

  $('clearToday').addEventListener('click', async () => {
    if (!observer) return;
    if (!confirm(`Delete all of today's points and track for ${observer}? Export first if needed.\n删除 ${observer} 今天的所有点和轨迹？如需请先导出。`)) return;
    await dbDeleteDay('points', observer, day);
    await dbDeleteDay('track', observer, day);
    await dbDeleteDay('photos', observer, day);
    await opfsRemove(`${fileBase()}.csv`);
    await opfsRemove(`${fileBase()}-photos.csv`);
    await opfsRemove(`${fileBase()}.gpx`);
    await opfsRemove(`${fileBase()}-track.csv`);
    points = []; track = []; photos = [];
    redrawPoints(); redrawTrack(); refreshPhotoUi();
    setStatus("Today's data cleared. · 今日数据已清除。");
  });

  $('trackToggle').addEventListener('click', () => setTracking(!tracking));

  // ---------- export / share ----------
  $('download').addEventListener('click', async () => {
    if (!observer) return;
    const blob = await buildZipBlob();
    downloadBlob(blob, `${fileBase()}.zip`);
    setStatus(`Downloaded · 已下载 ${fileBase()}.zip`);
  });

  // ---------- photos: in-app camera with compass, EXIF GPS + heading ----------
  let camStream = null;
  const MAX_SIDE = 1600;

  function selectedPoint() { return points.find((p) => String(p.id) === $('photoPoint').value) || null; }

  async function openCamera() {
    const p = selectedPoint();
    if (!p) { setStatus('Record a point first. · 请先记录点。', true); return; }
    startCompass();
    $('camModal').classList.remove('hidden');
    $('camMeta').textContent = `${pointLabel(p)}`;
    updateCompassUi();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      $('camVideo').srcObject = camStream;
    } catch (e) {
      // No in-app camera (permission denied / unsupported): fall back to the system camera app.
      closeCamera();
      $('photoFile').click();
    }
  }
  function closeCamera() {
    $('camModal').classList.add('hidden');
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
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
      `${info.heading_deg != null ? 'Heading ' + Math.round(info.heading_deg) + '° ' + info.rumb_en + ' · ' + info.rumb_ru + ' · ' + info.rumb_zh + ' (magnetic)' : 'Heading: n/a'}  ·  ${info.class_code} ${info.class_en}`
    ];
    const pad = Math.round(fs * 0.5), bh = lines.length * (fs * 1.3) + pad * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, h - bh, w, bh);
    ctx.fillStyle = '#fff'; ctx.font = `${fs}px system-ui, sans-serif`; ctx.textBaseline = 'top';
    lines.forEach((ln, i) => ctx.fillText(ln, pad, h - bh + pad + i * fs * 1.3, w - 2 * pad));
    return cv.toDataURL('image/jpeg', 0.86);
  }

  function addExif(dataUrl, info) {
    try {
      const d = new Date(info.datetime_utc);
      const exifDate = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const zeroth = {}, exif = {}, gps = {};
      zeroth[piexif.ImageIFD.Make] = 'Habitat 32';
      zeroth[piexif.ImageIFD.Software] = 'Habitat 32 PWA';
      zeroth[piexif.ImageIFD.Artist] = info.observer;
      zeroth[piexif.ImageIFD.Copyright] = `(c) ${d.getFullYear()} I. P. Kotlov, IEE RAS`;
      zeroth[piexif.ImageIFD.ImageDescription] = `Point #${info.point_id} ${info.class_code} ${info.class_en}; heading ${info.heading_deg != null ? Math.round(info.heading_deg) + ' deg ' + info.rumb_en : 'n/a'}`;
      zeroth[piexif.ImageIFD.Orientation] = 1;
      exif[piexif.ExifIFD.DateTimeOriginal] = exifDate;
      exif[piexif.ExifIFD.DateTimeDigitized] = exifDate;
      exif[piexif.ExifIFD.UserComment] = info.filename;
      if (info.latitude != null) {
        gps[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
        gps[piexif.GPSIFD.GPSLatitudeRef] = info.latitude >= 0 ? 'N' : 'S';
        gps[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(Math.abs(info.latitude));
        gps[piexif.GPSIFD.GPSLongitudeRef] = info.longitude >= 0 ? 'E' : 'W';
        gps[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(Math.abs(info.longitude));
        if (info.altitude_m != null) { gps[piexif.GPSIFD.GPSAltitudeRef] = info.altitude_m >= 0 ? 0 : 1; gps[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(info.altitude_m) * 100), 100]; }
        if (info.accuracy_m != null) gps[piexif.GPSIFD.GPSHPositioningError] = [Math.round(info.accuracy_m * 100), 100];
        gps[piexif.GPSIFD.GPSDateStamp] = `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())}`;
        gps[piexif.GPSIFD.GPSTimeStamp] = [[d.getUTCHours(), 1], [d.getUTCMinutes(), 1], [d.getUTCSeconds(), 1]];
      }
      if (info.heading_deg != null) {
        gps[piexif.GPSIFD.GPSImgDirectionRef] = 'M';
        gps[piexif.GPSIFD.GPSImgDirection] = [Math.round(info.heading_deg * 100), 100];
      }
      const exifStr = piexif.dump({ '0th': zeroth, 'Exif': exif, 'GPS': gps });
      return piexif.insert(exifStr, dataUrl);
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
      class_code: p.class_code, class_en: p.class_en
    };
    const stamped = stampAndEncode(source, sw, sh, info);
    const withExif = addExif(stamped, info);
    const rec = Object.assign({}, info, { blob: dataUrlToBlob(withExif) });
    delete rec.datetime_local; delete rec.class_code; delete rec.class_en;
    rec.id = await dbAdd('photos', rec);
    photos.push(rec);
    vibrate(40);
    refreshPhotoUi(p.id);
    mirrorFiles();
    setStatus(`Photo saved · 已保存照片: ${info.filename}${h != null ? ` (${Math.round(h)}° ${r.en}·${r.ru})` : ''}`);
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
    } catch (e) { setStatus('Photo failed · 照片失败: ' + e.message, true); }
  });

  // Web Share on Android Chrome only accepts "safe" file types (e.g. .csv, .txt); .zip and .gpx are
  // rejected with NotAllowedError "Permission denied". WeChat (and many messengers) only appear in the
  // share sheet for a SINGLE file, so the user picks one CSV at a time. navigator.share() must run
  // synchronously inside the click handler (no awaits before it) to keep the user-activation window.
  function shareOne(kind) {
    const base = fileBase();
    $('shareModal').classList.add('hidden');
    if (kind === 'photos') {
      const p = selectedPoint();
      const files = photos.filter((x) => p && x.point_id === p.id).map((x) => new File([x.blob], x.filename, { type: 'image/jpeg' }));
      if (!files.length) { setStatus('No photos for the selected point. · 所选点位没有照片。', true); return; }
      if (!(navigator.share && navigator.canShare && navigator.canShare({ files }))) { setStatus('File sharing is not supported in this browser. · 此浏览器不支持文件分享。', true); return; }
      navigator.share({ files, title: `${base} point #${p.id} photos` })
        .then(() => setStatus(`Shared · 已分享 ${files.length} photo(s)`))
        .catch((e) => setStatus(e && e.name === 'AbortError' ? 'Share cancelled. · 已取消分享。' : `Share failed · 分享失败 (${e.message || e}).`, e && e.name !== 'AbortError'));
      return;
    }
    const file = kind === 'track'
      ? new File([buildTrackCsv()], `${base}-track.csv`, { type: 'text/csv' })
      : new File([buildCsv()], `${base}.csv`, { type: 'text/csv' });
    const fallback = async (why) => {
      const blob = await buildZipBlob();
      downloadBlob(blob, `${base}.zip`);
      setStatus(`${why} ZIP downloaded instead — attach it manually. · 已改为下载 ZIP，请手动附加。`);
    };
    if (!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] }))) {
      fallback('File sharing is not supported in this browser. · 此浏览器不支持文件分享。');
      return;
    }
    navigator.share({ files: [file], title: file.name })
      .then(() => setStatus(`Shared · 已分享: ${file.name}`))
      .catch((e) => {
        if (e && e.name === 'AbortError') { setStatus('Share cancelled. · 已取消分享。'); return; }
        fallback(`Share failed · 分享失败 (${e && e.message ? e.message : e}).`);
      });
  }
  $('share').addEventListener('click', () => { if (observer) $('shareModal').classList.remove('hidden'); });
  $('sharePoints').addEventListener('click', () => shareOne('points'));
  $('shareTrack').addEventListener('click', () => shareOne('track'));
  $('sharePhotos').addEventListener('click', () => shareOne('photos'));
  $('shareCancel').addEventListener('click', () => $('shareModal').classList.add('hidden'));

  // ---------- service worker ----------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // ---------- boot ----------
  (async function boot() {
    try { db = await openDb(); } catch (e) { setStatus('Local database unavailable: ' + e.message, true); return; }
    await initOpfs();
    $('dateLabel').textContent = todayKey();
    showObserverModal();
  })();
})();
