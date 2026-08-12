# pi-weather-station → radar-focused rework

## Context

Fork of `thicla01/pi-weather-station`. Running on a **Surface Pro with Ubuntu +
linux-surface kernel** (not a Raspberry Pi — ignore Pi-specific perf advice in
the original README). Location is in the **US** (CONUS), which matters: several
upstream/fork features assume Canadian data sources.

## Goal

Strip this down to a **high-quality radar viewer**. Forecasting is handled
elsewhere (separate epaper weather display) and is not needed here.

Two radar layers:
1. **Composite mosaic** at low zoom — wide-area situational awareness
2. **Single-site high-res** at high zoom — detail near home

Motivating complaint: RainViewer data sometimes appeared ~15 min stale and
imprecise. Note that some latency is inherent to NEXRAD (4–6 min volume scan +
mosaicking), so the fix is partly *better source* and partly *displaying frame
age* so staleness is visible rather than suspected.

## Decisions already made

- **Drop tomorrow.io entirely** (forecast, current conditions, nowcast).
- **Drop RainViewer.** Done in two steps: everything depending on it went in
  the teardown, and the tile layer itself (plus the ECCC WMS layer and the
  whole `radarSource` setting) was removed on 2026-08-11. NEXRAD is now the
  only source — there is no radar-source picker.
- **Drop the Claude AI summary + radar-analysis sampler.** Not wanted.
- **Drop the direction-arrow motion overlay** and RADAR-tier alert confidence
  logic (they depended on RainViewer frame sampling).
- **Keep NWS alerts polling** — already built, free, keyless, and polygon
  overlays are more useful on a radar map than on a forecast panel.
- ~~Homebridge indoor sensor integration: unaffected, leave as-is.~~
  **Superseded 2026-08-11: indoor data dropped too** (user request during the
  teardown). `indoorTempCtrl` + `IndoorBlock` removed.

### Decided during the teardown (not in the original plan)

- **Drop all air quality** — `airQualityCtrl` + its 5 sources (3 of which were
  Canada-only) and the AirCard / AirAlertCard UI.
- **Drop pollen** — CAMS is Europe-only and returns null for every US coord.
- **Drop the Open-Meteo PoC** — it existed only to compare against
  Tomorrow.io, which is gone.
- **Keep sunrise/sunset** — auto dark-mode switches the kiosk palette on it.
  (`useTimeOfDay` does *not* depend on it; the auto-toggle does.)
- **Drop the Sense HAT subsystem** — a Sense HAT is a Pi GPIO board and cannot
  attach to a Surface Pro, and its weather mode read `/api/weather/current` +
  `getRiskLevels`, both deleted here, so it was already non-functional.
  `kioskLocationCtrl` went with it (its only consumer).
- **UI scope: bare radar viewer** — forecast panels deleted rather than
  re-pointed at another source.

## Target architecture

### Layer 1 — mosaic (low zoom)

Iowa Environmental Mesonet XYZ tiles (drop-in for existing `L.tileLayer`):

```
https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png
```

Animation via fixed 5-minute offsets in the layer segment: `900913-m05m`,
`-m10m` … `-m50m`, with plain `900913` = current. No frame discovery needed —
generated on a schedule.

Zoom band as built: mosaic alone at **z ≤ 7**, blended at **z = 8**, gone by
**z ≥ 9**. See the crossfade note under Layer 2.

### Layer 2 — single-site super-res (high zoom)

N0B = super-res base reflectivity, 0.5° × 0.25 km — the same product RadarScope
shows by default. Native radial data, not a smoothed mosaic.

```
https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::XXX-N0B-0/{z}/{x}/{y}.png
```

- `XXX` = nearest radar 3-letter site ID. **Derive it automatically** from the
  `radarStation` field in `https://api.weather.gov/points/{lat},{lon}` rather
  than hardcoding.
- Trailing `-0` = latest; substitute `YYYYMMDDHHMM` (UTC) for a specific frame.
  **Always use a real timestamp**, never `-0`: the sentinel renders fine but
  gives no way to display frame age, which is half the point of this work.
- Crossfade band as built: single-site appears at **z ≥ 8**, alone from
  **z ≥ 9**. The band **must be at least two zoom levels wide**. Leaflet's
  default `zoomSnap` is 1, so the map only sits on integer zooms — a one-level
  band (mosaic `< 8`, site `> 7`) is satisfied by *no* integer zoom and
  silently degrades into the hard cutover it was meant to avoid. Locked by a
  test in `test/iemRadarLayers.test.js`.
- Coverage is 230 km from the site and fades at the edges — fine for a fixed
  kiosk, which is the use case.

### Frame timestamp discovery — SOLVED (verified 2026-08-11)

Single-site frames are **not** on a predictable grid — volume scans complete
every 4–6 min depending on the VCP in use, which changes with weather (3–4 min
gaps measured live during active weather). Cannot compute client-side. A
fabricated timestamp returns **503, not a blank tile**, so guessing is not an
option.

The folder-scraping approach guessed at above turned out to be unnecessary.
IEM exposes a proper JSON API — all three operations verified live:

```
/json/radar.py?operation=available&lat=&lon=   → radars near a point, with type
/json/radar.py?operation=products&radar=DIX    → products available at a site
/json/radar.py?operation=list&radar=&product=&start=&end=
    → {"scans":[{"ts":"2026-08-11T21:51Z"}, …]}
```

- `operation=list` is the frame poller. `2026-08-11T21:51Z` → `202608112151`
  for the tile segment (strip separators; do NOT reformat via a local-time
  `Date`).
- `operation=products` confirms **N0B is present** ("Base Reflectivity (Super
  Res)"), alongside N0S.
- `operation=available` returns NEXRAD / TWDR / COMPOSITE entries — filter to
  `type === "NEXRAD"`; it is the fallback when NWS is unreachable.
- `api.weather.gov/points/` returns a **4-character** id (`KDIX`); IEM wants 3
  (`DIX`). Strip the leading region letter — correct for `PAHG`→`AHG`,
  `TJUA`→`JUA` too.

Implemented in `server/iemRadarCtrl.js` → `/api/radar/site`, `/api/radar/frames`
(see `docs/api.md`).

### Server proxy

Two JSON routes plus the frame-list poller. **Tiles are not proxied** — they are
keyless and public, fetched direct by Leaflet exactly as the RainViewer and ECCC
layers already were. (CORS on IEM and NWS is `*`, so the browser could call the
JSON directly too; it goes through the server anyway for the shared 45 s cache,
rate limiting, and health-panel integration.)

## Tile rendering note — MEASURED (2026-08-11)

The old `tileSize: 512` / `zoomOffset: -1` / `maxNativeZoom: 8` config was tuned
for RainViewer (came from elewin PR #76/#77). Re-tuned rather than carried over,
against actual measurements:

- IEM's `tile.py` is an **on-demand renderer, not a fixed pyramid**. It returns
  **256 × 256** at every zoom tested (6 → 15), rendering to whatever zoom is
  asked for. So `tileSize: 512` / `zoomOffset: -1` must be **absent** — carrying
  them over puts every tile at the wrong scale and offset.
- There is **no hard zoom cliff**. A deep request returns a real (oversampled)
  render, not a 404. (A 334-byte PNG means "no echo in this tile", *not* a
  ceiling — checking only one tile is misleading, since a neighbouring tile at
  the same zoom returns full data.)
- `maxNativeZoom` is therefore a **data-resolution choice**, not a server limit:
  mosaic 8 (N0Q is a ~1 km grid ≈ 469 m/px at z8, already ~2× oversampled),
  single-site 12 (N0B 0.25 km gates ≈ 29 m/px at z12).

## Frame age display

Built as a chip on the map (`RadarFrameAge`). Thresholds encode NEXRAD's
irreducible latency floor — a volume scan needs 4–6 min to complete before any
product exists, so fresh data must not be flagged:

- **fresh** < 6 min · **aging** 6–12 min · **stale** ≥ 12 min
- The minute count is always spelled out, so the state never depends on colour
  alone (matters for the nightRed palette, where hue distinctions collapse).
- A failing frame-list refresh is flagged rather than left frozen — the last
  good frames stay on screen marked stale.

## Deferred / stretch

### Storm tracks — DONE (2026-08-12), findings recorded below

NEXRAD Level III **STI, product 58 ("Storm Track")**. Built as
`server/stormTracksCtrl.js` → `GET /api/storm-tracks?site=DIX`, rendered by
`WeatherMap/StormTracks.js`, toggled from the dock (hurricane glyph, per-device
pref `showStormTracks`, off by default).

What the build established — keep these if the feature is ever touched:

- The parser DOES support STI (code 58 / `NST`); verified against a live DIX
  file, not just the README.
- **The MOVEMENT column is the direction the storm comes FROM**, not its
  heading (meteorological convention). Verified live: every cell's forecast
  positions walk along MOVEMENT − 180° (deltas 0.6–3.9° across 4 cells). A
  naive arrow from that field points every track backwards. The track polyline
  is therefore built ONLY from the forecast positions; MOVEMENT survives only
  as label text (`movementFromDeg`, named for what it is).
- Freshly detected cells report `NEW` / `NO DATA` — no motion, no forecasts.
  Rendered as a hollow dot, no arrow: SCIT genuinely doesn't know yet.
- The cell table arrives as the product's fixed-width TABULAR text page.
  Parsing normalises `308/ 22` → `308/22` and `NO DATA` → `NODATA`, then
  splits on whitespace — column offsets are never trusted.
- The bucket is listed over plain HTTPS (`?list-type=2&prefix=`), no AWS SDK.
  Keys sort lexicographically = chronologically for this naming.
- Known SCIT noise (drops cells, swaps IDs between adjacent cells, struggles
  with squall lines) is upstream behaviour. RadarScope shows the same product.

### Raw radial rendering — FILED 2026-08-12 (the real RadarScope-parity fix)

**Motivating observation (user, 2026-08-12): high-zoom radar looks softer than
RadarScope even though we request N0B.** Investigated the same night;
measurements below are from live tiles over an active storm.

The gap is NOT the product — `ridge::DIX-N0B` is genuinely super-res, and N0B
is the sharpest thing IEM serves (per-site products for DIX: N0B, N0S only).
The gap is that **IEM pre-renders tiles server-side**, re-projecting radial
data onto a smoothed web-mercator raster. Measured over an echo: a z12 tile
carried only 10 distinct colours, z13 just 5 — interpolated, not blocky, so
`maxNativeZoom` tuning cannot recover it. RadarScope renders the raw radial
data client-side (each gate its own polar quad), which is why it looks sharp.

**The fix does not need Level II.** The `unidata-nexrad-level3` bucket — the
same one storm tracks already poll — carries the raw radial product as
`SSS_N0B_*` files (~160 KB each, one per volume scan, same cadence as IEM's
tiles). The already-installed `nexrad-level-3-data` decodes them with a small
shim, verified against a live file on 2026-08-12:

- The library has no product-153 definition and its whitelist rejects `N0B`,
  BUT product 153 (Super Res Digital Base Reflectivity) shares product 94's
  descriptor layout. Cloning the 94 definition and re-badging it
  (`code: 153, abbreviation: ['N0B','N1B','N2B','N3B']`) decodes cleanly:
  **720 radials × 0.5°, 1840 bins × ~250 m (`rangeScale: 0.999`), real dBZ
  scaling (`min −32, increment 0.5, 254 levels`), elevation 0.5°, max 54 dBZ**
  — matching the live storm. Upstreaming the shim to `netbymatt/
  nexrad-level-3-data` would be a small PR.
- Remaining work is the renderer: polar→screen on a `<canvas>` in a Leaflet
  overlay pane, a dBZ colour ramp, redraw on move/zoom. No chunk-assembly
  state, no S/I/E suffixes, no partial-sweep tolerance — all of that is
  Level II baggage this path avoids. Noticeably smaller than the "whole
  project" the Level II section below estimates.
- Physics caveat for expectations: super-res is 250 m in RANGE but 0.5° in
  AZIMUTH, so at 113 km a gate is ~250 m × ~990 m. RadarScope obeys the same
  physics; parity is the target, not magic.
- Frame discovery is already solved — the controller's hour-prefix listing
  works unchanged for `N0B` keys.
- Keep the IEM tile layers as the low-zoom mosaic and as fallback; the raw
  renderer replaces the single-site layer at high zoom only.
- If pursued, confirm Chromium GPU accel is actually on (`chrome://gpu`).

### Level II (superseded for resolution; only for latency/tilts/dual-pol)

The raw Level III path above delivers the resolution fix. Level II adds only:
lower latency via `unidata-nexrad-level2-chunks` (partial sweeps as the radar
turns; S/I/E chunk suffixes, unpopulated fields in partial chunks), all tilts,
and dual-pol moments. Assembled volumes: `unidata-nexrad-level2` (**renamed
from `noaa-nexrad-level2`**, old bucket deprecated Sept 1 2025 — pre-2025
tutorials have the wrong name). Node decoder: `netbymatt/nexrad-level-2-data`
(+ `nexrad-level-2-plot`). Only worth it if latency still annoys after the raw
Level III renderer ships.

### Lightning — FEASIBLE IN PURE JS (verified 2026-08-12); GLM recommended

The old note below said GLM "likely needs a Python sidecar = second
runtime". **That is stale — verified against a live file:** GLM L2 LCFA
files are HDF5, and `h5wasm` (WebAssembly HDF5) decodes them in Node with
no sidecar. Test run on `noaa-goes19` file created seconds earlier:
`flash_lat` / `flash_lon` come out as plain Float32Array (not even
packed — no scale/offset), plus `flash_energy`, `flash_quality_flag`
(0 = good; 364/381 in the sample) and `product_time`. Flash positions
cross-checked against that night's SVR-warned storms: 25 flashes in the
warned South Carolina cell, 22 over Kentucky, 17 in the North Dakota
line — one 20-second file.

- Bucket: `noaa-goes19` (GOES-19 = GOES-East since April 2025 — older
  tutorials point at `noaa-goes16`). Keys:
  `GLM-L2-LCFA/YYYY/DDD/HH/OR_GLM-L2-LCFA_G19_s…nc`, DDD = day-of-year.
  One ~320 KB file per 20 s (~103/hour), listable with the same
  hour-prefixed `?list-type=2` pattern the L3 controllers use. Keyless.
- Shape of the feature: server polls ~1/min, fetches the ~3 new files,
  keeps a rolling 10-15 min window of flash points, serves them like
  storm tracks; client renders age-faded markers + a count chip, dock
  toggle (bolt icon), off by default. In-cloud detection means storms
  show electrification minutes before the first CG strike — better for
  "is that incoming storm electrified" than a CG-only network.
- GLM pixel ~8-14 km — fine for the purpose; not a strike locator.
- Blitzortung was considered and rejected: more precise CG locations and
  lower latency, but unofficial/undocumented and can break without
  notice — it would be the only fragile dependency in an otherwise
  all-official, keyless build, protecting a precision the display does
  not need.

## Suggested sequence

1. **Two tile layers + frame age display — DONE** (2026-08-11). Added as radar
   source `"iem"`, now the default; RainViewer and ECCC still selectable. Full
   suite passes (618/620 — the 2 failures are pre-existing Windows POSIX-mode
   tests, they pass on Linux), client builds clean.
1b. **Rip out tomorrow.io / RainViewer / AI summary — DONE** (2026-08-11).
   ~12,000 lines removed across ~90 files. Also removed, beyond the original
   plan: air quality (all 5 sources), pollen (Europe-only), the Open-Meteo
   PoC, indoor temperature / Homebridge, and the Sense HAT subsystem (Pi GPIO
   hardware that cannot attach to a Surface Pro, whose weather mode depended
   on two controllers this pass deleted).

   The client is now a radar viewer: full-bleed map, NWS alert stack, and a
   RadarHeader carrying place name + clock. 22 ambient components deleted;
   the deletion set was computed by walking the import graph from
   `client/src/index.js`, not by hand.

   Surviving API surface — verified live in the running app, every request
   200, no orphaned polling:
     /settings · /api/is-local · /api/brightness · /api/display-scale
     /api/update-check · /api/health · /api/radar/{site,frames}
     /api/weather-alerts · /api/nearby-alerts · /api/sunrise-sunset
     /api/tiles/... · /api/reverse-geocode

   Only two API keys remain relevant: **Mapbox** (basemap, required) and
   **LocationIQ** (place name, optional). Tomorrow.io / Anthropic / AirNow /
   OpenAQ keys are no longer read.

1c. **Remove the radar-source picker — DONE** (2026-08-11). RainViewer and
   ECCC tile layers, the `radarSource` pref and its localStorage key, the
   RainViewer frame poller / playhead / animation loop, and the legend's
   stale "analysis radii" section (those rings went with the sampler).

   Fixed a latent bug found on the way: the "missing API key" prompt that
   force-opens Settings was keyed on `weatherApiKey`, which nothing sets any
   more — so a fresh install would have nagged forever. It now keys on
   `mapApiKey`, the only genuinely required key.
2. **STI storm tracks — DONE** (2026-08-12). `/api/storm-tracks` +
   `StormTracks` overlay + dock toggle. See the storm-tracks section for the
   MOVEMENT-is-a-FROM-direction trap and the other findings.
3. **Raw Level III radial renderer — DONE** (2026-08-12).
   `server/radarRadialCtrl.js` (product-153 shim + `/api/radar/radial`) +
   `radialRender.js` (inverse-mapped mercator canvas, 2560 px over a 300 km
   disc ≈ 234 m/px vs the 250 m gate) + `useRadarRadial.js` (renders only
   when the volume-scan key changes; object URLs revoked on replace).
   Replaces the IEM site tiles whenever a fresh radial frame exists AND the
   playhead is on "latest"; scrubbing history falls back to timestamped
   tiles. Own pane at z-index 250 (above tiles, below alert/track vectors).
   Measured in the running app: 116 distinct colours vs 10 in the IEM tile
   over comparable echo. A committed fixture (test/fixtures/DIX_N0B_*) keeps
   the decode path testable offline; the scaling contract (dBZ = min +
   level × inc) is asserted against the parser's own table.
4. Lightning — feasibility verified 2026-08-12 (pure JS via h5wasm, no
   sidecar); see the Lightning section. Ready to build when wanted.
5. Level II, only if latency/tilts/dual-pol still warrant it after (3)

## Environment notes

- The repo is now a **git repository** (`git init` 2026-08-11). It was not one
  before; the first commit is the untouched upstream state.
- On the **Windows** editing box: `npm test`'s glob (`'test/**/*.test.js'`) does
  not expand under PowerShell and silently runs **zero** tests. Pass the files
  explicitly there. Two `settingsCtrl` tests also fail on Windows because NTFS
  has no POSIX `0600` — both pass on the Ubuntu target.
