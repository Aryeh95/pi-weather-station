# Sweep (formerly pi-weather-station) → radar-focused rework

> Product name changed to **Sweep** on 2026-09-03. The repository slug and
> every on-disk identifier (`pi-weather-server.service`,
> `~/.config/pi-weather-station/`, the log path) deliberately keep the old
> name so existing installs and the updater's drift check keep working.

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

## Loop length (changed 2026-08-30)

`/api/radar/frames` now defaults to 30 scans (RadarScope's loop length,
~2-2.5 h) with a 300-min lookback sized for the slowest clear-air VCP.
The timeline is driven by the site scan list at high zoom and by the
mosaic's fixed 11-frame grid at low zoom — IEM publishes no mosaic
offset older than `-m50m`, so a 2-hour track at low zoom would scrub
into nothing. `pickFromEnd` returns null past a layer's span (the layer
hides rather than freezing on its oldest frame), and the playhead clamps
when the track shortens on a zoom-band change.

**Sharp playback (added 2026-08-30):** historical loop frames render
through the raw-radial pipeline too. `/api/radar/radial?stamp=` matches
an IEM frame stamp to its bucket key (±150 s, hour-prefix listing;
verified live: IEM `0338` → `LWX_N0B_..._03_38_09`) with an immutable
30-min positive / 2-min negative cache. `useRadarRadialLoop` warms one
frame at a time (~300 ms render + 150 ms pace, full loop ≈ 15 s) and
keeps blob URLs for all frames, but the map mounts only a sliding
window of overlays around the playhead (next frame pre-mounted so it's
decoded before it shows) — all ~30 mounted would pin ~800 MB of decoded
bitmaps. Until a frame's radial is rendered, its IEM tile shows, so the
loop sharpens progressively.

## Clear-air noise filter (added 2026-08-30)

Motivating complaint: on a dry day the raw-radial layer painted the whole
230 km disc with blue/green speckle. That is clear-air mode return —
bugs, birds, dust, refraction — real echoes at low dBZ, not a decode bug.

Fix: `NOISE_FILTER_MIN_DBZ = 15` in `radialRender.js`, applied in
`buildLevelLut` (once per LUT, not per pixel). Light rain starts around
15–20 dBZ; biological return is overwhelmingly below 15. Per-device pref
`radarNoiseFilter`, **default ON** (only a stored `"false"` disables),
dock toggle (carbon `filter` funnel glyph, pressed = filtering). Toggling
re-renders the current scan immediately — the render key in
`useRadarRadial` carries the filter state alongside the volume-scan key.

~~Known limitation: the filter applies to the client-rendered radial layer
only.~~ **Closed 2026-09-03:** `FilteredTileLayer` applies the same 15 dBZ
floor to the IEM tiles. It turned out not to need palette *matching*: IEM
publishes the exact N0Q lookup table (`GIS/rasters.php?rid=2`, 255 colours,
dBZ = index/2 − 32.5, every colour unique) and a live check found 100 % of
opaque pixels in both a mosaic tile and a `ridge::` N0B tile are exact table
entries (tile.py resamples nearest-neighbour). The filter is therefore an
exact colour → dBZ lookup; unknown colours are left alone.

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
- **Mesocyclone / TVS markers added 2026-08-12** from NMD (product 141), same
  payload and toggle. Findings: the dedicated NTV product (61) **stopped being
  archived in this bucket after 2021** (probed across sites) — the TVS flag
  comes from the NMD table's per-circulation TVS column instead. The NMD
  MOTION column can be entirely empty (seen live), so the row parser finds
  the Y/N token by value, never by position from the end. Warning polygons
  are outline-only (no interior shading) as of the same date, per user
  request matching RadarScope.

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
  keeps a rolling window of flash points (built at 15 min, tightened to
  5 min by user preference 2026-08-12), serves them like
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
4. **Lightning — DONE** (2026-08-12). `server/glmLightningCtrl.js` →
   `/api/lightning?lat&lon&radiusKm` (rolling 5-min window, per-file
   cache, single-flight assembly, ~2 s cold start measured) +
   `LightningOverlay` (age-faded dots: white-hot < 2 min, amber fading to the
   5-min window edge, capped at the 800 newest) + legend count section +
   dock toggle (bolt icon, off by default). GLM fixture committed
   (test/fixtures/OR_GLM-L2-LCFA_*) so the h5wasm decode stays testable
   offline. Verified live: 1,728 flashes within 300 km of the Kentucky
   kiosk position during an active severe evening.
5. Level II, only if latency/tilts/dual-pol still warrant it after (3)

## Environment notes

- The repo is now a **git repository** (`git init` 2026-08-11). It was not one
  before; the first commit is the untouched upstream state.
- On the **Windows** editing box: `npm test`'s glob (`'test/**/*.test.js'`) does
  not expand under PowerShell and silently runs **zero** tests. Pass the files
  explicitly there. Two `settingsCtrl` tests also fail on Windows because NTFS
  has no POSIX `0600` — both pass on the Ubuntu target.

## September 2026 additions — findings to keep

### Velocity mode (N0G) — DONE (2026-09-03)

- Product **154** (Super Res Digital Base Velocity) shares product 94's
  layout exactly like 153 does; the same clone-and-rebadge shim decodes it.
  Verified live (DIX): 720 radials × 0.5°, **1200 bins × 0.25 km = 300 km**,
  plot scaling **min −63.5 / inc 0.5 / 254 levels (m/s)**, elevation 0.5°.
- **Level 1 is RANGE FOLDED** for velocity (23k gates in the verified scan),
  not "missing" — paint it (purple), never skip it. Level 0 stays transparent.
- IEM has **no velocity tile product** for the site layer (`operation=products`
  lists N0B and N0S only; N0S is storm-*relative* velocity, a different
  product). Velocity mode therefore mounts no site tiles at all; frames whose
  N0G radial has not rendered show nothing at high zoom until the loop warms.
- N0G files carry the **same volume-scan timestamps** as N0B
  (`DIX_N0B_…_02_55_41` / `DIX_N0G_…_02_55_41`), so the N0B frame list from
  IEM drives both products through `keyForStamp(site, product, stamp)`.
- The clear-air filter is a dBZ concept and is not applied to velocity.

### Mosaic timestamp — DONE (2026-09-03)

IEM publishes `data/gis/images/4326/USCOMP/n0q_0.json` with the current
composite's `valid` time (`{"meta":{"valid":"2026-09-03T02:55:00Z",…,
"radar_quorum":"142/147"}}`). `/api/radar/frames` relays it as `mosaic`
(60 s cache, never fatal) and `buildMosaicFrames(now, validEpoch)` steps the
`-mNNm` offsets back from it — exact ages, no "~". Falls back to the
5-minute boundary (approximate) when absent.

### Storm arrival — DONE (2026-09-03)

`stormArrival.estimateArrival(cell, home)`: heading from the cell's current
position to its LAST forecast position (never from MOVEMENT), speed from
`speedKt` (kt × 1.852 / 60 km/min) or the forecast span, home projected
onto that ray in local km. Null when moving away, passing > 20 km wide, or
> 180 min out (was 120 — measured live: a cell 195 km out, passing 7 km
off, 147 min away was invisible under the shorter cap). Labels are all
permanent (touch kiosk, nothing hovers): cell id beside the dot, clock
times on the forecast ticks at z ≥ 9 like RadarScope, arrival lead in red.
Tap opens a popup; the tap target is an 18 px invisible disc with
`bubblingMouseEvents: false` so the map click that moves the pin never
fires.

### Idle polling — DONE (2026-09-03)

`pollingPaused = sleepStage > 0 || document.hidden`, published on
SystemContext. Every poller takes a `paused` flag that stops the interval
but KEEPS state (the `enabled` flag still clears state). The loop hook's
generation-reset effect must NOT depend on `paused`, or a pause would
revoke every cached frame.

### Update-check finding (2026-09-03)

The kiosk's update button only renders when `updateAvailable` is true, and
the checker compared HEAD to a hard-coded `origin/master` and swallowed
fetch errors. A non-master checkout that already contains master's tip, or
a private-fork fetch with no credentials under systemd, both looked exactly
like "up to date". Now compares against `@{u}` (fallback origin/master),
logs failures, and reports `error` / `errorMessage` / `upstream`. Triage:
`curl -sk https://localhost:8443/api/update-check`.

### Hail — MRMS MESH, pure JS (2026-09-03)

- The single-radar **NHI (hail index), NSS and NTV products stopped being
  archived** in `unidata-nexrad-level3` after 2022 (probed LWX: years
  2021–2022 only). No per-cell hail from the Level III feed any more.
- **MRMS MESH** on `noaa-mrms-pds` (`CONUS/MESH_00.50/YYYYMMDD/`) is the
  official replacement: 1 km CONUS grid, one ~54–120 KB gzipped GRIB2 every
  2 min, keyless.
- **No wgrib2 needed — and it is not in Ubuntu 24.04's repos anyway.** MRMS
  uses GRIB2 **PNG packing (template 5.41)**: section 7 is a 16-bit
  grayscale PNG, decoded with Node's zlib in `server/mrmsHailCtrl.js`.
  Grid template 3.0 offsets (0-based from the section start): Ni +30,
  Nj +34, La1 +46, Lo1 +50, Di +63, Dj +67, scan mode +71 — getting Di/Dj
  wrong by one octet reads 2.56° instead of 0.01°, silently.
  `value_mm = (−30 + X) / 10`; −3 no data, −1 no coverage.
- Validated against eccodes on the same file: 5 570 points > 0, max 59.1 mm
  at 40.595 N / 90.755 W — identical. Decode ≈ 1.3 s for 24.5 M samples,
  then reduced to a sparse point list so nothing large stays resident.
- **PNG depth varies per frame.** MRMS writes 16-bit when any CONUS sample
  exceeds 255, **8-bit otherwise** (quiet frames). A 16-bit-only decoder
  rejected an 8-bit frame on 2026-09-03 14:02 Z and, because the failure
  was swallowed, every cell read "no hail" while RadarScope showed 0.5 in
  near Lansing MI. Both depths are decoded now; a decode failure is
  reported as `hail.available: false` and the popup says "unavailable".
- Cells sample the max within 10 km of TWO fields: the 2-min `MESH_00.50`
  and the 30-minute swath `MESH_Max_30min_00.50` (`hail: {meshMm, meshIn,
  max30Mm, max30In}`). The swath matters: near Lansing the instant field
  read 7–11 mm while the swath read 16–24 mm — a pulsing cell's recent
  peak. Values < 5 mm treated as none; ≥ 25 mm (NWS severe) on either
  field also shows in the always-on label. Attached inside `fetchTracks`,
  never fatal.
- **MESH is not the same algorithm as RadarScope's hail number.**
  RadarScope shows the single-radar Hail Index (MEHS, reported in 0.25-in
  steps, floor 0.5 in); MRMS MESH is a multi-radar estimate. They disagree
  by a few tenths of an inch routinely; neither is an observation.

### History loads on play, not on open (2026-09-03)

Opening the timeline no longer warms the loop or mounts every frame's tile
layer — that was ~30 radial fetches + renders and up to 41 tile layers
refetching on every pan, the biggest cost on the kiosk. `loopActive =
radarTimelineVisible && animateWeatherMap` gates both. Paused scrubbing
mounts/renders only the frame under the playhead (`scrubStamp`), fetched
on demand; pause releases every cached frame but the current one (the loop
hook already evicts stamps that leave its list).

### Site follows the view (2026-09-03)

The single-site product used to be resolved from the location PIN, so
zooming into a storm 300 km away showed nothing at high zoom. Inside the
site band (z > BAND_LOW_ZOOM) `radarQueryPoint` is now the map-view centre,
quantised to a 0.25° grid (`MapViewTracker`) so panning within one radar's
coverage never re-resolves the site (each new cell is one NWS `/points`
call, cached 24 h). At mosaic zoom the pin decides, keeping the home
radar's frames, tracks and arrival overlay warm. Storm tracks and the
radial layer key on `iemSite`, so they follow too; lightning stays on the
pin. Arrival estimates still use the pin as home.
