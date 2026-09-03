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
//   sunrise-sunset   The upstream is keyless and CORS-open; the server
//                    proxied it only to avoid mixed content on the kiosk's
//                    self-signed HTTPS and to log the call. Call it direct.
//   map tiles        Mapbox needs a key. The app defaults to CARTO's keyless
//                    basemaps, which serve the same web-mercator raster grid
//                    Leaflet already asks for.
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
 * Sunrise / sunset for the auto dark-mode switch, called direct.
 *
 * @param {object} req Express-shaped request; `query.lat` / `query.lon`
 * @param {object} res Express-shaped response collector
 * @returns {Promise<object>} the response collector
 */
export async function sunriseSunset(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json("Invalid coordinates").end();
  }
  try {
    const { data } = await axios.get(
      `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0`,
      { timeout: API_TIMEOUT_MS }
    );
    return res.status(200).json(data).end();
  } catch {
    return res.status(503).json("Sunrise/sunset unavailable").end();
  }
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

// Keyless basemaps. CARTO serves these as plain XYZ raster tiles with
// `Access-Control-Allow-Origin: *` (verified 2026-09-03), so Leaflet's
// <img> tiles need no proxy and no token. `{r}` is Leaflet's own
// retina-suffix placeholder, filled from `detectRetina`.
const CARTO_BASE = "https://basemaps.cartocdn.com";
const CARTO_STYLE = { dark: "dark_all", light: "light_all" };

/**
 * Basemap tile URL template for the app.
 *
 * @param {boolean} dark whether the dark palette is active
 * @returns {string} Leaflet URL template
 */
export function mapTileUrl(dark) {
  return `${CARTO_BASE}/${dark ? CARTO_STYLE.dark : CARTO_STYLE.light}/{z}/{x}/{y}{r}.png`;
}

/** Attribution required by CARTO's terms for the keyless basemaps. */
export const MAP_ATTRIBUTION = "© OpenStreetMap contributors © CARTO";
