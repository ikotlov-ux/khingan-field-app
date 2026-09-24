# Field Points — Bolshoy Khingan

An English-language OpenLayers PWA for recording classified field points and a daily GPS track.

## Daily workflow

1. On every launch, select an observer: **Kotlov, Yachmennikova, Rozhnov, Zhu, Aristarkhova, Rodnikova, Ogurtsov, Sandlersky**, or enter another surname.
2. The app loads and displays only today's points and track for that observer.
3. Select a habitat class and tap **Record point**.
4. The date/time, observer, WGS 84 coordinates, altitude and GPS accuracy are recorded automatically.
5. The track runs continuously while **Stop track** is visible. A vertex is saved when at least 5 seconds or 5 metres separate it from the previous vertex.
6. Tap **Share** to open the phone's native share sheet and choose email or an installed messenger. Share sends today's **CSV files** (points and track). Use **Export ZIP** to download the archive with CSV + GPX.

## Automatic local storage

After every recorded point and track vertex, data is committed immediately to:

- **IndexedDB** (the primary local database), and
- daily **CSV** and **GPX** files in the browser's origin-private file system, where supported.

These internal files persist on the phone but are not directly visible in the file manager. **Export ZIP** or **Share** creates a user-visible ZIP archive containing both files.

Example names for 24 September 2026:

- `Kotlov-24-09-26.csv` — classified points
- `Kotlov-24-09-26-track.csv` — today's track vertices (one row per vertex)
- `Kotlov-24-09-26.gpx` — today's track and points as GPX
- `Kotlov-24-09-26.zip` — all three files (Export ZIP)

**Why Share sends CSV, not ZIP/GPX:** Android Chrome allows the Web Share API to pass only "safe" file types (e.g. `.csv`, `.txt`, images, PDF). `.zip` and `.gpx` are rejected with `NotAllowedError: Permission denied`, so the share sheet receives the two CSV files. The track CSV imports into QGIS as points (Add Delimited Text Layer) and converts to a line with *Points to Path*; the GPX is available in the ZIP export.

Do not clear site data/cache before exporting. Each device stores its own data; GitHub Pages does not provide a shared database.

## Track limitations

A browser/PWA cannot guarantee continuous GPS tracking after the operating system suspends it in the background. Keep the app visible while tracking. The app requests a Screen Wake Lock when supported to reduce interruptions. For guaranteed all-day background tracking with the screen off, a native Android application would be required.

## Offline behavior

The user interface and libraries are cached after the first successful HTTPS load. Recorded data, the track, export and sharing remain available offline. OpenStreetMap tiles are network resources; only tiles already present in the browser cache may be visible without internet.

## Files

- `index.html` — English mobile UI
- `app.js` — OpenLayers map, geolocation, IndexedDB/OPFS storage, CSV/GPX/ZIP export and sharing
- `classes.js` — 23 habitat classes from the workbook `classes` sheet
- `vendor/` — local OpenLayers and JSZip libraries
- `sw.js` — offline app-shell cache
- `manifest.webmanifest`, `icon.svg` — installable PWA metadata

## GitHub Pages

Upload all files to a repository and enable **Settings → Pages → Deploy from a branch → main / root**. Geolocation, file sharing, service workers and OPFS require a secure HTTPS context; GitHub Pages provides HTTPS.

## License

MIT.
