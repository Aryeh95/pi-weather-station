// IEM (Iowa Environmental Mesonet) NEXRAD radar support.
//
// This controller backs the two-layer radar design:
//
//   Layer 1 — composite mosaic (low zoom). Pure client-side URL
//     construction: IEM regenerates `nexrad-n0q-900913` on a fixed
//     5-minute schedule, and the animation frames are addressed by
//     fixed offsets (`-m05m`, `-m10m`, … `-m50m`). No frame discovery
//     is needed, so no server route exists for it.
//
//   Layer 2 — single-site super-res base reflectivity (high zoom).
//     `ridge::XXX-N0B-<timestamp>` tiles. These are NOT on a
//     predictable grid: a NEXRAD volume scan completes every 4-6 min
//     depending on the VCP the radar is running, and the VCP changes
//     with the weather. The timestamps therefore cannot be computed
//     client-side and must be discovered. That discovery is the
//     reason this file exists.
//
// Frame discovery uses IEM's JSON radar API rather than scraping the
// browsable RIDGE image folders. Verified live 2026-08-11:
//
//   /json/radar.py?operation=available&lat=&lon=   → radars near a point
//   /json/radar.py?operation=products&radar=DIX    → products for a site
//   /json/radar.py?operation=list&radar=&product=&start=&end=
//       → {"scans":[{"ts":"2026-08-11T21:51Z"}, …]}
//
// The `list` operation is the one that matters: it returns the exact
// scan times, which map 1:1 onto the `-<timestamp>` tile segment.
//
// Tiles themselves are NOT proxied. They are keyless, public, and
// served straight to Leaflet's <img> tags — the same arrangement the
// RainViewer and ECCC layers already used. Only the JSON is proxied,
// which keeps CORS out of the picture and gives us one place to cache.

const axios = require("axios");
const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { BoundedMap } = require("./boundedCache");

const SERVICE_NAME = "IEM (radar)";
const API_TIMEOUT_MS = 10_000;

const IEM_JSON_BASE = "https://mesonet.agron.iastate.edu/json/radar.py";
const NWS_POINTS_BASE = "https://api.weather.gov/points";

// NWS asks for an identifying User-Agent on api.weather.gov. The existing
// govAlertSources/nws.js sends the same courtesy header.
const NWS_USER_AGENT = "pi-weather-station (radar site lookup)";

// Default product. N0B is super-res base reflectivity (0.5° tilt,
// 0.25 km gates) — native radial data, the same product RadarScope
// shows by default, and confirmed present in `operation=products`.
const DEFAULT_PRODUCT = "N0B";

// How far back to ask for scans. Sized to fill a 30-frame loop even in
// the slowest clear-air VCP (~10 min/volume → 300 min); in storm mode
// the same window returns more scans and the count cap below takes the
// most recent 30. Still a short JSON list either way (~30-75 entries).
const FRAME_LOOKBACK_MS = 300 * 60 * 1000;

// Most recent N scans returned to the client. 30 frames matches
// RadarScope's default loop length — ~2 to 2.5 h of history at a 4-6 min
// storm-mode cadence. (The mosaic layer still tops out at its 10 fixed
// 5-minute offsets; IEM publishes nothing older than -m50m.)
const DEFAULT_FRAME_COUNT = 30;
const MAX_FRAME_COUNT = 30;

// Frame lists are cached briefly. A new volume scan lands every 4-6 min,
// so 45 s keeps the displayed frame age honest (the whole point of the
// feature is that staleness is visible) without re-asking IEM on every
// client poll.
const FRAMES_TTL_MS = 45 * 1000;
const FRAMES_CACHE_MAX = 32;
const framesCache = new BoundedMap(FRAMES_CACHE_MAX);

// Site resolution is far more stable — the radar assigned to a point
// only changes when the user moves the map somewhere else entirely.
// Cache for a day, keyed on coarse coordinates.
const SITE_TTL_MS = 24 * 60 * 60 * 1000;
const SITE_CACHE_MAX = 64;
const siteCache = new BoundedMap(SITE_CACHE_MAX);

/**
 * Convert an IEM scan timestamp into the compact form the RIDGE tile
 * URL segment expects.
 *
 * IEM returns ISO-ish minute-precision UTC (`2026-08-11T21:51Z`); the
 * tile path wants `YYYYMMDDHHMM` (`202608112151`). Done by stripping
 * separators rather than by re-formatting a Date, so we can't
 * accidentally shift the value into local time.
 *
 * @param {String} ts IEM scan timestamp, e.g. "2026-08-11T21:51Z"
 * @returns {String|null} e.g. "202608112151", or null if unparseable
 */
function toTileStamp(ts) {
  if (typeof ts !== "string") return null;
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`;
}

/**
 * Parse an IEM scan timestamp to epoch milliseconds.
 *
 * The `Z` suffix makes these unambiguous UTC, so Date.parse is safe
 * here (the codebase avoids it for bare local-time strings).
 *
 * @param {String} ts IEM scan timestamp
 * @returns {Number|null} epoch ms, or null if unparseable
 */
function toEpochMs(ts) {
  if (typeof ts !== "string") return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format a Date as the `YYYY-MM-DDTHH:MMZ` string the IEM `list`
 * operation accepts for its start/end bounds.
 *
 * @param {Date} d
 * @returns {String}
 */
function toIemBound(d) {
  return `${d.toISOString().slice(0, 16)}Z`;
}

/**
 * Normalise an NWS radar station id to the 3-letter form IEM's RIDGE
 * layers use.
 *
 * `api.weather.gov/points/{lat},{lon}` reports a 4-character ICAO-style
 * id — `KDIX` in CONUS, `PAHG` in Alaska, `TJUA` in Puerto Rico — while
 * IEM addresses the same sites with 3 letters (`DIX`, `AHG`, `JUA`).
 * Dropping the leading region letter is the correct transform for all
 * of them. Ids that are already 3 characters pass through unchanged.
 *
 * @param {String} station e.g. "KDIX"
 * @returns {String|null} e.g. "DIX", or null if not a plausible id
 */
function normalizeSiteId(station) {
  if (typeof station !== "string") return null;
  const s = station.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  if (/^[A-Z]{4}$/.test(s)) return s.slice(1);
  return null;
}

/**
 * Coarse cache key for a coordinate. Two decimal places is ~1 km,
 * far finer than the scale at which the assigned radar changes, so
 * this collapses the constant small jitter of a panning map into a
 * single cache entry.
 *
 * @param {Number} lat
 * @param {Number} lon
 * @returns {String}
 */
function coordKey(lat, lon) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

/**
 * Resolve the NEXRAD site covering a coordinate.
 *
 * Primary source is NWS: `points/{lat},{lon}` carries a `radarStation`
 * field, which is the office's own assignment for that point and so is
 * the authoritative answer to "which radar serves here".
 *
 * Fallback is IEM's own `operation=available`, filtered to NEXRAD (the
 * list also contains TDWR terminal radars and the national composite,
 * neither of which serve N0B RIDGE tiles the way we want) and sorted by
 * great-circle distance. This covers the case where NWS is unreachable
 * or returns a point outside its coverage.
 *
 * @param {Number} lat
 * @param {Number} lon
 * @returns {Promise<{site: String, name: String|null, source: String}>}
 * @throws {Error} when neither source yields a usable site
 */
async function resolveRadarSite(lat, lon) {
  const key = coordKey(lat, lon);
  const hit = siteCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let resolved = null;

  // --- Primary: NWS point metadata ---------------------------------
  try {
    const res = await axios.get(`${NWS_POINTS_BASE}/${lat.toFixed(4)},${lon.toFixed(4)}`, {
      timeout: API_TIMEOUT_MS,
      headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" },
    });
    increment("nws", "points");
    const site = normalizeSiteId(res.data?.properties?.radarStation);
    if (site) {
      resolved = { site, name: null, source: "nws" };
      recordServiceCall(SERVICE_NAME, 200, `site ${site} via NWS`);
    }
  } catch (err) {
    // Non-fatal — fall through to IEM. Recorded so the health panel
    // can still see that NWS was tried and failed.
    recordServiceCall(SERVICE_NAME, err?.response?.status || 500, "NWS point lookup failed");
  }

  // --- Fallback: IEM's own radar list ------------------------------
  if (!resolved) {
    const res = await axios.get(IEM_JSON_BASE, {
      params: { operation: "available", lat, lon },
      timeout: API_TIMEOUT_MS,
    });
    increment("iem", "radar-available");
    const radars = Array.isArray(res.data?.radars) ? res.data.radars : [];
    const nexrads = radars.filter(
      (r) => r && r.type === "NEXRAD" && typeof r.id === "string"
        && Number.isFinite(r.lat) && Number.isFinite(r.lon)
    );
    if (!nexrads.length) {
      recordServiceCall(SERVICE_NAME, 200, "no NEXRAD site near coord");
      throw new Error("No NEXRAD site available for this location");
    }
    // Equirectangular approximation — plenty for ranking candidates
    // that are all within a few hundred km.
    const cosLat = Math.cos((lat * Math.PI) / 180);
    nexrads.sort((a, b) => {
      const da = ((a.lat - lat) ** 2) + (((a.lon - lon) * cosLat) ** 2);
      const db = ((b.lat - lat) ** 2) + (((b.lon - lon) * cosLat) ** 2);
      return da - db;
    });
    const nearest = nexrads[0];
    resolved = {
      site: normalizeSiteId(nearest.id) || nearest.id,
      name: nearest.name || null,
      source: "iem",
    };
    recordServiceCall(SERVICE_NAME, 200, `site ${resolved.site} via IEM fallback`);
  }

  siteCache.set(key, { value: resolved, expires: Date.now() + SITE_TTL_MS });
  return resolved;
}

/**
 * GET /api/radar/site?lat&lon
 *
 * Returns the 3-letter NEXRAD site id the single-site super-res layer
 * should address, so the client never hardcodes one.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getRadarSite(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json("Invalid coordinates").end();
  }

  try {
    const resolved = await resolveRadarSite(lat, lon);
    return res.status(200).json({ available: true, ...resolved }).end();
  } catch (err) {
    // A location with no NEXRAD coverage (outside the US) is a normal
    // answer, not a server fault: the client hides the single-site
    // layer and stays on the mosaic. 200 + available:false mirrors how
    // pollenCtrl reports "no data at this coordinate".
    recordServiceCall(SERVICE_NAME, 200, "site unavailable");
    return res.status(200).json({ available: false, reason: String(err.message).slice(0, 120) }).end();
  }
}

/**
 * Fetch and normalise the recent scan list for one site+product.
 *
 * Returned frames are oldest-first (IEM's own order), each carrying the
 * tile-ready stamp plus the parsed epoch so the client can render frame
 * age without re-parsing.
 *
 * @param {String} site 3-letter site id
 * @param {String} product IEM product id (e.g. "N0B")
 * @param {Number} count max frames to return (most recent N)
 * @returns {Promise<{site: String, product: String, frames: Array}>}
 */
async function fetchFrames(site, product, count) {
  const key = `${site}:${product}:${count}`;
  const hit = framesCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const now = Date.now();
  const res = await axios.get(IEM_JSON_BASE, {
    params: {
      operation: "list",
      radar: site,
      product,
      start: toIemBound(new Date(now - FRAME_LOOKBACK_MS)),
      end: toIemBound(new Date(now)),
    },
    timeout: API_TIMEOUT_MS,
  });
  increment("iem", "radar-list");

  const scans = Array.isArray(res.data?.scans) ? res.data.scans : [];
  const frames = scans
    .map((s) => {
      const stamp = toTileStamp(s?.ts);
      const epoch = toEpochMs(s?.ts);
      return stamp && epoch ? { stamp, ts: s.ts, epoch } : null;
    })
    .filter(Boolean)
    // IEM returns ascending, but sort explicitly rather than trusting it —
    // the frame age display and the "latest frame" pick both depend on
    // the last element genuinely being the newest.
    .sort((a, b) => a.epoch - b.epoch)
    .slice(-count);

  const value = { site, product, frames, generatedAt: new Date(now).toISOString() };
  framesCache.set(key, { value, expires: now + FRAMES_TTL_MS });
  recordServiceCall(SERVICE_NAME, 200, `${frames.length} frames for ${site}/${product}`);
  return value;
}

/**
 * GET /api/radar/frames?site=DIX&product=N0B&count=12
 *
 * The frame-list poller. Answers with the concrete scan timestamps that
 * build `ridge::<site>-<product>-<stamp>` tile URLs, plus each frame's
 * epoch so the client can show how old the displayed frame actually is.
 *
 * `site` may be omitted in favour of `lat`/`lon`, in which case the site
 * is resolved first — the common client path, since it means one request
 * instead of two on startup.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getRadarFrames(req, res) {
  const product = String(req.query.product || DEFAULT_PRODUCT).toUpperCase();
  if (!/^[A-Z0-9]{3}$/.test(product)) {
    return res.status(400).json("Invalid product").end();
  }

  let count = parseInt(req.query.count, 10);
  if (!Number.isFinite(count) || count < 1) count = DEFAULT_FRAME_COUNT;
  count = Math.min(count, MAX_FRAME_COUNT);

  let site = normalizeSiteId(req.query.site);

  // Coordinate form: resolve the site first so the client can make a
  // single call on startup.
  if (!site) {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json("Provide either site, or valid lat and lon").end();
    }
    try {
      ({ site } = await resolveRadarSite(lat, lon));
    } catch {
      return res.status(200).json({ available: false, frames: [], reason: "no-radar-coverage" }).end();
    }
  }

  try {
    const payload = await fetchFrames(site, product, count);
    return res.status(200).json({ available: true, ...payload }).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `frame list failed for ${site}`);
    // 503 rather than 500: this is an upstream availability problem and
    // the client's correct response is to keep showing the last good
    // frame list flagged stale, not to treat the app as broken.
    return res.status(503).json({ available: false, frames: [], reason: "upstream-unavailable" }).end();
  }
}

module.exports = {
  getRadarSite,
  getRadarFrames,
  // Exported for tests.
  toTileStamp,
  toEpochMs,
  normalizeSiteId,
  resolveRadarSite,
};
