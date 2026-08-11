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
- **Drop RainViewer.**
- **Drop the Claude AI summary + radar-analysis sampler.** Not wanted.
- **Drop the direction-arrow motion overlay** and RADAR-tier alert confidence
  logic (they depended on RainViewer frame sampling).
- **Keep NWS alerts polling** — already built, free, keyless, and polygon
  overlays are more useful on a radar map than on a forecast panel.
- Homebridge indoor sensor integration: unaffected, leave as-is.

## Target architecture

### Layer 1 — mosaic (low zoom)

Iowa Environmental Mesonet XYZ tiles (drop-in for existing `L.tileLayer`):

```
https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png
```

Animation via fixed 5-minute offsets in the layer segment: `900913-m05m`,
`-m10m` … `-m50m`, with plain `900913` = current. No frame discovery needed —
generated on a schedule.

Set roughly `maxZoom: 7`.

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
- Set roughly `minZoom: 8`. Tune the boundary; consider keeping both layers
  mounted across a zoom or two and crossfading opacity, since a hard cutover
  looks abrupt.
- Coverage is 230 km from the site and fades at the edges — fine for a fixed
  kiosk, which is the use case.

### Frame timestamp discovery (the one real problem)

Single-site frames are **not** on a predictable grid — volume scans complete
every 4–6 min depending on the VCP in use, which changes with weather. Cannot
compute client-side.

IEM RIDGE exposes browser-navigable per-site folders of recent imagery, each
image with a world file and a JSON metadata file. Poll that listing, take the
last N timestamps, build `ridge::XXX-N0B-<timestamp>` URLs.

**Verify the exact folder path against IEM's RIDGE docs before writing the
fetcher** — this was not confirmed. Everything else above is a URL swap.

### Server proxy

Shrinks to ~two passthrough routes plus the frame-list poller.

## Tile rendering note

The existing `tileSize: 512` / `zoomOffset: -1` / `maxNativeZoom: 8` config was
tuned for RainViewer (came from elewin PR #76/#77). IEM's native zoom ceiling
differs — **re-tune these**, don't carry them over blindly.

## Deferred / stretch

### Storm tracks (do this second — small effort, decent payoff)

NEXRAD Level III **STI, product 58 ("Storm Track")**. NWS already runs the cell
detection; you get position, direction, speed, and forecast positions ~1 hr out.

- Bucket: `s3://unidata-nexrad-level3/`, naming `SSS_PPP_YYYY_MM_DD_HH_MM_SS`
- Node parser: `netbymatt/nexrad-level-3-data` — **check its supported-products
  list first**, author only implemented parsers he personally needed.
- If STI isn't supported: the format is vector + text symbology blocks (not a
  raster grid), so it yields lat/lon points + bearing/speed per cell. Rendering
  = Leaflet polyline + arrowhead.
- Caveat: SCIT is noisy — drops cells, swaps IDs between adjacent cells,
  struggles with squall lines. RadarScope shows the same product, so expect
  parity, not improvement.

### Level II (only if latency still annoys after shipping the above)

Real RadarScope-equivalent path. Viable on this hardware (x86 + iGPU), unlike a Pi.

- `unidata-nexrad-level2-chunks` — real-time, fed by Unidata LDM with minimal
  latency; render partial sweeps as the radar turns. Chunk filenames carry
  S/I/E suffix (Start/Intermediate/End of volume). Partial chunks leave some
  object fields unpopulated — renderer must tolerate that.
- `unidata-nexrad-level2` — assembled volumes. **Renamed from
  `noaa-nexrad-level2`**, old bucket deprecated Sept 1 2025; pre-2025 tutorials
  have the wrong bucket name.
- Node decoder: `netbymatt/nexrad-level-2-data` (+ `nexrad-level-2-plot`).
- Cost: polar→screen canvas renderer, color ramp, chunk-assembly state. That's
  a whole project, not an afternoon. Gain over N0B is modest (same resolution;
  N0B is already native radial) — mainly lower latency, all tilts, dual-pol.
- If pursued, confirm Chromium GPU accel is actually on (`chrome://gpu`).

### Lightning (do last — forces an architectural change)

No good free option.

- **GOES GLM** — free on NOAA GOES buckets on AWS, ~20 s granularity, catches
  in-cloud flashes. Downsides: netCDF decoding (awkward in Node, likely needs a
  Python sidecar = second runtime), and it's flash-extent data, not tidy point
  strikes. GOES-19 replaced GOES-16 as GOES-East in 2025 — older tutorials point
  at the wrong bucket.
- **Blitzortung.org** — volunteer TOA network, real-time feed, decent CG
  accuracy. Non-commercial only; feed is unofficial/undocumented and can break
  without notice. Acceptable for a personal display.

## Suggested sequence

1. Two tile layers + frame age display + rip out tomorrow.io/RainViewer/AI summary
2. STI storm tracks
3. Lightning
4. Level II, only if warranted
