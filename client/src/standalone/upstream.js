// Standalone replacements for the three server routes that exist only
// because the server held an API key or a socket the browser lacked.
//
// The radar controllers port verbatim (see ./api.js). These three do not,
// for a reason each:
//
//   reverse-geocode  LocationIQ needs a key. Shipping one inside an APK
//                    means publishing it, so the app uses the city/state
//                    that api.weather.gov already returns for free beside
//                    the radar station — one call, no key, and the app is
//                    NEXRAD-only (US) anyway, which is exactly that field's
//                    coverage.
//   map tiles        Mapbox needs a key. The app uses Esri's Canvas basemaps,
//                    which are genuinely keyless (see MAP_MAX_NATIVE_ZOOM
//                    below for the one thing to know about them).
//   geolocation      The IP fallback for when the device denies location.
//                    Keyless and CORS-open; the server cached it to a file,
//                    which the app has no use for (one call per cold start).

import axios from "axios";

const API_TIMEOUT_MS = 10_000;
const USER_AGENT_NOTE = "sweep-radar (github.com/aryeh95/pi-weather-station)";

// api.weather.gov/points is stable per ~1 km cell and the app re-asks on
// every pin move, so a small in-memory cache keyed to 3 decimals (~110 m)
// keeps a pan from re-querying. Bounded so a long session cannot grow it
// without limit.
const PLACE_CACHE = new Map();
const PLACE_CACHE_MAX = 200;

/**
 * Reverse geocode via the NWS point metadata the radar path already uses.
 *
 * Answers in LocationIQ's response shape (`{ address: { … } }`) because
 * `LocationName.getName` reads that shape; `country_code: "us"` selects its
 * "city, state" branch, which is the format the kiosk has always shown.
 *
 * A point with no NWS coverage (offshore, outside CONUS) resolves to 204,
 * the same "settled empty" signal the LocationIQ proxy sent for a 404 — the
 * client then falls back to displaying the coordinates.
 *
 * @param {object} req Express-shaped request; `query.lat` / `query.lon`
 * @param {object} res Express-shaped response collector
 * @returns {Promise<object>} the response collector
 */
export async function reverseGeocode(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json("Invalid coordinates").end();
  }

  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (PLACE_CACHE.has(key)) {
    const cached = PLACE_CACHE.get(key);
    return cached ? res.status(200).json(cached).end() : res.status(204).end();
  }

  try {
    const { data } = await axios.get(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { timeout: API_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT_NOTE } }
    );
    const place = data?.properties?.relativeLocation?.properties;
    if (!place?.city) {
      rememberPlace(key, null);
      return res.status(204).end();
    }
    const payload = {
      address: { city: place.city, state: place.state, country_code: "us", country: "USA" },
    };
    rememberPlace(key, payload);
    return res.status(200).json(payload).end();
  } catch {
    // No coverage, or the network is down. Either way the caller's
    // coordinate fallback is the right display, and a transient failure
    // must not be cached as a permanent "no name here".
    return res.status(204).end();
  }
}

/**
 * Insert into the place cache, evicting the oldest entry when full.
 *
 * @param {string} key quantised "lat,lon"
 * @param {object|null} value payload, or null for a known-empty point
 */
function rememberPlace(key, value) {
  if (PLACE_CACHE.size >= PLACE_CACHE_MAX) {
    PLACE_CACHE.delete(PLACE_CACHE.keys().next().value);
  }
  PLACE_CACHE.set(key, value);
}

/**
 * Coarse position from the client's IP — the fallback the app uses only when
 * the device refuses `navigator.geolocation` (which the client tries first).
 *
 * @param {object} req Express-shaped request (unused; no parameters)
 * @param {object} res Express-shaped response collector
 * @returns {Promise<object>} the response collector
 */
export async function ipGeolocation(req, res) {
  try {
    const { data } = await axios.get("https://ipapi.co/json/", { timeout: API_TIMEOUT_MS });
    const { latitude, longitude } = data || {};
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      return res.status(503).json("No position for this address").end();
    }
    return res.status(200).json({ latitude, longitude }).end();
  } catch {
    // Rate-limited or offline. The caller treats a rejection as "no position",
    // which leaves the map on its stored pin — the right outcome either way.
    return res.status(503).json("Geolocation unavailable").end();
  }
}

// Keyless basemap: Esri's Canvas services. Grey, label-light cartography
// designed to sit UNDER data, which is exactly what a radar overlay wants.
//
// CARTO's `basemaps.cartocdn.com` was used first and was wrong: it answers
// 200 with a normal-looking PNG whose pixels carry an "API KEY REQUIRED"
// watermark. Checking the status code is NOT enough to call a tile source
// keyless — the tiles have to be looked at. Same lesson applies below.
const ESRI_BASE = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const ESRI_SERVICE = { dark: "World_Dark_Gray_Base", light: "World_Light_Gray_Base" };

// The service advertises levels 0-23, but from z17 up it serves a 200 with a
// placeholder JPEG reading "Map data not yet available" (verified over
// Baltimore, 2026-09-03; z16 is full street detail). So this is a real data
// ceiling, and Leaflet must be told to upscale z17-18 from z16 rather than
// request the placeholder — the same maxNativeZoom reasoning the IEM radar
// layers already use.
export const MAP_MAX_NATIVE_ZOOM = 16;

// Mapbox, when the user has supplied their own PUBLIC token in Settings.
// Optional throughout: no token ships in the APK, and an empty token leaves
// every function below on the keyless Esri path.
//
// Only built-in `mapbox/*` styles are reachable here. The kiosk's proxy also
// resolves a Studio style through its CUSTOM_STYLES table, which needs the
// account that owns the style — not something a shared token can carry.
const MAPBOX_STYLE_BASE = "https://api.mapbox.com/styles/v1/mapbox";
const MAPBOX_STYLE_RE = /^[\w-]+$/;

/**
 * Whether a string looks like a usable Mapbox token.
 *
 * Public tokens start `pk.`; secret (`sk.`) tokens must never be shipped to a
 * client, so they are refused here rather than sent to Mapbox and rejected —
 * a 401 in the tile layer looks like a broken basemap, not a bad key.
 *
 * @param {string} [token] candidate token
 * @returns {boolean} true when the token should be used
 */
export function isUsableMapboxToken(token) {
  return typeof token === "string" && token.trim().startsWith("pk.");
}

/**
 * Basemap tile URL template for the app.
 *
 * With a token, Mapbox's raster tiles for the chosen style. Without one,
 * Esri Canvas — note its `{z}/{y}/{x}` order: Esri's REST tile endpoint takes
 * row before column, the reverse of the XYZ convention Leaflet defaults to,
 * and swapping them yields tiles of the wrong place rather than an error.
 *
 * @param {boolean} dark whether the dark palette is active
 * @param {object} [opts] Mapbox options
 * @param {string} [opts.token] the user's public Mapbox token
 * @param {string} [opts.style] Mapbox style id for the active palette
 * @returns {string} Leaflet URL template
 */
export function mapTileUrl(dark, opts = {}) {
  const { token, style } = opts;
  if (isUsableMapboxToken(token)) {
    // Guard the style too: it lands in a URL path, and a stray value would
    // silently 404 every tile. Falls back to Mapbox's own defaults.
    const id = MAPBOX_STYLE_RE.test(style || "")
      ? style
      : (dark ? "dark-v10" : "streets-v12");
    return `${MAPBOX_STYLE_BASE}/${id}/tiles/{z}/{x}/{y}?access_token=${encodeURIComponent(token.trim())}`;
  }
  return `${ESRI_BASE}/${dark ? ESRI_SERVICE.dark : ESRI_SERVICE.light}/MapServer/tile/{z}/{y}/{x}`;
}

/** Attribution text the Esri service's own metadata specifies. */
export const MAP_ATTRIBUTION =
  "Esri, HERE, Garmin, © OpenStreetMap contributors";

/** Mapbox's required attribution, per its terms of service. */
export const MAPBOX_TILE_ATTRIBUTION =
  '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> '
  + '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/**
 * Attribution for whichever basemap is in use.
 *
 * @param {string} [token] the user's Mapbox token, if any
 * @returns {string} attribution HTML
 */
export function mapAttribution(token) {
  return isUsableMapboxToken(token) ? MAPBOX_TILE_ATTRIBUTION : MAP_ATTRIBUTION;
}

/**
 * Deepest zoom to request real tiles for.
 *
 * Esri's ceiling is a data limit (see MAP_MAX_NATIVE_ZOOM); Mapbox serves
 * genuine detail past it, so the cap must not be applied there — undefined
 * lets Leaflet ask for every level.
 *
 * @param {string} [token] the user's Mapbox token, if any
 * @returns {number|undefined} maxNativeZoom for the basemap layer
 */
export function mapMaxNativeZoom(token) {
  return isUsableMapboxToken(token) ? undefined : MAP_MAX_NATIVE_ZOOM;
}
