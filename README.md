# Habitat 32

A bilingual (English / 中文) OpenLayers PWA for recording classified field points and a daily GPS track in the Bolshoy Khingan study area.

Live app: https://ikotlov-ux.github.io/khingan-field-app/

## Daily workflow

1. On every launch, select an observer: **Kotlov, Yachmennikova, Rozhnov, Zhu, Aristarkhova, Rodnikova, Ogurtsov, Sandlersky**, or enter another surname.
2. The app loads and displays only today's points and track for that observer.
3. Select a habitat class (English · 中文) and tap **Record point · 记录点**.
4. The date/time, observer, WGS 84 coordinates, altitude and GPS accuracy are recorded automatically.
5. The track runs continuously while **Stop track** is visible. A vertex is saved when at least 5 seconds or 5 metres separate it from the previous vertex.
6. Tap **Share · 分享**, choose **Points CSV** or **Track CSV**, then pick WeChat, Telegram, e-mail or another installed app in the phone's share sheet.
7. **Export ZIP · 导出 ZIP** downloads an archive with both CSV files and a GPX file.

## Header

Institute logo (IEE RAS) on the left, laboratory name in the middle, laboratory logo on the right. To add the laboratory logo, upload a square image named **`lab-logo.png`** to the repository root — no code changes needed (the slot stays hidden until the file exists).

## Photos with coordinates and camera heading

1. Select the point in **Attach photo to point** (the last recorded point is preselected; tapping a point on the map also selects it) and tap **Photo · 拍照**.
2. An in-app camera opens with a live compass: the big label shows the rumb in three notations (e.g. **NE · СВ · 东北**) and the magnetic heading in degrees; the rose in the corner turns with the phone. On iOS the browser asks once for motion/orientation permission.
3. Tap the shutter. The photo is saved to the phone as `surname-dd-mm-yy-pointID-N.jpg` (N = photo number for that point), e.g. `Kotlov-25-09-26-12-1.jpg`.
4. Each photo gets **EXIF** tags (GPSLatitude/Longitude/Altitude, GPSHPositioningError, GPSImgDirection with ref `M` = magnetic, DateTimeOriginal, ImageDescription with point/class/heading, Artist, Copyright) and a **visible stamp** at the bottom (filename, time, coordinates, heading and rumb, class). Photos are downscaled to 1600 px on the long side.
5. Photos appear as thumbnails under the point (tap a thumbnail to delete). `n_photos` is written to the points CSV; `surname-dd-mm-yy-photos.csv` lists every photo with its coordinates and heading; **Export ZIP** includes a `photos/` folder; **Share → Photos of selected point** sends the JPEGs (WeChat accepts multiple images).

If the in-app camera is unavailable (permission denied, old browser), the system camera app opens instead; coordinates and the last compass reading are still written.

Heading is magnetic (as reported by the phone's sensors). In the Bolshoy Khingan area magnetic declination is about −10°, so true azimuth ≈ magnetic − 10°; correct in GIS if needed.

## Map controls

Buttons in the top-right corner of the map: **+ / −** zoom, **⌖** centre on the current GPS position, **Sat / Map** toggles between OpenStreetMap and Esri World Imagery satellite basemaps. The chosen basemap is remembered.

## Automatic local storage

After every recorded point and track vertex, data is committed immediately to:

- **IndexedDB** (the primary local database), and
- daily **CSV** and **GPX** files in the browser's origin-private file system, where supported.

These internal files persist on the phone but are not directly visible in the file manager. **Export ZIP** or **Share** creates a user-visible file.

Example names for 24 September 2026:

- `Kotlov-24-09-26.csv` — classified points (observer, local date/time, UTC time, class code/id, class EN/ZH, description, lat, lon, altitude, accuracy)
- `Kotlov-24-09-26-track.csv` — today's track vertices (one row per vertex)
- `Kotlov-24-09-26.gpx` — today's track and points as GPX
- `Kotlov-24-09-26-photos.csv` + `photos/Kotlov-24-09-26-<pointID>-<N>.jpg` — photos with EXIF GPS and heading
- `Kotlov-24-09-26.zip` — everything above (Export ZIP)

Do not clear site data/cache before exporting. Each device stores its own data; GitHub Pages does not provide a shared database.

## Why Share sends one CSV at a time

- Android Chrome lets the Web Share API pass only "safe" file types (`.csv`, `.txt`, images, PDF…). `.zip` and `.gpx` are rejected with `NotAllowedError: Permission denied`, so sharing uses CSV.
- WeChat and several other messengers register as share targets for a **single** file of any type, but for multiple files only images. Sharing two CSVs at once therefore hides WeChat from the share sheet; the app shares one file per tap instead.
- The track CSV imports into QGIS via *Add Delimited Text Layer* and converts to a line with *Points to Path*; the GPX is available in the ZIP export.

## Track limitations

A browser/PWA cannot guarantee continuous GPS tracking after the operating system suspends it in the background. Keep the app visible while tracking. The app requests a Screen Wake Lock when supported to reduce interruptions. For guaranteed all-day background tracking with the screen off, a native Android application would be required.

## Offline behavior

The user interface and libraries are cached after the first successful HTTPS load. Recorded data, the track, export and sharing remain available offline. OpenStreetMap and Esri tiles are network resources; only tiles already viewed (and cached) are visible without internet.

## Files

- `index.html` — bilingual mobile UI
- `app.js` — OpenLayers map, basemaps, geolocation, IndexedDB/OPFS storage, CSV/GPX/ZIP export and sharing
- `classes.js` — 23 habitat classes (code, id, EN, RU, ZH) from the workbook `classes` sheet
- `vendor/` — local OpenLayers 10.6.1, JSZip 3.10.1, piexifjs 1.0.6 (EXIF writer)
- `sw.js` — offline app-shell cache
- `manifest.webmanifest`, `icon.svg`, `icon-*.png` — installable PWA metadata with the IEE RAS logo

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / root. Geolocation, file sharing, service workers and OPFS require a secure HTTPS context; GitHub Pages provides HTTPS.

## Copyright and license

© 2026 Ivan P. Kotlov, A.N. Severtsov Institute of Ecology and Evolution, Russian Academy of Sciences (IEE RAS). Logo: IEE RAS (sev-in.ru). Code is released under the MIT license; the IEE RAS logo is not covered by the MIT license.
