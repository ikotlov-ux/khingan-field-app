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
  const DB_VERSION = 1;

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
  let tracking = false;
  let watchId = null;
  let lastFix = null;
  let wakeLock = null;
  let firstFixCentered = false;

  const classes = (window.HABITAT_CLASSES || []).slice();
  const classById = new Map(classes.map((c) => [String(c.id), c]));

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
    popupEl.innerHTML = `<b>#${p.id} · ${xmlEsc(p.class_code)}</b><br>${xmlEsc(p.class_en)}<br>${xmlEsc(p.time_local)}${p.description ? '<br><i>' + xmlEsc(p.description) + '</i>' : ''}`;
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
    const header = ['observer', 'date_local', 'time_local', 'datetime_utc', 'class_code', 'class_id', 'class_en', 'class_zh', 'description', 'latitude', 'longitude', 'altitude_m', 'accuracy_m'];
    const lines = [header.join(',')];
    for (const p of points) {
      lines.push([
        p.observer, p.date_local, p.time_local, p.datetime_utc, p.class_code, p.class_id, p.class_en, p.class_zh || '', p.description,
        p.latitude.toFixed(7), p.longitude.toFixed(7),
        p.altitude_m == null ? '' : p.altitude_m.toFixed(1),
        p.accuracy_m == null ? '' : p.accuracy_m.toFixed(1)
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
  }

  async function buildZipBlob() {
    const base = fileBase();
    const zip = new JSZip();
    zip.file(`${base}.csv`, buildCsv());
    zip.file(`${base}.gpx`, buildGpx());
    zip.file(`${base}-track.csv`, buildTrackCsv());
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
    await opfsRemove(`${fileBase()}.csv`);
    await opfsRemove(`${fileBase()}.gpx`);
    await opfsRemove(`${fileBase()}-track.csv`);
    points = []; track = [];
    redrawPoints(); redrawTrack();
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

  // Web Share on Android Chrome only accepts "safe" file types (e.g. .csv, .txt); .zip and .gpx are
  // rejected with NotAllowedError "Permission denied". WeChat (and many messengers) only appear in the
  // share sheet for a SINGLE file, so the user picks one CSV at a time. navigator.share() must run
  // synchronously inside the click handler (no awaits before it) to keep the user-activation window.
  function shareOne(kind) {
    const base = fileBase();
    const file = kind === 'track'
      ? new File([buildTrackCsv()], `${base}-track.csv`, { type: 'text/csv' })
      : new File([buildCsv()], `${base}.csv`, { type: 'text/csv' });
    $('shareModal').classList.add('hidden');
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
