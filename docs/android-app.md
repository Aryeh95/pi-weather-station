# Sweep on Android

The kiosk build is a browser talking to `server/index.js` over the LAN, which
is why the phone needed a VPN to see radar from anywhere. The Android app has
no server: it carries the same client bundle plus the server's own controllers,
and calls the upstream services directly from the WebView.

That works because every source this project uses is public, keyless and
CORS-open. Verified 2026-09-03, all answering `Access-Control-Allow-Origin: *`:

| Upstream | Serves |
| --- | --- |
| `mesonet.agron.iastate.edu` | IEM radar JSON API, mosaic + single-site tiles |
| `api.weather.gov` | radar station, alerts, place name |
| `unidata-nexrad-level3.s3.amazonaws.com` | raw N0B / N0G radials, storm tracks |
| `noaa-mrms-pds.s3.amazonaws.com` | MRMS MESH hail |
| `noaa-goes19.s3.amazonaws.com` | GLM lightning |
| `basemaps.cartocdn.com` | basemap |
| `api.sunrise-sunset.org` | auto dark-mode switch |

## How the server runs inside the app

`client/src/standalone/` is the whole of it:

- **`api.js`** imports the real controllers (`server/iemRadarCtrl.js`,
  `radarRadialCtrl.js`, `stormTracksCtrl.js`, `glmLightningCtrl.js`,
  `govAlertsCtrl.js`) and runs them **verbatim** behind an Express-shaped
  `req`/`res` pair. They were already portable: `axios` works in a browser and
  the only Node built-ins in the set are two `zlib` calls plus `fs`/`path` in
  two best-effort caches.
- **`install.js`** swaps the axios *adapter*, so every existing
  `axios.get("/api/...")` in the hooks is answered in-process with no hook or
  component changed. The controllers' own upstream calls use absolute URLs and
  fall through to the real network adapter.
- **`upstream.js`** replaces the three routes that existed only because the
  server held a key or a socket — reverse geocoding (now the city/state that
  `api.weather.gov/points` already returns beside the radar station), sunrise/
  sunset, and the IP-geolocation fallback — plus the keyless basemap URL.
- **`shims/`** supplies `zlib` (via pako, because the decoders need
  *synchronous* inflate and `DecompressionStream` is async-only), a no-op
  `fs`/`path`, and static product/packet tables for the Level III library,
  which otherwise builds them with `fs.readdirSync` at import time.

Reusing the controllers rather than reimplementing them is deliberate: the
product-153/154 shim, the MOVEMENT-is-a-FROM-direction handling, the 8-bit vs
16-bit MRMS split and the ±150 s frame-to-key matching all took live debugging
to get right, and a parallel copy would drift on the platform where those bugs
are hardest to observe. The server test suite covers the app's data path.

## Differences from the kiosk

| | Kiosk | App |
| --- | --- | --- |
| Data | `server/index.js` over LAN | in-process, direct to upstreams |
| Basemap | Mapbox via server proxy (key) | CARTO, keyless |
| Place name | LocationIQ (key) | `api.weather.gov` point metadata |
| Position | server IP lookup | device GPS, IP fallback |
| Controls | dock along the bottom | left sidebar rail |
| Header | place + clock + date | place only |
| Zoom buttons | shown | hidden (pinch) |

No API keys are needed, and none ship in the APK.

## Building

```bash
cd app
npm install          # once
npm run apk          # builds the web bundle, syncs it, assembles the APK
```

The APK lands at `app/android/app/build/outputs/apk/debug/app-debug.apk`.
`npm run build:web` alone rebuilds `client/dist-app/` (the app bundle, kept
separate from the committed kiosk `client/dist/`).

Requires a JDK and the Android SDK; point `ANDROID_HOME` at the SDK and write
`sdk.dir=` into `app/android/local.properties`.

### Signing

`assembleDebug` signs with the standard Android debug key, which is fine for
sideloading onto your own device (enable "install unknown apps" for the
browser or file manager you open it from). A build for anyone else needs a
release keystore and `assembleRelease`.

## Updating the app

The app has no self-updater — the kiosk's update button is stubbed out, since
there is no checkout to pull. Rebuild the APK and reinstall over the top; the
package name is unchanged so it upgrades in place and keeps its preferences.
