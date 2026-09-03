# Sweep — Roadmap

What is still open after the August–September 2026 radar rework. Not a
schedule. The pre-rework roadmap, with its forecast, air-quality and
Canadian-source items, is preserved in
[`docs/archive/`](docs/archive/) for the record; almost all of it became
moot when the project narrowed to a radar viewer.

Shipped in this cycle (details in [CHANGELOG.md](CHANGELOG.md)): two-layer
NEXRAD radar with frame age · raw N0B radial rendering · sharp loop
playback · clear-air noise filter · storm tracks + meso/TVS · GLM lightning
· **velocity mode (N0G)** · **storm arrival labels** · **per-layer frame-age
stack** · **tile-side noise filter** · **idle-aware polling**.

---

## Radar features

### 🌀 Alert-driven attention mode
When a Tornado or Severe Thunderstorm Warning polygon contains the home
point: zoom to the site layer, turn on storm tracks and lightning, wake the
screensaver, and show the alert banner. Everything it needs is already
polled; the work is the state machine and a way to dismiss it. ~half a day.

### 🌡️ Velocity fallback and second tilt
Velocity mode has no tile fallback (IEM serves none), so a frame whose N0G
radial has not rendered shows nothing at high zoom. Options: pre-warm the
velocity loop while in reflectivity mode (costs bandwidth), or accept the
~15 s warm-up. Separately, the same product-154 shim decodes `N1G`/`N1B`
(second tilt) — a tilt picker is cheap once velocity mode has settled.

### 🧭 Storm-relative velocity and arrival refinements
The arrival estimate is straight-line from SCIT's forecast heading. Small
refinements: show the miss distance in the label when > 5 km, and grey the
label when the cell's `speedKt` disagrees with its forecast span (SCIT
noise). The N0S product (storm-relative velocity) is available from IEM as
tiles if a "storm-relative" toggle is wanted.

### 📡 Level II (only if latency still hurts)
`unidata-nexrad-level2-chunks` gives partial sweeps as the radar turns,
all tilts and dual-pol moments. Only worth it if the 4–6 min Level III
cadence remains annoying after living with velocity mode. Decoder:
`netbymatt/nexrad-level-2-data`.

### 🌊 NWPS river gauges
Research captured in
[`docs/research-nws-hydro-and-gis-sources.md`](docs/research-nws-hydro-and-gis-sources.md).
Fits a flood-warning radar view; keyless.

---

## Kiosk and operations

### 🩹 Dedicated `pi-weather-kiosk.service` with `Restart=always`
The kiosk browser is launched by an autostart entry that runs once per
session; a browser crash leaves the screen dark until the next login. A
`--user` unit with `Restart=always` fixes that at the root but must replace
four autostart paths (labwc / wayfire / LXDE-pi / XDG) in `install.sh` and
`uninstall.sh` and inject the Wayland environment. Deferred for blast
radius, not difficulty.

### 🧹 Installer cleanup
`deploy/install.sh` still prompts for a Tomorrow.io key and a Sense HAT,
carries the Homebridge probe, and ships `pi-sensehat*.service`. Remove the
dead phases and the two unit files. Keep the on-disk `pi-weather-*`
identifiers (service, config dir, log path) — existing installs and the
updater's drift check depend on them.

### 🔧 Settings allow-list trim
`server/settingsCtrl.js` still accepts `weatherApiKey`, `anthropicApiKey`,
`airNowApiKey`, `openAqApiKey` and `indoorTemperature`. Nothing reads them.
Drop them (and the `REMOTE_HIDDEN_KEYS` entry) so a stale `settings.json`
cannot look configured. One-line change plus tests.

### ❤️ Health classifier
LocationIQ is optional but listed critical in `healthCtrl.js`; a failing
geocoder paints the dot red. Move it to non-critical. Also add an Express
error middleware and `process.on("unhandledRejection")` logging — an async
throw outside a controller's catch is currently silent — and drain
in-flight requests in `shutdown()` with `server.close()`.

### 👀 Vendor watch — Mapbox raster tiles
The one paid dependency. The whole Mapbox surface is the tile proxy in
`proxyCtrl.js`, metered against the 50 000/month ceiling in
`requestCounter.js`. Watch the raster-tiles line on mapbox.com/pricing; the
`mapbox → tiles` counter in the debug panel is the canary.

---

## Technical debt

### 🧪 Client tests
Pure client modules (`iemRadar.js`, `radialRender.js` helpers,
`stormArrival.js`, `alertParser.js`, `alertLogic.js`) are covered through
verbatim copies drift-checked by `test/verbatimSync.test.js`. React
components and hooks have no tests. A Node-side test for `FilteredTileLayer`'s
`filterPixels` (pure over an RGBA buffer) would be the next cheap win; it
needs the module split from its Leaflet import.

### 🛠️ React 19 follow-ups
`eslint-plugin-react-hooks@7` surfaced 25 findings (18 `set-state-in-effect`)
that must land together with the lint bump, since lint runs inside the
webpack build. React Compiler adoption is unblocked but should be benched
on target hardware first.

### ⏳ ESLint 10
Blocked on `eslint-plugin-react` supporting `eslint ^10`. Re-check with
`npm view eslint-plugin-react peerDependencies`.

### 📋 Lint the server and tests
ESLint only covers `client/`. Add a flat config for `server/` and `test/`,
plus an `engines` field / `.nvmrc` (Node 22 is pinned only in CI).

### 🗂️ `AppContext.js` size
~2,400 lines carrying seven slices. With the forecast state gone, the
remaining slices could become separate providers. Diminishing returns;
do it when touching the file for another reason.

### 🔒 Committed-`dist` content verification — risk-accepted
CI checks the committed file set, not byte content (macOS and Linux
terser output differ). Accepted 2026-06-12; unchanged.

---

*Last updated: 2026-09-03 — rewritten for the radar-only project after the
documentation reset.*
