# Sweep — Software Architecture

*Current as of the September 2026 radar build. The forecast-dashboard
architecture this project was cut from is preserved in
[`docs/archive/`](docs/archive/).*

---

## 1. Context and objectives

Sweep is a self-hosted NEXRAD radar kiosk: a small Node/Express server and a
React + Leaflet client that fill a screen with a two-layer radar view,
storm-cell tracks, lightning and NWS alert polygons, with the age of every
layer spelled out on the map. Forecasting is deliberately out of scope.

### Target use case

An always-on display in a home, operated by touch or not at all. The
browser runs in kiosk mode, the server starts at boot (systemd on Linux,
launchd on macOS), and the device needs no attention after setup. The
reference deployment is a Surface Pro on Ubuntu; Raspberry Pis and other
Linux desktops work the same way.

### Quality attributes

| Attribute | Target | How it is addressed |
|---|---|---|
| **Honest freshness** | Staleness is visible, never suspected | Every layer's data time is polled and shown; thresholds encode NEXRAD's 4–6 min scan floor; failing pollers flag rather than freeze |
| **Availability** | 24/7 unattended | systemd `Restart=on-failure`; disk caches for geolocation and request counters; `ExecStartPre` waits for DNS |
| **Upstream courtesy** | Minimal traffic to free public sources | Server-side shared caches sized to each product's cadence; all pollers pause while the screensaver is up or the document is hidden |
| **Security** | Keys never leave the host | Mapbox and LocationIQ calls proxied; remote clients get masked booleans; all writes localhost-only |
| **Maintainability** | Deployable with `git pull` | `client/dist/` committed; in-app updater with pre-flight checks |
| **Cross-distro portability** | Pi OS, Debian/Ubuntu, openSUSE, macOS | `install.sh` detects package manager, browser family and desktop environment |

---

## 2. System view

```
                     ┌─────────────────┐            ┌─────────────┐
                     │ Browser (LAN)   │            │ Phone (LAN) │
                     └────────┬────────┘            └──────┬──────┘
                              │      ALLOW_REMOTE=true     │
                              └──────────────┬─────────────┘
                                       HTTPS :8443
┌──────────────────┐                         │
│ Kiosk browser    │   loopback   ┌──────────▼───────────────────────────────┐
│ (Chromium/Firefox├─────────────►│            Express server                │
└──────────────────┘              │                                          │
        ▲                         │  /settings (write: localhost only)       │
        │ tiles direct            │  /api/tiles/*          → Mapbox proxy    │
        │ (keyless, CORS *)       │  /api/radar/site,frames → IEM JSON       │
        │                         │  /api/radar/radial     → L3 bucket decode│
        │                         │  /api/storm-tracks     → L3 bucket decode│
        │                         │  /api/lightning        → GOES bucket     │
        │                         │  /api/weather-alerts, nearby-alerts → NWS│
        │                         │  /api/sunrise-sunset, reverse-geocode    │
        │                         │  /api/health, update-check, debug (local)│
        │                         └───────┬──────────────────────────────────┘
        │                                 │ Internet
   ┌────┴─────────┐   ┌───────────────────┼──────────────┬──────────────┐
   │ IEM tile.py  │   │ unidata-nexrad-   │  noaa-goes19 │ api.weather  │
   │ N0Q mosaic   │   │ level3 (S3)       │  (S3) GLM    │ .gov / ECCC  │
   │ ridge:: N0B  │   │ N0B N0G NST NMD   │              │ Mapbox ·     │
   └──────────────┘   └───────────────────┴──────────────┴─ LocationIQ ─┘
```

- **Kiosk browser** talks to the server over loopback, which grants it
  settings writes, the debug endpoint, brightness and the updater.
- **Remote browsers** (with `ALLOW_REMOTE=true`) get a read-only view.
- **Radar tiles** are the one thing the browser fetches directly: IEM's
  mosaic and single-site PNGs are public and keyless.
- **Everything else** is proxied, cached and journaled by the server.

---

## 3. Server

`server/index.js` bootstraps Express, generates or loads the TLS
certificate, wires the routes and rate limiters, and hosts the `/api/update`
flow. Controllers are single-purpose modules:

```
server/
  index.js              routes, TLS, rate limits, update flow, timestamped console
  settingsCtrl.js       settings.json: allow-list, masking, atomic 0600 writes
  proxyCtrl.js          Mapbox tiles, LocationIQ, sunrise-sunset.org
  geolocationCtrl.js    ipapi.co default location, 30-day disk cache
  iemRadarCtrl.js       /api/radar/site + /api/radar/frames (IEM JSON API,
                        NWS points lookup, mosaic valid-time metadata)
  nexradBucket.js       shared listing / newest-key / key-timestamp helpers for
                        the public unidata-nexrad-level3 bucket (continuation-
                        token aware, hour-prefixed, cached per hour)
  radarRadialCtrl.js    /api/radar/radial — product-153 (N0B) and 154 (N0G)
                        shims over nexrad-level-3-data, azimuth re-bucketing,
                        base64 level payload, latest + per-stamp caches
  stormTracksCtrl.js    /api/storm-tracks — STI (58) cells + NMD (141) mesos
  mrmsHailCtrl.js       MRMS MESH hail sampled at each cell — pure-JS GRIB2/PNG
                        decoder over the public noaa-mrms-pds bucket
  glmLightningCtrl.js   /api/lightning — GOES-19 GLM HDF5 via h5wasm, rolling window
  govAlertsCtrl.js      /api/weather-alerts + /api/nearby-alerts orchestration
  govAlertSources/      nws.js, eccc.js, nwsZones.js, _shared.js (geometry)
  healthCtrl.js         /api/health classifier over the service journal
  updateChecker.js      tracked-branch git fetch/compare, deploy-file drift
  brightnessCtrl.js     sysfs backlight / ed-ddc-server
  displayScaleCtrl.js   browser.conf DISPLAY_SCALE + kiosk relaunch
  debugCtrl.js          debug panel payload, CPU temp / fan, log tail
  boundedCache.js · singleFlight.js · serviceStatus.js · requestCounter.js
  responseTimer.js · clientTracker.js · securityHeaders.js · rateLimitKey.js
```

### Middleware stack

`bodyParser.json()` → `express.static(client/dist)` → response timer →
`req.isLocal` from the **socket peer** (never `req.ip`) → per-route
`localhostOnly` / `apiLimiter` (120/min) / `tileLimiter` (600/min) /
per-peer concurrency guard on nearby alerts.

### Caching

Every upstream has a `BoundedMap` cache sized to its cadence: frame lists
45 s, radial / tracks 60 s, historical radials 30 min (immutable scans),
lightning 20 s, alerts 5 min, site lookups 24 h, mosaic metadata 60 s. The
health classifier reads the same service journal every call writes to.

---

## 4. Client

React 19 + react-leaflet 5, bundled by webpack 5 into the committed
`client/dist/`. State lives in `AppContext.js`, published as seven context
slices so a zoom change re-renders only radar consumers.

```
client/src/
  AppContext.js                 settings, location, prefs, alerts, radar state,
                                sleep stage → pollingPaused
  components/AmbientLayers      layout shell (desktop / Pi / mobile)
  components/ambient/           RadarHeader, BottomDock + ControlButtons,
                                AlertBanner + stack, SettingsPanel, DebugPanel,
                                HealthIndicator, PlacesPopover, …
  components/WeatherMap/
    index.js                    MapContainer, layer orchestration, playhead
    iemRadar.js                 tile URLs, mosaic frame grid, zoom band, frameAge
    useIemRadarFrames.js        60 s poller: site frames + mosaic valid time
    useRadarRadial.js           latest raw radial → canvas → ImageOverlay
    useRadarRadialLoop.js       historical radials, one at a time, sliding window
    radialRender.js             inverse-mapped mercator canvas; dBZ + velocity LUTs
    FilteredTileLayer.js        canvas TileLayer clearing < 15 dBZ via IEM's palette
    iemN0qPalette.json          IEM's published N0Q colour → dBZ table
    RadarFrameAge.js            per-layer age stack (site / mosaic / tracks / GLM)
    RadarTimeline.js            scrubber, play/pause, speed
    RadarLegend.js              dBZ scale, velocity scale, warning key, GLM count
    StormTracks.js + stormArrival.js   SCIT tracks, meso/TVS, arrival labels
    LightningOverlay.js         age-faded GLM bolts
    useStormTracks / useLightning
  hooks/                        useIdleDetection, useDocumentVisible, useScreenSaver,
                                useUpdateChecker, useFavoriteLocations, …
  i18n/locales/{en,fr,es}.json
```

### Radar layer orchestration

- **Zoom band.** Mosaic alone at z ≤ 7, 50/50 crossfade at z = 8,
  single-site alone at z ≥ 9. `layerOpacities` and `layerVisibility` share
  one source of truth so a layer is mounted exactly when its opacity is
  non-zero.
- **Playhead.** One index counted from the newest frame, resolved against
  each layer's own list (`pickFromEnd`), so the 11-frame mosaic grid and the
  30-scan site list stay in step and a layer hides past its own span.
- **Raw radials.** At high zoom the latest volume scan is decoded from the
  Level III bucket and painted gate-by-gate; historical frames warm in the
  background and only a sliding window of overlays is mounted (each decoded
  bitmap is ~26 MB). Until a frame's radial exists, its IEM tile shows.
- **Velocity mode.** The dock toggle swaps the radial product to N0G. The
  frame list still comes from N0B (IEM has no velocity tile product), and
  velocity scans share the same volume-scan timestamps. No reflectivity
  tiles are mounted in velocity mode; the mosaic stays reflectivity.
- **Noise filter.** The raw-radial LUT drops < 15 dBZ; `FilteredTileLayer`
  applies the same floor to the IEM tiles by exact colour lookup in IEM's
  published table (every opaque tile pixel is a table colour — measured).
- **Frame age.** `RadarFrameAge` shows one row per visible layer: the
  on-screen site frame, the mosaic (IEM's valid time, or "~" when derived),
  the storm-track scan time, and the newest GLM flash.
- **Arrival labels.** `stormArrival.estimateArrival` projects the home
  point onto each cell's forecast motion; cells passing within 20 km within
  3 h get a permanent arrival label. Every cell shows its id, every
  forecast tick its clock time; a tap opens a card with heading, speed,
  arrival and MRMS MESH hail size, without moving the location pin.

### Polling and idle behaviour

Every poller (frames, radial, loop warm-up, tracks, lightning, alerts,
solar, health) and the loop animation take `pollingPaused` from
`SystemContext`, which is true while the screensaver is at stage ≥ 1 or the
document is hidden. Paused pollers keep their last data and refetch
immediately on resume, so an unwatched night costs nothing upstream and the
first frame after wake is current within a second.

---

## 5. Key data flows

### Cold boot

1. Server loads `settings.json`, generates or re-signs the TLS leaf, starts.
2. Client fetches `/settings`, `/api/is-local`, `/geolocation` (if no
   coordinates), `/api/sunrise-sunset`, `/api/health`.
3. `useIemRadarFrames` calls `/api/radar/frames?lat&lon` → site resolved
   via NWS, 30 scans + mosaic time returned; mosaic tiles mount at once,
   site tiles when in band.
4. At z ≥ 8 `useRadarRadial` fetches `/api/radar/radial?site=` and renders
   the canvas (~300 ms); the ImageOverlay replaces the site tiles.
5. Storm tracks and lightning poll only when their toggles are on.

### New volume scan

Poller (60 s) sees a new newest stamp → frame-age row resets → radial
poller sees a new bucket key → one canvas render → overlay swap keyed on
the new URL (old object URL revoked).

### Scrub / play

Timeline index → `pickFromEnd` per layer → opacity flips between mounted
frames (tiles pre-mounted with the timeline open; radial overlays in a
window around the playhead). Velocity mode plays the same stamps through
N0G.

### Update

Client polls `/api/update-check` every 6 h → server `git fetch` on the
tracked branch, compares SHAs, lists commits → dock badge → modal →
`POST /api/update` (pre-flight, pull, npm install, restart).

---

## 6. Deployment

```
~/.config/systemd/user/
  pi-weather-server.service              main unit (ExecStartPre waits for DNS)
  pi-weather-server.service.d/
    override.conf                        log redirect, DEBUG
    local.conf                           ALLOW_REMOTE
~/.local/bin/start-server                waits for the server, launches the kiosk browser
~/.config/pi-weather-station/browser.conf   BROWSER_CMD, BROWSER_FAMILY, DISPLAY_SCALE
~/.local/state/pi-weather-station/server.log
Autostart: ~/.config/labwc/autostart · wayfire.ini · LXDE-pi/autostart · XDG *.desktop
macOS: ~/Library/LaunchAgents/com.pi-weather-station.plist
```

The on-disk identifiers keep their historical `pi-weather-*` names on
purpose: existing installs, the updater's service-file drift check and the
toggle scripts all key on them. The product name changed; the paths did
not.

---

## 7. Architecture decision records

### ADR-01 — Keyed upstreams proxied server-side; radar tiles direct

Mapbox and LocationIQ calls are made by the server so keys never reach the
browser and all clients share one cache. IEM radar tiles are keyless and
CORS-open, so Leaflet fetches them directly — proxying them would only add
a hop and a cache the browser already has.

### ADR-02 — `client/dist/` committed to git

Kiosks update with `git pull` + restart and never need a build toolchain.
The bundle is rebuilt and committed on the development machine; CI checks
the committed file set is reproducible.

### ADR-03 — Raw Level III radials rendered client-side

IEM's single-site tiles are pre-smoothed (10 distinct colours in a z12 tile
over a storm). Decoding the raw N0B/N0G products from the public Level III
bucket and painting each gate on a canvas gives RadarScope-class detail
without Level II's chunk assembly. The IEM tiles remain the mosaic and the
fallback.

### ADR-04 — Frame age is a first-class UI element

NEXRAD has an irreducible 4–6 min latency floor; the failure mode that
motivated the project was radar that was quietly 15 min old. Every layer's
data time is displayed, thresholds are fresh < 6 / aging 6–12 / stale ≥ 12
min, and a failing poller flags the last good data rather than freezing.

### ADR-05 — Pollers pause on idle

Every interval in the client gates on `pollingPaused` (screensaver stage or
hidden document). The alternative — polling a screen nobody sees — spends
IEM, NWS and S3 bandwidth for nothing. Paused pollers keep their state so
wake-up is instant.

### ADR-06 — HTTPS with an auto-generated CA + leaf

Avoids mixed-content errors and encrypts LAN traffic. The leaf's SAN covers
loopback, LAN IPs and the hostname; an IP change re-signs the leaf under the
same CA so trusted devices stay trusted. `SKIP_CERT_AUTOGEN=true` uses
operator-supplied files instead.

### ADR-07 — `ExecStartPre` waits for DNS

Cold boots can bring the user session up before the network is usable;
waiting for `getent hosts` avoids a first wave of `EAI_AGAIN` failures.
Combined with `dns.setDefaultResultOrder("ipv4first")`.

### ADR-08 — In-app updater with pre-flight checks

`POST /api/update` refuses detached HEADs, non-master branches and dirty
trees with a structured 409, then pulls fast-forward-only and installs
dependencies before restarting. The update check compares against the
tracked remote branch and reports its own failures.

### ADR-09 — Browser choice persisted in `browser.conf`

Different distributions ship different default browsers with different
kiosk flags; `install.sh` records the choice and `start-server` honours it.

---

## 8. Known limitations

| Limitation | Notes |
|---|---|
| Client code has no automated tests | Pure modules are copied verbatim into `node --test` files and drift-checked; React components are untested |
| Velocity mode has no tile fallback | IEM serves no velocity tiles for the site layer, so frames without a rendered N0G radial show nothing at high zoom until the loop warms |
| Mosaic has no velocity counterpart | Low zoom always shows reflectivity |
| `AppContext.js` is large | Seven slices, one 2,400-line file |
| Self-signed certificate | Browser warning on first visit, by design |
| `install.sh` still asks about removed features | Tomorrow.io key and Sense HAT prompts are harmless but stale |
