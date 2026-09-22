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

**Site choice is nearest-radar, not NWS's assignment (changed 2026-09-14).**
`resolveRadarSite` used NWS `points` `radarStation` as primary; that is the
forecast office's grid assignment, and its boundary runs through east
Baltimore (probed: Towson → KLWX, Essex 10 km east → KDOX, with the two
radars within 4 km of each other in range), so a seeded location that
wandered across it flipped radars for no visible reason. Now IEM's
`operation=available` list ranked by distance is primary and NWS is the
fallback. A manual override lives in `settings.json` `radarSite`
(Settings → "Radar site"; `LWX`/`KLWX` → stored `LWX`, blank = auto),
applied server-side in `/api/radar/frames` and `/api/radar/site` — it
beats coordinates AND an explicit `site` query. The client only keeps a
copy to refetch frames the moment it changes.

**Sticky home radar + site picker (2026-09-14).** The nearest-radar fix
above was not enough on the kiosk: "site follows the view" resolves from
the map VIEW centre, and a Pikesville kiosk with its view centre over the
Chesapeake Bay got KDOX — genuinely the nearest radar to that point, 120 km
from the pin with KLWX at 74 km. `homeSiteCoversView(pin, view)` in
`WeatherMap/radarSites.js` now keeps the pin as the query point while the
view centre is within `SITE_STICKY_KM` (200 km) of the radar nearest the
pin; only beyond that does the view centre take over. The radar nearest
the pin is computed CLIENT-SIDE from `nexradSites.json` — NWS
`/radar/stations` filtered to WSR-88D, minus the four overseas DoD sites
(Guam, Korea, Okinawa) that IEM and the Level III bucket do not carry —
so the app needs no server for it. Regenerate the list with:
`curl -s -H "User-Agent: sweep" https://api.weather.gov/radar/stations`
→ keep `stationType === "WSR-88D"` and `-178 < lon < -64`.

`RadarSitePicker` (dock toggle `showRadarSites`, carbon `radar-enhanced`
glyph, per-device, off by default) draws a chip on every site like
RadarScope: the site the frames poller is serving is highlighted, a
pinned one adds a dot; tapping pins (`pickRadarSite` → `PATCH /setting
radarSite`), tapping the pinned site clears the pin. Chips are real
`divIcon` Markers with `bubblingMouseEvents: false` so a tap never
reaches the map-click handler that moves the location pin; remote (non-
local) clients see the chips but taps are inert. The override also rides
along as the `site` QUERY on `/api/radar/frames`, not only through the
server's settings.json read — the Android app runs the controller
in-process with no file to read, so the query is how the pin reaches it
there.

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

## Dual-pol clean — third noise-filter state (2026-09-06)

Motivating report: a full-disc green/blue bloom over Baltimore at 21:28
local **with the 15 dBZ filter already on**. The filter was working; the
echo was simply above its floor.

Measured on the exact scan the kiosk was drawing
(`LWX_N0B_2026_09_06_01_29_38`):

- 447 921 gates had echo; the filter was already dropping 180 664 of them
  (40%) for being under 15 dBZ.
- Of what it drew, **93% was 15-25 dBZ** and only 0.17% of the disc
  exceeded 30 dBZ. There was essentially no precipitation on screen.
- Coverage above 15 dBZ ran **90%+ from 20-70 km and fell to 2.9% by
  140 km** — the 0.5° beam climbing out of the boundary layer. Rain does
  not stop at a range ring; a biological bloom does.
- The NWS's own dual-pol classifier (`N0H`, product 165, same bucket, same
  volume scan) called **68.2% of the drawn gates Biological** and 1.9%
  light rain.

**A dBZ threshold cannot fix this** — insects and drizzle overlap at
15-25 dBZ. Raising the floor to 25 would have removed 93% of the speckle
and light rain with it. Hence a third state rather than a bigger number.

### What was built

`radarNoiseMode` (was the boolean `radarNoiseFilter`) cycles
**off → dbz → clean**; `client/src/ui/radarNoise.js` owns the vocabulary.
The old key migrates: a stored `"false"` stays off, anything else lands on
`"dbz"`, so an upgrade changes nothing until the button is pressed.

- **The mask runs SERVER-SIDE**, in `cleanRadial` before `packRadials`.
  Sending the classification to the client would have added ~1.15 MB of
  base64 per frame on top of N0B's 1.7 MB; zeroing the levels instead
  leaves the payload byte-for-byte the same size and the renderer
  untouched. `?clean=1`, reported back in a `clean` block.
- **Pairing is by volume scan, to the second.** `keyForStamp` was
  generalised to `keyForEpoch` for this: every product of one scan is
  written with the same second (`LWX_N0B_…_01_29_38` /
  `LWX_N0H_…_01_29_38`), and pairing a fresh reflectivity frame with a
  stale classification would stencil the wrong shape.
- **`N0H` needs NO shim** — unlike 153/154, `nexrad-level-3-data` ships a
  definition for 165, so the shim loop's `if (!products[code])` guard must
  keep skipping it. It does need a fixed `scaling` block: its `plot`
  descriptor carries only `maxDataValue`, so the generic read would set
  `min: undefined`. `test/dualPolClean.test.js` fails if a library upgrade
  drops the product.
- **BD ("big drops") is masked only below 30 dBZ.** BI and BD were one
  population in that scan — same median (19.5 dBZ), same p95, same range
  band — because insects and genuine big drops share a high differential
  reflectivity. Intensity separates them: only 59 of 71 803 BD gates
  (0.08%) reached 30 dBZ. Masking BD unconditionally would eat real
  convective cores.
- **The grid is checked, not assumed.** N0H is 1° × 1200 bins (300 km)
  against N0B's 0.5° × 1840 (460 km); `packRadials` re-buckets both to the
  same 720 × 0.5° slots (verified: 720/720 covered), so the mask indexes
  straight across — but `gridsAlign` refuses rather than misplacing the
  stencil if that ever stops being true, and gates past 300 km are left
  alone rather than blanked.
- **Never fatal.** No classification for a scan → reflectivity comes back
  untouched, `clean.applied: false`. The render key keys on whether the
  mask was APPLIED, not requested, so a fallback frame is not re-rendered
  pointlessly.
- **The skip path still has to publish the clean status.** An unmasked
  clean frame is pixel-identical to the dBZ-only one, so it takes the
  "same render key, skip the render" branch — and the first version left
  `cleanApplied` at its previous value, so the legend read "Dual-pol
  clean" over a picture the mask had never touched. Reported from the
  kiosk 2026-09-06. The skip branch publishes `cleanApplied` now even
  though it publishes no new image.
- **Retries are bounded.** N0H lands 30-45 s after N0B (measured
  2026-09-06: 04:43:35 / 04:44:06), so a poll can fall in the gap; the
  hook retries at 10 s, at most 5 times, which covers the gap without
  polling forever at a site whose classification is simply never
  published.
- **The last clean frame is HELD through that gap** rather than replaced
  by the unmasked new one — swapping the bloom in for 20 s is exactly what
  the mode exists to prevent, and the held frame is one volume scan old,
  not wrong. Two things keep the trade honest rather than hidden:
  - the frame-age chip reports the RADIAL's own `scanTime` whenever the
    radial is what is drawn, so a held frame ages visibly (verified: the
    row read "3 min ago" for a 05:45:21 frame while the newest scan was
    05:50) instead of claiming the newest scan's age;
  - the legend reads "holding last clean scan" for the duration.

  Bounded by `CLEAN_HOLD_MAX_MS` (10 min, two-plus volume scans): a site
  that STOPS publishing the classification mid-session would otherwise
  freeze the radar, so past that the newest picture wins and the legend
  says "unavailable". The hold can only start after one successful clean
  frame, so a site that never publishes N0H shows unmasked with
  "unavailable" from the start rather than holding nothing.
- **History scrubbing does not hold.** Each loop frame is explicitly
  requested; a historical scan whose classification is missing renders
  unmasked, as the IEM tile behind it would have.

Result on the reported scan: **95.8% of the drawn speckle removed**, and
of the 368 gates ≥ 40 dBZ only 7 went — 5 of them ground clutter inside
12 km of the radar. Payload size unchanged.

### Class-aware floor in clean mode (2026-09-22)

User report: with clean on by default, light rain was being hidden. True,
and measurable — at 04:00 Z on 2026-09-22, three radars with drizzle:

| radar | rain-classified gates < 15 dBZ | ≥ 15 dBZ |
|---|---|---|
| LWX | 51 056 | 56 089 |
| OKX | 43 223 | 44 651 |
| DIX | 44 870 | 46 177 |

The 15 dBZ floor was removing about half of every gate the classifier
called rain. And the floor is redundant where a verdict exists: at radars
with NO rain that night (FFC, GRR, ILN, BOX) the sub-15 dBZ echo was
100 000+ biological gates each but only **49–144** rain-classified gates,
so the classifier almost never mislabels bloom as rain at low dBZ.

Fix: in clean mode the floor moved SERVER-SIDE into `applyClassMask` and
applies only to gates with no verdict (ND, RF, and everything beyond the
classification's 300 km where N0B still has 160 km of data — those used
to be "left alone", which would have become unfiltered speckle once the
client stopped flooring). Reported as `clean.floorDbz` / `clean.floored`.
The client's `floorFor(payload, noiseFilter, dualPolClean)` returns no
floor when the payload's mask carried one, keeps the plain floor for tiles
/ velocity / unmasked scans, and for precipitation type (verdicts end to
end) drops the tier floor under the clean setting. The render key now
carries the resolved floor rather than the filter flag, so switching
dbz ↔ clean re-renders the current scan.

`CLEAN_FLOOR_DBZ` (server) must equal `NOISE_FILTER_MIN_DBZ` (client);
`test/dualPolClean.test.js` pins both to 15, and pins the 51 056 figure
against the committed LWX 04:01:42 pair (`LWX_N0B_/N0H_2026_09_22_04_01_42`).

### Reflectivity palettes — RadarScope-style default (2026-09-22)

User comparison, side by side over the same drizzle: Sweep painted 5–20 dBZ
in vivid cyan and blue, RadarScope in a receding white-grey wash. Same
echo, different palette — Sweep used the NWS / IEM "classic" ramp because
that is what IEM's tiles are pre-painted in, and the raw-radial layer had
been matched to the tiles so the crossfade did not change colour.

Now a per-device setting, `radarPalette` (`client/src/ui/radarPalette.js`;
Settings → Advanced → Display → "Radar palette"): **`scope`** (default —
the user's preference) or `nws`. `SCOPE_STOPS` in `radialRender.js` is an
approximation from RadarScope's published scale bar, not their table:
white → grey → slate to 15 dBZ, greens from 20, then yellow, orange, red,
dark red, magenta, purple, cyan, brown; transparent below −30.

- It reaches three places, and all three must move together: the radial
  LUT (`buildLevelLut(…, palette)`), the IEM tiles, and the legend bar.
- **The tiles are repainted, not just filtered.** `FilteredTileLayer` was
  already mapping every pixel to its dBZ through IEM's exact colour table
  for the noise floor; `recolorTable(paletteId)` turns that into a colour
  → colour map, so the tiles come out in the chosen palette pixel-exact.
  With `nws` selected the tiles pass through untouched (they ARE that
  palette). The layer is mounted whenever either the floor or a non-NWS
  palette needs a pixel changed (`tileFiltered`); `minDbz: -Infinity`
  means "recolour only".
- The legend bar now SAMPLES the active palette every 5 dBZ from 0 to 75
  instead of drawing one span per stop, so its "0 · 20 · 40 · 60 · 75"
  labels stay aligned for a table that starts at −30.
- Velocity and precipitation-type ramps are untouched; `buildLevelLut`
  ignores the palette for them (pinned by test).
- The render keys in both radial hooks carry the palette, so switching it
  re-renders the current scan and resets the loop cache.

### Correlation coefficient + debris marker, velocity palette (2026-09-22)

User shared a RadarScope CC screenshot as the reference, so CC became a
viewable fourth PRODUCT (`radarProduct: "N0C"`, dock glyph carbon
`chart-scatter`), not only a marker.

- **Product 161 decodes through the 94-layout shim but its scaling does
  NOT come from the 94 `plot` fields** — they read `min 1730.2 / increment
  0 / levels −15758`. The dual-pol products (159 ZDR, 161 CC, 163 KDP)
  carry a float scale at halfwords 31–32 and offset at 33–34; `value =
  (level − offset) / scale`. Live LWX: 300 / −60.5 → level 238 = 0.995.
  `dualPolScaling(buf, code)` finds the message start (the object begins
  with a 30-byte WMO header, `SDUS81 KLWX …`) by the product-code
  halfword and reads the floats from byte 60 / 64 of the message. Pinned
  by the committed `LWX_N0C_2026_09_22_06_31_39.bin`.
- Level 1 is range folded for CC too (leading flags = 2 live) and is
  painted purple like velocity's. No clear-air floor: unitless.
- **Debris signature** (`debrisSignature` / `attachDebris` in
  `radarRadialCtrl.js`, called from `fetchTracks`): gates within 3 km of an
  NMD circulation with dBZ ≥ 30 AND CC < 0.8, from N0B + N0C of the SAME
  scan; detected at ≥ 10 gates. Gated on NMD circulations on purpose —
  13.8 % of LWX's echo gates were below 0.8 CC on an ordinary drizzly night
  (bloom + melting layer), so a whole-disc search would be all false
  positives. Rendered as a red-filled TVS glyph, tooltip "TDS · debris ·
  CC 0.6". **Not verified on a real tornado** — synthetic test only;
  watch the first outbreak.
- **Velocity follows the palette setting** now: `VEL_STOPS_SCOPE` brightens
  both sides toward near-white extremes (RadarScope) vs the NWS ramp's
  cyan / yellow extremes. Same toward-green / away-red / grey-zero in both;
  RF purple in both.

### The committed bundle can be a build of older source (2026-09-06)

Shipped this way and cost a debugging round. The dual-pol commit ran
`npm run prod`, then edited `useRadarRadial.js` again, then committed —
so `client/dist/bundle.min.js` was a build of the code BEFORE the retry
was added. Every kiosk served that. The symptom on the kiosk was the
bloom reappearing for up to a minute on each new scan with no fast
recovery, which reads exactly like "the filter is not working".

**CI cannot catch this.** The dist job compares the FILE SET only, on
purpose (the bundle is built on macOS, terser mangles differently on
Linux, so bytes always differ). A stale bundle has an identical file set
and passes. Two content-based guards were tried and both rejected: a
string-literal comparison over minified output either pairs quotes across
unrelated statements — "finding" slabs of the bundle that differ
harmlessly between platforms, the exact false positive the file-set rule
avoids — or, once filtered down to safely textual matches, misses the
change entirely on quote parity. Closing it properly means building dist
in CI instead of committing a hand-built one, which is a workflow
decision, not a check.

Until then: **rebuild dist LAST**, after the final source edit, and check
`grep -c <a-new-string-literal> client/dist/bundle.min.js` before
committing.

### The app gets this for free — but two places could have dropped it

`client/src/standalone/` runs the same controllers in the WebView, so the
mask, the hold and the legend all come along with the client. Two places
could have silently lost it and did not:

- **Product 165 is in the app's static Level III product list**
  (`standalone/shims/nexradProducts.js`). The library builds its product
  table by reading its own directory, which a bundle cannot do, so the app
  replaces it with an explicit list. N0H decodes in the app because 165 is
  on that list, and `test/standaloneProducts.test.js` fails if the list
  and the installed package drift apart.
- **`clean` is compared as the STRING "1"** (`wantsClean`). A query
  parameter is a string under Express, and `standalone/install.js`
  stringifies axios `params` before handing them to the same handler, so
  both surfaces take one path through one controller. `=== 1` would have
  worked on neither; `test/dualPolClean.test.js` pins it.

### Limits worth knowing

- **Tiles keep the dBZ floor only.** A pre-rendered IEM PNG carries no
  per-gate classification, so "clean" degrades to `FilteredTileLayer` for
  the mosaic and for history frames whose radial has not rendered. The
  legend says which is in force; the dock button reports the setting.
- Reflectivity only — the classification is derived from the reflectivity
  field, so masking velocity by it would be a different claim.
- The dock glyph carries the state (funnel unpressed / funnel pressed /
  broom), because two of the three states are "filtering" and pressed
  styling alone cannot say which.

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

### The kiosk browser is FIREFOX (2026-09-03)

Not Chromium — the `chrome://gpu` advice elsewhere in this file does not
apply; the equivalent is `about:support` → Graphics → "Compositing:
WebRender" (hardware) vs "WebRender (Software)". Firefox pays heavily for
`backdrop-filter: blur()` over moving content, and the UI had twelve such
overlays on the map; `html[data-browser="firefox"]` (stamped in
`client/src/index.js`) disables them all in `styles/main.css`. Firefox also
lacks `Uint8Array.fromBase64` (the radial decoder falls back to an `atob`
loop, ~10–20 ms per 1.7 MB payload — fine).

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

### Phone layout (2026-09-03)

`LayoutMobile` (< 800 px) is now a full-bleed map with overlays, not a
scroll column. Things that matter if it is touched again:

- The frame-age chip and the alert slot are positioned off two CSS
  variables set on `.layout`: `--c-mobile-top` (safe-area-aware top
  inset) and `--c-edge-gap` (12 px on phones, 16 px elsewhere). The alert
  slot's `top` assumes the header strip is 40 px and the frame-age row
  about 28 px; change one, change the other.
- The dock's portrait rule used to `display: none` every
  `data-dock-priority="secondary"` button. It no longer hides anything
  — ControlButtons wraps its groups and the health chip is absolutely
  positioned at the end of the second row, because the Map group alone
  (10 × 36 px) is wider than the dock minus the chip.
- `mobileRadarMaximized` is `true` or `null` now; the `=== false`
  branches in ControlButtons are inert and can go whenever that
  component is next reworked.
- Screenshot recipe used to verify: `SKIP_CERT_AUTOGEN=true node
  server/index.js` (HTTP on 8080) with a `settings.json` carrying a
  placeholder `mapApiKey` (tiles 500, layout renders) and Playwright at
  412 × 915 / 1280 × 800.

### Android app (2026-09-03)

`app/` is a Capacitor shell; the interesting half is `client/src/standalone/`,
which lets the client run without `server/index.js` at all. Full write-up in
`docs/android-app.md`. What matters if it is touched again:

- **The server controllers run verbatim in the WebView.** They were already
  portable — `axios` works in a browser, and the only Node built-ins in the
  whole set are two `zlib` calls plus `fs`/`path` in two best-effort caches.
  Do NOT fork them for the app: the 153/154 shim, the MOVEMENT trap, the
  8/16-bit MRMS split and the ±150 s key matching would drift where they are
  hardest to observe.
- **The seam is the axios ADAPTER, not an interceptor.** An interceptor can
  only rewrite a request, not answer it. `install.js` wraps the platform
  adapter, resolved once before the swap (resolving it after would build an
  infinite loop the first time an upstream call passed through).
- **`__STANDALONE__` must gate the IMPORT, not just the branch.** DefinePlugin
  folds `if (__STANDALONE__)` to `if (false)`, but a static import is a
  dependency either way — the kiosk build pulled in the whole controller tree
  and failed on its `fs` requires until `webpack.config.js` started aliasing
  `standalone/install.js` to `install.noop.js`. A dynamic import would instead
  emit a chunk into the committed `dist/`, which CI checks for drift.
- **Three client gates assumed a key that the app does not have**, and each
  one silently disabled a feature rather than erroring: the Mapbox key
  force-opened Settings over the map, `WeatherMap` refused to render without
  it, and the reverse-geocode effect was gated on the LocationIQ key so the
  header showed raw coordinates. All three now branch on `__STANDALONE__`.
- **`setInterval(...).unref()` is Node-only** — `requestCounter.js` and
  `govAlertSources/nws.js` called it at module scope and crashed the app on
  load. Both now use `.unref?.()`, unchanged under Node.
- **The Level III library scans its own folders** (`fs.readdirSync` +
  `require` per entry) to build its product and packet tables. Replaced by
  static equivalents via `NormalModuleReplacementPlugin` matched on the
  RESOLVED path — a `resolve.alias` entry matches only the request string and
  missed the package's own relative `./products` / `../packets` requires.
  `test/standaloneShims.test.js` fails if a library upgrade adds an entry the
  static list lacks.
- **Testing note:** Chromium in the dev sandbox has no outbound network (curl
  and Node do), so the end-to-end check serves every upstream from canned
  payloads via Playwright `ctx.route()`. That still exercises adapter →
  controller → parser → hook → UI; it does not prove live connectivity, which
  is verified on the device.
- **"Keyless" needs a LOOK, not a status code.** CARTO's basemaps return 200
  with an "API KEY REQUIRED" watermark burned into the tile; Esri's Canvas
  tiles return 200 with a "Map data not yet available" placeholder above z16
  (hence `MAP_MAX_NATIVE_ZOOM = 16`). Both pass every check that only reads
  the response status. Esri's REST tile path is also `{z}/{y}/{x}` — row
  before column — so a wrong order yields the wrong place, not an error.
- **The app owns its settings.** `/api/is-local` reports true and
  `standalone/settingsStore.js` backs `/settings` + `PATCH /setting` with
  localStorage; without it the Advanced sliders and saved places looked
  editable and lost every change. The panel hides what has no meaning without
  a server (API keys, trust-cert, Mapbox styles, sleep, diagnostics) behind
  `__STANDALONE__` rather than disabling it.
- **Follow-me mode** (`client/src/hooks/useFollowLocation.js`, app only) turns
  the sidebar's recentre button into a toggle. Three things it got wrong first:
  committing every `watchPosition` callback (one a second — gated on 200 m of
  travel instead, which also filters a parked phone's jitter); treating ANY
  geolocation error as fatal (the platform emits `POSITION_UNAVAILABLE`
  between fixes, so follow switched itself off mid-drive — only code 1,
  `PERMISSION_DENIED`, ends the mode now); and letting the screen sleep, which
  a wake lock now prevents while the mode is on. Release-on-drag hangs off
  Leaflet `dragstart`, which fires for user gestures only and so is not
  triggered by follow's own `setView`.
- **`enableHighAccuracy` is separate from the permission.** Granting
  `ACCESS_FINE_LOCATION` only makes a precise fix available; without the flag
  the platform may answer from the network provider and the pin sits a
  kilometre off. Set in the app build only — the kiosk is stationary and has
  no GPS.
- **Drive-simulation recipe** (this is what caught the error-handling bug):
  serve `client/dist-app` statically, launch Playwright with
  `permissions: ["geolocation"]`, tap the follow button, then call
  `ctx.setGeolocation()` in steps and assert that a new
  `api.weather.gov/points/` lookup fires per step. Note the harness emits
  `POSITION_UNAVAILABLE` between overrides — that is realistic, not noise.
- **Keep-screen-on is `keepScreenAwake`** (`hooks/useWakeLock.js`), a persisted
  per-device pref, NOT a property of follow mode — it was implicit in follow
  first, which meant neither could be had without the other. The browser drops
  a wake lock on every visibility change and does not restore it, so the hook
  re-acquires on `visibilitychange` or the setting silently stops working after
  the first trip to another app.
- **The app rail hides (`railHidden`) and expands (`AppDrawer`), opened by a
  HAMBURGER, not a swipe.** A left-edge swipe was built first and had to go:
  under gesture navigation Android owns both edges for Back, so with the rail
  hidden — the exact case the gesture existed for — it never reached the
  WebView. `setSystemGestureExclusionRects` can claim a strip back, but it is
  capped, invisible, and steals Back from the user. Do not revive the swipe.
- The drawer renders `ControlButtons labelled`, which clones each button and
  appends its own `aria-label` — one definition per control, no parallel list
  to drift. Render `<AppDrawer>` BEFORE `<BottomDock>`: `.layout > :last-child`
  carries the dock's stacking rule and would otherwise override the drawer's
  fixed positioning. The menu is `__STANDALONE__`-only, because mobile web
  keeps its always-visible bottom dock and "Hide toolbar" would be inert there.
- **The app never requests a GPS fix at launch.** It seeds `browserGeo`/
  `mapGeo` from `lastPosition` in localStorage at useState-init time (so the
  first render already has a map), and only the follow button opens a watch.
  Launch fallbacks, in order: stored position, keyless IP lookup,
  `DEFAULT_APP_POSITION` (centre of the lower 48). The placeholder that used
  to fill this gap was the kiosk's missing-Mapbox-key message, which blamed
  the user for a key the app does not use.
- **Anything the map mounts on the FIRST render must be seeded in the same
  `useState` initialiser.** Leaflet's `MapContainer` captures `zoom` once and
  nothing re-applies it, while `loadStoredData` restores it from an effect a
  render later; seeding the position synchronously moved the mount into that
  race, so `readStoredZoom()` now seeds `defaultMapZoom`/`currentMapZoom` the
  same way.
- **The user's "high-res radar took ~30 s after opening" is NOT reproduced
  and NOT explained.** The stale-initial-zoom theory above was tested and
  disproved: with the seeding reverted, a scripted launch still requests
  `ridge::` site tiles at the stored z10 within 4 s. Measured in the app
  bundle, upstreams served locally: first raw-radial blob overlay on the map
  **1.9 s** after `goto` (bucket listing → 160 KB N0B → product-153 decode →
  2560 px render), and the cold JSON chain 439 ms / 411 ms / 1 095 ms serial.
  Whatever costs 30 s on the device is not in this path at container speed —
  do not re-file it as a zoom bug without evidence from the phone.

### Local sunrise / sunset (2026-09-03)

`server/solar.js` computes it — no upstream call. Ported from the sibling
e-paper project's `platformio/src/sun.cpp`, so the two stay a readable diff
apart.

- The response shape is api.sunrise-sunset.org's, deliberately: field names
  (`sunrise`, `sunset`, `civil_twilight_begin`, `civil_twilight_end`,
  `day_length`) and the `+00:00` ISO suffix, because the client stores the
  payload as-is. A polar day/night gives `results: null`, `status:
  "NO_CROSSING"` — never a fabricated time, or auto dark-mode flips on
  nonsense.
- Accuracy checked against the **US Naval Observatory** (`aa.usno.navy.mil/
  api/rstt/oneday?date=&coords=&tz=0`, whole-minute UT), not against
  sunrise-sunset.org, which was down (HTTP 521) at the time and is the reason
  this moved in-process. Worst |delta| over 8 places x 5 dates: **2.0 min**
  below 62°N, **3.3 min** at 71°N. That split is the NOAA approximation, not
  a port bug — the sun's position is anchored at 00:00 UT and never iterated,
  so error grows as the horizon crossing slows. `test/solar.test.js` embeds
  the USNO table with tolerances just above the measured worst case.
- The Android app imports the SERVER's handler (`standalone/api.js` →
  `server/proxyCtrl.js`'s `sunriseSunset`) rather than keeping its own copy,
  now that the route needs no key and no socket. `upstream.js` lost its
  version.

### Units in Settings (2026-09-03)

Only three remain — `speedUnit` (storm speed), `lengthUnit` (hail size) and
`distanceUnit` (radius) — because those are the only measurements the radar
view renders. `tempUnit` and `pressureUnit` were forecast-era leftovers that
reached nothing; the us/uk/metric presets in `ui/systemPrefs.js` set three
values now, and `unitSystemPreset()` takes three arguments.

### Free zoom (2026-09-04)

The map runs `zoomSnap: 0`. Leaflet's default of 1 rounds to the nearest
whole level when a gesture ends, which on a touch screen reads as the map
elastically springing back unless the pinch crossed half a level — the
user's complaint.

- `zoomDelta` stays **1**, and `ZoomAnchorOffset` patches `map.zoomIn` /
  `zoomOut` to step to the next WHOLE level in the pressed direction
  (10.26 → 11 on +, → 10 on −). Without that, `zoom + 1` from a pinched
  10.26 lands on 11.26 and the buttons never see a round number again.
  That patch is now unconditional; it used to fall through to Leaflet's
  own methods when the rail offset was zero.
- Everything that reads zoom was already continuous (`layerOpacities`,
  `layerVisibility`, the storm-track label gate, `RING_HIDE_ZOOM`), so the
  crossfade is now a real ramp rather than one 50/50 step at z=8. The
  two-level band still matters: buttons, double-click and `setZoom` all
  land on whole levels.
- Persistence had to stop assuming integers: `readStoredZoom` uses
  `parseFloat` (parseInt truncated 10.6 to 10), hydration from
  `advanced.display.defaultMapZoom` no longer rounds, and the debounced
  save rounds to **2 dp** — comparing the rounded values, or the guard
  misses a value it just wrote and re-saves forever.
- Verified with CDP `Input.dispatchTouchEvent` (React ignores hand-rolled
  touch events): a 1.2x pinch, the exact case that used to spring back,
  now rests at 10.26; "+" then gives 11 and "−" gives 10.

### One-shot locate (2026-09-04)

`LocateButton` (app only) sits in `LayoutMobile`'s header row beside the
hamburger, so it is on screen with the rail hidden and the drawer closed —
the state it exists for. `AppActionsContext.locateOnce` is the action: one
`getCoordsFromBrowser()`, then `setBrowserGeo` + `setMapPosition`, so the
PIN moves and every layer keyed on it (radar site at mosaic zoom, alerts,
lightning, storm arrival) follows.

- It is NOT a replacement for follow mode and does not touch
  `followLocation`. Follow opens a `watchPosition` and is the expensive
  option for driving; this is the cheap one for the other 95 % of taps.
  Silently cancelling a mode the user turned on would be worse than a
  redundant recentre.
- Placed at the TOP of the map on purpose. The conventional bottom-right
  corner already carries the timeline, the legend strip and the basemap
  attribution, and their combined height moves with what is toggled on
  (`.with-legend .radar-timeline` alone shifts 62 px) — a floating button
  there collides eventually.
- `.headerSlot > :last-child { flex: 1 }` used to make the place/clock
  strip fill the row. The locate button is the last child now, so the strip
  is targeted through its own `.headerStrip` wrapper; restoring the
  positional selector would stretch the button to fill the row.
- Verified with a real geolocation grant in Playwright: rail hidden, one
  click moves the pin Sterling VA → Philadelphia, fires exactly ONE new
  `api.weather.gov/points/` lookup (a watch would keep firing), and updates
  the header. With the permission denied the button reads "Could not get
  your location" for 4 s and nothing moves.

### Frame-age rows describe what is DRAWN (2026-09-04)

A row per layer, but only for layers with something on the map. Storm
tracks are the case that forced this: SCIT writes a product only when it
has cells, so a quiet radar's newest file can be up to the poller's
3-hour lookback old, and the chip rendered "Tracks · 100+ min ago" over an
empty map — indistinguishable from a broken feed. Measured live on
2026-09-04: several sites returned 0 cells with 6-12 min products, two
returned nothing within 3 h at all.

- Gate is `cells.length || mesos.length` for tracks, `flashes.length` for
  lightning, **OR** that layer's `stale` flag — a failing refresh is a real
  fault and must stay visible, and the hooks keep the last good data behind
  it.
- Do not "fix" this by widening the bucket lookback. The age is honest; it
  is the pairing with an empty map that lies.

### Crossfade: the mosaic must not step aside for nothing (2026-09-04)

`layerOpacities(zoom, baseOpacity, siteDrawn)`. The two ramps are
deliberately NOT mirrored: mirroring keeps the sum constant but leaves both
layers at half strength mid-band (0.35 at the default 0.7), which is what
"the mosaic is very low opacity and hard to see" meant. Site fades in over
7→8; the mosaic holds full to 8 and fades 8→9, once something is at full
strength to replace it. Overlap is free — the site paints over the mosaic
where it has data and is transparent where it does not.

- `siteDrawn` is the other half: velocity mode mounts NO site tiles, and a
  frame whose radial has not rendered paints nothing. Passing false holds
  the mosaic at full opacity across the whole band. Computed in
  `WeatherMap/index.js` as `mountedSiteFrames.length || radialShown ||
  currentLoopRadial`, which is why `iemOpacity` is computed *after* those.
- The verbatim-copy test in `test/iemRadarLayers.test.js` guards the ramp;
  its total-ink assertion is now a FLOOR, not equality (equality is what
  encoded the dip). Verified on the live layers at 0.3 base: z7.5 mosaic
  0.30 / site 0.15, z8 both 0.30, z8.5 mosaic 0.15 / site 0.30.

### Precipitation type — rain / snow / mix / hail (2026-09-16)

Motivating ask: "identify rain and snow". Built as a third radar PRODUCT
(`radarProduct` = `N0B` | `N0G` | `PTYPE`, one localStorage key; the old
`radarVelocity` boolean migrates on first read), dock button (carbon
`mixed-rain-hail`), exclusive with velocity. Two upstreams, one vocabulary:

- **High zoom: N0H × N0B, merged SERVER-SIDE** (`fetchPrecipType` in
  `radarRadialCtrl.js`, `product=PTYPE`). The classification dual-pol clean
  already downloads carries the precipitation itself (IC, DS, WS, RA, HR,
  BD, GR, HA, LH, GH); it was being reduced to a mask and thrown away. Now
  each gate is one byte — class index (N0H code / 10) in the high nibble,
  a 5 dBZ intensity tier from the same scan's N0B in the low — so the
  payload has the SAME shape as N0B/N0G and the renderer only swaps its
  lookup table. Non-weather classes encode as 0: the picture is inherently
  clean, and `clean=1` is ignored for it.
- **Low zoom: MRMS `PrecipFlag_00.00` × `PrecipRate_00.00`**
  (`server/mrmsPrecipTypeCtrl.js` → `/api/radar/precip-mosaic`), replacing
  the N0Q mosaic while the mode is on. Both decode through the hail
  controller's GRIB2 PNG path with zero changes (flag 8-bit `X − 3`, rate
  16-bit `(X − 30)/10`). The flag histogram matched the documented table
  exactly (0, 1, 3, 6, 7, 10, 91, 96, −3); the only snow in the
  mid-September frame was four gates at 51°N 115.5°W — the high Canadian
  Rockies near Banff — which is the regression check the test uses for
  the grid geometry. MRMS has **no sleet / freezing-rain flag**; the mix
  group only ever comes from N0H (WS).
- **`server/precipType.js` is shared by BOTH ends.** Plain CommonJS, no Node
  built-ins; the kiosk client imports it straight from `server/` (webpack
  bundles CJS without babel — `include: [src]` on the babel rule is not a
  block), the app already ran server code, and the tests require it. One
  copy of the encoding, the ramps and the LUT, so no verbatim-copy drift
  to police; the copied `buildLevelLut` in `test/radarRadial.test.js` only
  gained the one delegating line.

Things established on the way:

- **Pair the newest frame from the CLASSIFICATION side.** N0H lands 30–45 s
  after N0B, so "newest N0B, then its N0H" is empty for most of a minute
  after every scan and the layer would blink (the dual-pol clean hold
  exists to paper over exactly that). The newest N0H always has its N0B
  already in the bucket, so the frame is simply "the newest scan that can
  be typed" — one scan older for those seconds, with its own honest
  `scanTime` on the age row. No hold, no retry needed. History stamps
  pair N0B → N0H like `cleanRadial` does.
- **DIX publishes no N0H at all** (`no-recent-classification`, verified
  live). The hook now exposes `unavailable` (the server's reason) and the
  legend says "No classification published by this radar" rather than
  showing an empty map with no explanation. LWX, OKX do publish.
- **Aloft vs surface is stated, not hidden.** N0H is the 0.5° beam's
  verdict (~1.5 km up at 100 km); PrecipFlag folds in model temperature
  profiles and is the surface answer. The two can disagree in a melting
  layer. The legend names which source is drawing ("Radar dual-pol · aloft
  at the 0.5° tilt" / "MRMS · at the surface").
- **Intensity is put on common 5 dBZ tiers** so the two layers shade
  alike: rate → dBZ via Marshall–Palmer (`23 + 16·log10 R`; 0.3 mm/h ≈
  15 dBZ, 1 ≈ 23, 10 ≈ 39). The 15 dBZ clear-air floor becomes "tier ≥ 4"
  in the LUT, so the noise-filter button still works in this mode. Rate
  missing or > 6 min from the flag → every cell at tier 5 and
  `rate.available: false`, never "drizzle everywhere" nor nothing.
- **Mosaic grid is 2 km, run-length encoded.** Measured on a live frame
  with widespread rain: 851 KB of base64 at 1 km, 286 KB at 2 km, 155 KB at
  3 km. A type boundary is not a texture; 2 km it is. Cold build ≈ 2.3 s
  (two CONUS decodes, ~49 MB of Uint16 each, dropped at once — `fetchGrid`
  in the hail controller is deliberately uncached); repeat ≈ 1 ms.
- **The mosaic client paints the VIEWPORT, not CONUS.** `PrecipMosaicLayer`
  keeps the decoded 6 MB field and renders view + 50 % margin at ~2× screen
  density (cap 3072 px) into an ImageOverlay, re-rendering only when the
  view leaves the margin or zoom moves ≥ 0.75. Lookup-only inner loop
  (mercator maths once per row/column) — tens of ms. A CONUS-wide canvas at
  useful resolution would have been ~46 MB decoded and mostly off screen.
- **Type mosaic is NEWEST-ONLY.** Scrubbing history at mosaic zoom hides it
  (legend: "Type mosaic shows the newest frame only") rather than draw a
  "now" frame under a "-30 min" playhead. Site-zoom history DOES work
  (`PTYPE&stamp=` through the loop hook). Adding mosaic history means a
  `stamp` lookup over the day listing plus a second loop cache — deferred.
- **Legend clean line now needs `cleanApplied !== null`.** It used to say
  "Dual-pol clean" at mosaic zoom and in velocity mode, where the mask does
  not run; the hook now reports null for any non-reflectivity payload and
  the line only appears over a raw-radial frame the mask applies to.
- Verified in Playwright against the running server (dev bundle, sandbox
  Chromium): site zoom 10 over LWX → `radial?product=PTYPE`, typed overlay
  in the radial pane, age row "LWX TYPE · 2 min ago", dock label flips to
  "Show reflectivity"; zoom 6 → `precip-mosaic`, 2560 × 1496 overlay in
  its own pane, no IEM tiles mounted, "Type mosaic · 3 min ago".
- **Not verified against real snow** — it is September. Rain, convective
  and hail classes were checked live; snow rendering is pinned by fixtures
  (LWX N0H, the Banff PrecipFlag frame) and should be eyeballed on the
  kiosk at the first winter event.

### App Mapbox token (2026-09-04)

Optional, per-device, `appMapboxToken` in localStorage — never in the APK.
A key compiled into an app is extractable, and Mapbox's URL restrictions do
not apply to a WebView's requests, so only a PUBLIC `pk.` token belongs
here; `isUsableMapboxToken` refuses `sk.` outright.

- `mapTileUrl(dark, {token, style})`, `mapAttribution(token)` and
  `mapMaxNativeZoom(token)` in `standalone/upstream.js` switch together.
  Esri is 256 px tiles with no offset and a z16 data ceiling; Mapbox's
  style endpoint serves 512 px, so the app on a token uses the kiosk's
  `tileSize: 512` / `zoomOffset: -1` — verified live, map z7 requests tile
  z6.
- **Scope: the raster tile endpoint needs `styles:tiles`**, not
  `styles:read`. `styles:read` reads style JSON (what GL JS uses); the
  `/styles/v1/{user}/{style}/tiles/{z}/{x}/{y}` path this build fetches
  checks `styles:tiles`, and answers a token without it
  `403 {"message":"This API requires a token with styles:tiles scope."}`.
  Both are on by default for a public token created in the Mapbox UI — the
  trap is advice (mine, 2026-09-04) to hand-scope one to styles:read.
- **A new token is not usable immediately.** Observed 2026-09-04 on a
  token minutes old: the same tile URL alternated 200 / 403 for a few
  minutes, then went 20/20 200 on deep uncached tiles. A 403 tile renders
  as nothing, so this presents as "the app shows no basemap" with no
  visible error — check with curl before suspecting the client.
- The Advanced style pickers are gated on a usable token rather than on
  `!__STANDALONE__`: without one they would name styles nothing fetches.
- Only built-in `mapbox/*` styles are reachable. The kiosk's proxy also
  resolves a Studio style via CUSTOM_STYLES, which needs the owning
  account — not something a shared public token carries.
