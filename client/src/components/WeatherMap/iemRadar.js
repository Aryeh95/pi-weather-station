// IEM NEXRAD radar — URL construction and frame models for the
// two-layer radar view.
//
// The two layers answer different questions and are addressed in
// completely different ways:
//
//   Layer 1, MOSAIC (low zoom) — "what is the weather doing regionally".
//     `nexrad-n0q-900913` is a national composite that IEM regenerates
//     on a fixed 5-minute schedule. Because the schedule is fixed, the
//     animation frames are addressed by fixed offsets in the layer name
//     (`-m05m` … `-m50m`) and need no discovery at all. Everything the
//     mosaic needs can be computed here, offline.
//
//   Layer 2, SINGLE-SITE (high zoom) — "what is happening right here".
//     `ridge::XXX-N0B-<stamp>` is super-res base reflectivity from one
//     radar: 0.5° tilt at 0.25 km gates, native radial data rather than
//     a resampled mosaic. Its timestamps are NOT on a grid — a volume
//     scan takes 4-6 min depending on which VCP the radar is running,
//     and that changes with the weather (measured live: 3-4 min gaps in
//     active weather). They must be discovered from the server's
//     `/api/radar/frames` poller; a fabricated timestamp returns 503
//     from IEM rather than a blank tile, so guessing is not an option.
//
// Both layers are fetched direct from IEM by Leaflet. The tiles are
// keyless and public, matching how the RainViewer and ECCC layers
// already worked — only the frame-list JSON goes through our server.

const IEM_TILE_BASE = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0";

export const IEM_ATTRIBUTION =
  'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a> / NOAA NEXRAD';

// ── Layer 1: composite mosaic ────────────────────────────────────────

// Fixed 5-minute offsets IEM publishes for the N0Q mosaic. Index 0 is
// the current frame (no suffix); the rest step back in 5-min
// increments. Ten offsets is 50 minutes of loop, which is comparable
// to what the single-site layer covers with ~12 volume scans.
export const MOSAIC_OFFSET_MINUTES = [50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];

/**
 * Build the mosaic layer segment for a given age in minutes.
 *
 * Current is the bare layer name; every older frame carries an `-mNNm`
 * suffix. Verified live: bare, `-m05m`, `-m10m` and `-m50m` all return
 * tiles.
 *
 * @param {Number} minutesAgo one of MOSAIC_OFFSET_MINUTES
 * @returns {String} e.g. "nexrad-n0q-900913-m15m"
 */
export function mosaicLayerName(minutesAgo) {
  if (!minutesAgo) return "nexrad-n0q-900913";
  return `nexrad-n0q-900913-m${String(minutesAgo).padStart(2, "0")}m`;
}

/**
 * Leaflet URL template for a mosaic frame.
 *
 * @param {Number} minutesAgo one of MOSAIC_OFFSET_MINUTES
 * @returns {String} tile URL template with {z}/{x}/{y} placeholders
 */
export function mosaicTileUrl(minutesAgo) {
  return `${IEM_TILE_BASE}/${mosaicLayerName(minutesAgo)}/{z}/{x}/{y}.png`;
}

/**
 * Build the mosaic frame list.
 *
 * Timestamps are DERIVED from the offsets rather than reported by IEM,
 * so they're accurate to the generation schedule rather than to a
 * specific volume scan. That distinction matters for the age display:
 * the mosaic's "current" frame is itself built from scans that are
 * already a few minutes old, so its true age is at least the offset,
 * never less. `approximate: true` marks that for the UI.
 *
 * Recomputed from `now` on each poll so the ages stay live.
 *
 * @param {Number} [now] epoch ms to anchor the offsets against
 * @returns {Array<{stamp: String, epoch: Number, url: String, approximate: Boolean}>} oldest-first
 */
export function buildMosaicFrames(now = Date.now()) {
  // Anchor on the most recent 5-minute boundary — IEM regenerates on
  // that schedule, so a frame's nominal time is the boundary, not the
  // arbitrary wall-clock moment we happened to poll at.
  const anchor = Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
  return MOSAIC_OFFSET_MINUTES.map((minutesAgo) => ({
    stamp: `m${minutesAgo}`,
    epoch: anchor - minutesAgo * 60 * 1000,
    url: mosaicTileUrl(minutesAgo),
    approximate: true,
  }));
}

// ── Layer 2: single-site super-res ───────────────────────────────────

/**
 * Leaflet URL template for one single-site frame.
 *
 * `stamp` is `YYYYMMDDHHMM` in UTC as returned by `/api/radar/frames`,
 * or the literal `0` sentinel meaning "whatever is latest". Prefer a
 * real stamp when one is known: `0` gives no way to display frame age,
 * which is the entire point of the freshness work.
 *
 * @param {String} site 3-letter NEXRAD site id, e.g. "DIX"
 * @param {String} [stamp] "202608112158", or "0" for latest
 * @param {String} [product] IEM product id
 * @returns {String} tile URL template with {z}/{x}/{y} placeholders
 */
export function siteTileUrl(site, stamp = "0", product = "N0B") {
  return `${IEM_TILE_BASE}/ridge::${site}-${product}-${stamp}/{z}/{x}/{y}.png`;
}

// ── Zoom band configuration ──────────────────────────────────────────

// Where each layer is authoritative, and where they overlap.
//
// The overlap band must be at least TWO zoom levels wide to exist at
// all. Leaflet's default `zoomSnap` is 1, so the map only ever sits on
// integer zooms — with a one-level band (say mosaic < 8, site > 7) no
// integer zoom satisfies both conditions and the "crossfade" is really
// a hard cutover, which is exactly the abruptness it was meant to
// avoid. Spanning 7→9 puts a genuine 50/50 blend at z=8:
//
//   z ≤ 7   mosaic only        (wide-area situational awareness)
//   z = 8   50 / 50 crossfade  (both layers mounted)
//   z ≥ 9   single-site only   (native radial detail near home)
export const BAND_LOW_ZOOM = 7;
export const BAND_HIGH_ZOOM = 9;

// Mosaic is drawn at or below the top of the band; single-site at or
// above the bottom of it.
export const MOSAIC_MAX_ZOOM = BAND_HIGH_ZOOM;
export const SITE_MIN_ZOOM = BAND_LOW_ZOOM;

// NOTE ON TILE GEOMETRY (measured 2026-08-11, not inherited):
// IEM's `tile.py` is an ON-DEMAND RENDERER, not a fixed tile pyramid.
// It returns a 256 × 256 PNG at every zoom tested (6 → 15), rendering
// the source data to whatever zoom is asked for. Two consequences:
//
//   1. These layers must NOT carry the `tileSize: 512` / `zoomOffset:
//      -1` pairing the RainViewer layer used — that was tuned for
//      RainViewer's 512 px tiles, and applying it here puts every IEM
//      tile at the wrong scale and offset.
//   2. There is no hard zoom cliff to defend against; a deep request
//      returns a real (if oversampled) render rather than a 404.
//
// So the `maxNativeZoom` values below are a DATA-RESOLUTION choice, not
// a limit imposed by the server. Past the point where a zoom step stops
// adding information, asking for deeper tiles costs requests and decode
// time for a picture that cannot get sharper — better to let Leaflet
// stretch the deepest informative tile.

// N0Q is a ~1 km national grid. At z=8 that is already ~469 m/px —
// roughly 2× oversampled — and every further step doubles the
// oversampling for no new detail.
export const MOSAIC_MAX_NATIVE_ZOOM = 8;

// N0B is native radial data at 0.25 km gates, so it stays informative
// considerably deeper than the mosaic. z=12 is ~29 m/px, comfortably
// past the point where the gate spacing is resolved; beyond it Leaflet
// upscales an already-oversampled image, which is visually
// indistinguishable and cheaper.
export const SITE_MAX_NATIVE_ZOOM = 12;

/**
 * Opacity for each radar layer at a given zoom, producing a crossfade
 * through the overlap band instead of a hard swap.
 *
 * Below the band only the mosaic is drawn; above it only the
 * single-site layer. Inside, the two are ramped linearly in opposite
 * directions so total ink stays roughly constant — the picture
 * resolves into sharper detail as you zoom rather than flickering.
 *
 * Both are scaled by `baseOpacity` (the user's radar-opacity pref) so
 * the crossfade never overrides their setting.
 *
 * @param {Number} zoom current Leaflet zoom
 * @param {Number} baseOpacity user's radar opacity preference (0-1)
 * @returns {{mosaic: Number, site: Number}} per-layer opacity
 */
export function layerOpacities(zoom, baseOpacity = 1) {
  if (!Number.isFinite(zoom)) return { mosaic: baseOpacity, site: 0 };
  if (zoom <= BAND_LOW_ZOOM) return { mosaic: baseOpacity, site: 0 };
  if (zoom >= BAND_HIGH_ZOOM) return { mosaic: 0, site: baseOpacity };
  // Inside the band: linear ramp on the position across it.
  const t = (zoom - BAND_LOW_ZOOM) / (BAND_HIGH_ZOOM - BAND_LOW_ZOOM);
  return { mosaic: baseOpacity * (1 - t), site: baseOpacity * t };
}

/**
 * Whether each layer should be mounted at a given zoom.
 *
 * Kept beside `layerOpacities` on purpose: mount gating and opacity
 * must agree, or a layer ends up mounted at opacity 0 (wasted tile
 * fetches) or unmounted while the crossfade still wants to draw it
 * (a visible gap in the band). One source of truth for both.
 *
 * @param {Number} zoom current Leaflet zoom
 * @returns {{mosaic: Boolean, site: Boolean}}
 */
export function layerVisibility(zoom) {
  if (!Number.isFinite(zoom)) return { mosaic: true, site: false };
  // Strict inequalities so a layer is mounted exactly when its opacity
  // is non-zero: at BAND_HIGH the mosaic has already faded to 0, and at
  // BAND_LOW the single-site layer has not yet faded in.
  return {
    mosaic: zoom < BAND_HIGH_ZOOM,
    site: zoom > BAND_LOW_ZOOM,
  };
}

// ── Frame age ────────────────────────────────────────────────────────

// Age at which a frame stops being "current" and the UI should say so.
// NEXRAD has an irreducible latency floor — a volume scan takes 4-6 min
// to complete before any product exists, then mosaicking adds more — so
// anything under ~6 min is as fresh as this data physically gets and
// must not be flagged. Past 12 min something is genuinely wrong
// upstream (or our poll is failing) and the user should see that rather
// than trust a stale picture.
export const FRAME_FRESH_MS = 6 * 60 * 1000;
export const FRAME_STALE_MS = 12 * 60 * 1000;

/**
 * Classify a frame's age for display.
 *
 * @param {Number|null} epoch frame timestamp in epoch ms
 * @param {Number} [now] epoch ms
 * @returns {{ageMs: Number|null, ageMinutes: Number|null, level: "fresh"|"aging"|"stale"|"unknown"}}
 */
export function frameAge(epoch, now = Date.now()) {
  if (!Number.isFinite(epoch)) {
    return { ageMs: null, ageMinutes: null, level: "unknown" };
  }
  const ageMs = Math.max(0, now - epoch);
  const ageMinutes = Math.floor(ageMs / 60000);
  let level = "fresh";
  if (ageMs >= FRAME_STALE_MS) level = "stale";
  else if (ageMs >= FRAME_FRESH_MS) level = "aging";
  return { ageMs, ageMinutes, level };
}
