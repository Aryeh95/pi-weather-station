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
| `server.arcgisonline.com` | basemap (Esri Canvas) |

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
  `api.weather.gov/points` already returns beside the radar station) and the
  IP-geolocation fallback — plus the keyless basemap URL. Sunrise / sunset
  needs no replacement: `server/proxyCtrl.js` computes it locally, so the
  app imports that handler and runs the same code the kiosk does.
- **`settingsStore.js`** backs `GET /settings`, `PATCH /setting` and
  `POST /settings` with localStorage, so the Advanced controls and saved
  places persist on the device instead of appearing editable and losing every
  change on relaunch.
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
| Basemap | Mapbox via server proxy (key) | Esri Canvas, keyless |
| Place name | LocationIQ (key) | `api.weather.gov` point metadata |
| Position | server IP lookup | device GPS, IP fallback |
| Controls | dock along the bottom | left sidebar rail |
| Header | place + clock + date | place only |
| Zoom buttons | shown | hidden (pinch) |
| Settings | 3 sections incl. API keys | 2 sections; no keys, no cert, no sleep |
| Settings store | `settings.json` on the server | this device's storage |

No API keys are needed, and none ship in the APK.

### A caution about "keyless"

The first attempt used CARTO's basemaps, which answer **HTTP 200 with a
normal-looking PNG whose pixels carry an "API KEY REQUIRED" watermark**. A
status-code check said keyless; the map said otherwise. Esri's Canvas tiles
have a quieter version of the same trap — above z16 they return 200 with a
JPEG reading "Map data not yet available", which is why the layer is capped
with `maxNativeZoom: 16` and upscales beyond it.

Whenever a tile source is swapped, look at the tiles.

### What the Settings panel drops in the app

Removed because there is no server or no pointer behind them: the whole API
section (Mapbox / LocationIQ keys, starting coordinates), "Trust this Pi"
(downloads the server's CA), "Hide mouse pointer", the Mapbox basemap-style
pickers, the entire Sleep group (it dims an always-on panel through the
server's brightness endpoint; a phone has its own screen timeout, and the
night-red palette it also gathers is on the dock), and the Diagnostic row
(it reports whether the *service* was started with `DEBUG=true`).

What remains is everything that acts on this device: language, font size,
clock, units, alert display toggles, radar opacity and alert radius.

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

### Signing, and the sideload warnings

```bash
npm run apk:release   # signed, non-debuggable, ~4.8 MB
```

Android shows a sideloaded app several warnings, and they have different
causes — only some are fixable:

| Warning | Cause | Fixable |
| --- | --- | --- |
| "Install unknown apps" permission | Sideloading at all; granted per source app | No — one grant per source |
| Play Protect "unknown developer" | Google has never seen this signing certificate | Not outside a store |
| Extra scan / "unsafe app" friction | Debug certificate + `android:debuggable` | **Yes — build release** |
| "Built for an older version of Android" | Low `targetSdkVersion` | Already current (36) |

`assembleDebug` signs with `CN=Android Debug` — the certificate every debug
build on earth shares — and marks the app debuggable, which is the
combination Play Protect treats most suspiciously. A release build carries
the project's own certificate and drops the debuggable flag, which is the
mildest install path available without publishing. The prompt does not
disappear entirely: "unknown developer" is about Google not recognising the
certificate, and only distribution through a store (a Play internal-testing
track is enough) removes it.

**The keystore is the app's identity.** Android upgrades an installed app in
place only when the new APK carries the *same* key, so keep
`app/android/app/sweep-release.jks` backed up. Both it and
`keystore.properties` are gitignored — a signing key never belongs in a
repository. To make your own instead:

```bash
keytool -genkeypair -v -keystore app/android/app/sweep-release.jks \
  -alias sweep -keyalg RSA -keysize 4096 -validity 10950
cat > app/android/app/keystore.properties <<EOF
storeFile=sweep-release.jks
storePassword=<the store password>
keyAlias=sweep
keyPassword=<the key password>
EOF
```

Switching to a different key means uninstalling the old app first — the
install will otherwise fail with a signature mismatch. `assembleRelease`
without these files still builds; it just produces an unsigned APK rather
than failing the build.

## Updating the app

The app has no self-updater — the kiosk's update button is stubbed out, since
there is no checkout to pull. Rebuild the APK and reinstall over the top; the
package name is unchanged so it upgrades in place and keeps its preferences,
**provided the new APK is signed with the same key**.
