# Habitat 32

An OpenLayers PWA (UI in Russian or Chinese) for recording classified field points, geotagged photos with camera heading and a daily GPS track in the Bolshoy Khingan study area, with offline map cache and automatic upload to Yandex Disk.

Live app: https://ikotlov-ux.github.io/khingan-field-app/

## Daily workflow

1. On every launch, select an observer: **Kotlov, Yachmennikova, Rozhnov, Zhu, Aristarkhova, Rodnikova, Ogurtsov, Sandlersky**, or enter another surname.
2. The app loads and displays only today's points and track for that observer.
3. Select a habitat class and tap **Record point**.
4. The date/time, observer, WGS 84 coordinates, altitude and GPS accuracy are recorded automatically.
5. The track runs continuously while **Stop track** is visible. A vertex is saved when at least 5 seconds or 5 metres separate it from the previous vertex.
6. Take photos attached to the current point with **Photo**.
7. Files of the day are uploaded to Yandex Disk automatically when online; **Share** saves a ZIP to Downloads and opens the share sheet.

## Header

Institute logo (IEE RAS) on the left, laboratory name in the middle, laboratory logo on the right. To add the laboratory logo, upload a square image named **`lab-logo.png`** to the repository root — no code changes needed (the slot stays hidden until the file exists).

## Interface language

The UI is shown in one language at a time — Russian or Chinese — switched with the **RU / 中文** button next to the title. The choice is remembered on the phone. File contents (CSV headers, GPX, EXIF) stay in English with class names in all three languages.

## Photos with coordinates and camera heading

1. Select the point in **Attach photo to point** (the last recorded point is preselected; tapping a point on the map also selects it) and tap **Photo · 拍照**.
2. An in-app camera opens with a live compass: the big label shows the rumb (e.g. **СВ** / **东北**) and the magnetic heading in degrees; the rose in the corner turns with the phone. Across the viewfinder **vertical lines mark the 8 rumbs** (N in red) at their true screen position (assuming a ~50° horizontal field of view), and **yellow dashed frames show the photos already taken at this point** with their number and heading, so consecutive shots can be overlapped for a panorama. On iOS the browser asks once for motion/orientation permission.
3. Tap the shutter. The photo is saved to the phone as `surname-dd-mm-yy-pointID-N.jpg` (N = photo number for that point), e.g. `Kotlov-25-09-26-12-1.jpg`.
4. Each photo gets **EXIF** tags (GPSLatitude/Longitude/Altitude, GPSHPositioningError, GPSImgDirection with ref `M` = magnetic, DateTimeOriginal, ImageDescription with point/class/heading, Artist, Copyright) and a **visible stamp** at the bottom (filename, time, coordinates, heading and rumb, class). Photos are downscaled to 1600 px on the long side.
5. Photos are not displayed in the interface (only counted). `n_photos` is written to the points CSV; `surname-dd-mm-yy-photos.csv` lists every photo with its coordinates and heading; the ZIP includes a `photos/` folder; photos are uploaded to Yandex Disk automatically.

If the in-app camera is unavailable (permission denied, old browser), the system camera app opens instead; coordinates and the last compass reading are still written.

Heading is magnetic (as reported by the phone's sensors). In the Bolshoy Khingan area magnetic declination is about −10°, so true azimuth ≈ magnetic − 10°; correct in GIS if needed.

## Map controls

Buttons in the top-right corner of the map: **+ / −** zoom, **⌖** centre on the current GPS position, **Sat / Map** toggles between OpenStreetMap and Esri World Imagery satellite basemaps. The chosen basemap is remembered.

## Automatic local storage

After every recorded point and track vertex, data is committed immediately to:

- **IndexedDB** (the primary local database), and
- daily **CSV** and **GPX** files in the browser's origin-private file system, where supported.

These internal files persist on the phone but are not directly visible in the file manager. **Share** creates a user-visible ZIP file.

Example names for 24 September 2026:

- `Kotlov-24-09-26.csv` — classified points (observer, local date/time, UTC time, class code/id, class EN/ZH, description, lat, lon, altitude, accuracy)
- `Kotlov-24-09-26.gpx` — today's track and points as GPX
- `Kotlov-24-09-26-photos.csv` + `photos/Kotlov-24-09-26-<pointID>-<N>.jpg` — photos with EXIF GPS and heading
- `Kotlov-24-09-26.zip` — everything above (Share)

Do not clear site data/cache before exporting. Each device stores its own data; GitHub Pages does not provide a shared database.

## Share (ZIP)

**Share** builds `surname-dd-mm-yy.zip` (points CSV, GPX with waypoints + track, photos CSV, `photos/*.jpg`), saves it to the phone's Downloads and opens the system share sheet with the ZIP as a single file. Android Chrome only allows sharing "safe" file types (CSV, TXT, images, PDF) and rejects `.zip` — in that case the app shows a dialog: open the ZIP from the download notification or the Files app and share it from there, or send the points CSV / the photos of the selected point directly. On iOS the ZIP is shared directly. Track CSV is no longer produced — the track is in the GPX.

## Automatic upload to Yandex Disk

Every change (point, photo, deletion) marks the day as modified; 2–3 minutes after the last change, if the phone is online, the app uploads the day's files to Yandex Disk into `IPEE/Habitat32/<surname>/<dd-mm-yy>/` (`*.csv`, `*.gpx`, `*-photos.csv`, `photos/*.jpg`). Track-only changes are uploaded at most every 15 minutes. Uploads are retried after 1, 5, 15, 60 minutes on failure, and run again when the network returns, when the app is reopened, or when **Send now** is tapped. On Android Chrome a Background Sync task also uploads the queue when connectivity returns even if the app was closed. The status line in the **Yandex Disk** card shows the last upload time or the number of files waiting. Clearing the day removes local data only; files already uploaded stay on the Disk.

Setup (once): create an OAuth app at https://oauth.yandex.ru/client/new (platform "Web services", redirect URI `https://oauth.yandex.ru/verification_code`, permissions `cloud_api:disk.write` and `cloud_api:disk.read`), open `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ID>` while logged in to the Disk owner's account and copy the token. Paste it into **Yandex Disk → OAuth token → Save**, or open the app once with `?yt=<token>` appended to the URL (the token is stored on the phone and removed from the address bar). Colleagues' phones need the same token (or their own, if the folder is shared with them with edit rights).

## Offline map cache

Tiles that were displayed are cached automatically (OSM and Esri imagery). In addition, whenever the map is moved while online, the app prefetches both basemaps for zoom levels 15…10 covering the visible area plus 2.5 km around the map centre (up to 500 tiles per movement, 4 parallel requests; progress is shown under the map). Working zooms 16–18 are cached as you view them.


## Track limitations

A browser/PWA cannot guarantee continuous GPS tracking after the operating system suspends it in the background. Keep the app visible while tracking. The app requests a Screen Wake Lock when supported to reduce interruptions. For guaranteed all-day background tracking with the screen off, a native Android application would be required.

## Offline behavior

The user interface and libraries are cached after the first successful HTTPS load. Recorded data, the track, export and sharing remain available offline. OpenStreetMap and Esri tiles are network resources; only tiles already viewed (and cached) are visible without internet.

## Files

- `index.html` — bilingual mobile UI
- `app.js` — OpenLayers map, basemaps, geolocation, IndexedDB/OPFS storage, CSV/GPX/ZIP export and sharing
- `classes.js` — 29 habitat classes (code, id, EN, RU, ZH) from the workbook `classes` sheet
- `i18n.js` — Russian / Chinese UI strings; `sync-core.js` — Yandex Disk upload core shared by the page and the service worker
- `vendor/` — local OpenLayers 10.6.1, JSZip 3.10.1, piexifjs 1.0.6 (EXIF writer)
- `sw.js` — offline app-shell cache
- `manifest.webmanifest`, `icon.svg`, `icon-*.png` — installable PWA metadata with the IEE RAS logo

## GitHub Pages

Settings → Pages → Deploy from a branch → `main` / root. Geolocation, file sharing, service workers and OPFS require a secure HTTPS context; GitHub Pages provides HTTPS.

## Copyright and license

© 2026 Ivan P. Kotlov, A.N. Severtsov Institute of Ecology and Evolution, Russian Academy of Sciences (IEE RAS). Logo: IEE RAS (sev-in.ru). Code is released under the MIT license; the IEE RAS logo is not covered by the MIT license.
