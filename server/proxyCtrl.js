// Upstream proxies that keep API keys server-side.
//
// Reduced to three handlers in the radar rework. The Tomorrow.io
// forecast endpoints (current / hourly / daily) were removed along with
// the entire weather-cache subsystem that existed to serve them — the
// disk cache, the field-set hashing, the stale-on-error fallback, the
// per-key request spacer and the current-temperature smoothing had
// exactly one consumer between them.
//
// What survives, and why:
//   reverseGeocode — LocationIQ, for the place name under the map
//   mapTile        — Mapbox basemap tiles (the radar's backdrop)
//   sunriseSunset  — drives the auto dark-mode palette switch, which a
//                    kiosk still needs even with no forecast on screen

const axios = require("axios").default;
const { getSettingsData } = require("./settingsCtrl");
const { recordServiceCall } = require("./serviceStatus");
const { sunTimesFor, nextDate } = require("./solar");
const { increment } = require("./requestCounter");

const ALLOWED_STYLES = ["dark-v10", "dark-v11", "light-v10", "light-v11", "navigation-day-v1", "streets-v12"];

/**
 * Custom Mapbox Studio styles (Protected visibility).
 * Maps a short style name to its full "username/style-id" path.
 * Tiles are served with the end-user's own Mapbox API key.
 */
const CUSTOM_STYLES = {
  "custom-light": "thicla01/cmoc9fbfs00c801s833rub3b7",
};

const API_TIMEOUT_MS = 10 * 1000;

/**
 * Proxy: reverse geocode via LocationIQ, keeping the API key server-side
 *
 * @param {Object} req
 * @param {Object} req.query
 * @param {String} req.query.lat
 * @param {String} req.query.lon
 * @param {Object} res
 */
async function reverseGeocode(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json("Invalid coordinates").end();
  }

  let settings;
  try {
    settings = await getSettingsData();
  } catch {
    return res.status(500).json("Could not read settings").end();
  }

  if (!settings.reverseGeoApiKey) {
    return res.status(503).json("Reverse geocoding API key not configured").end();
  }

  try {
    const result = await axios.get(
      `https://us1.locationiq.com/v1/reverse.php?key=${settings.reverseGeoApiKey}&lat=${lat}&lon=${lon}&format=json`,
      { timeout: API_TIMEOUT_MS }
    );
    increment("locationiq", "geocode");
    recordServiceCall("LocationIQ", 200, "OK");
    return res.status(200).json(result.data).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    const message = err?.response?.data?.error || "Reverse geocoding failed";
    increment("locationiq", "geocode");
    // 404 from LocationIQ on a reverse geocode means "no address
    // for this coordinate" (ocean, undeveloped area). The service
    // is responding correctly — there's just no data. Record it
    // as success so the health classifier doesn't paint a panicked
    // red dot, and return 204 No Content to the client so devtools
    // doesn't log it as a network error either. The client's
    // reverseGeocode service resolves 204 to null and the caller
    // falls back to displaying lat/lon.
    if (status === 404) {
      recordServiceCall("LocationIQ", 200, "no address for coord");
      return res.status(204).end();
    }
    recordServiceCall("LocationIQ", status, message);
    return res.status(500).json("Reverse geocoding failed").end();
  }
}

/**
 * Proxy: Mapbox map tiles, keeping the API key server-side
 *
 * @param {Object} req
 * @param {Object} req.params
 * @param {String} req.params.style  Mapbox style (dark-v10 or light-v10)
 * @param {String} req.params.z      Zoom level
 * @param {String} req.params.x      Tile x coordinate
 * @param {String} req.params.y      Tile y coordinate
 * @param {Object} res
 */
async function mapTile(req, res) {
  const { style, z, x, y } = req.params;

  if (!ALLOWED_STYLES.includes(style) && !CUSTOM_STYLES[style]) {
    return res.status(400).json("Invalid map style").end();
  }

  const zNum = parseInt(z, 10);
  const xNum = parseInt(x, 10);
  const yNum = parseInt(y, 10);

  if ([zNum, xNum, yNum].some(isNaN) || zNum < 0 || zNum > 22) {
    return res.status(400).json("Invalid tile coordinates").end();
  }

  let settings;
  try {
    settings = await getSettingsData();
  } catch {
    return res.status(500).json("Could not read settings").end();
  }

  if (!settings.mapApiKey) {
    return res.status(503).json("Map API key not configured").end();
  }

  const stylePath = CUSTOM_STYLES[style] ?? `mapbox/${style}`;
  // Custom styles require an explicit tile size; built-in mapbox styles work without it.
  const tileUrl = CUSTOM_STYLES[style]
    ? `https://api.mapbox.com/styles/v1/${stylePath}/tiles/256/${zNum}/${xNum}/${yNum}?access_token=${settings.mapApiKey}`
    : `https://api.mapbox.com/styles/v1/${stylePath}/tiles/${zNum}/${xNum}/${yNum}?access_token=${settings.mapApiKey}`;

  try {
    const result = await axios.get(
      tileUrl,
      { responseType: "arraybuffer", timeout: API_TIMEOUT_MS }
    );

    const contentType = result.headers["content-type"];
    const cacheControl = result.headers["cache-control"];
    if (contentType) res.setHeader("Content-Type", contentType);
    if (cacheControl) res.setHeader("Cache-Control", cacheControl);

    increment("mapbox", "tiles");
    recordServiceCall("Mapbox", 200, "OK");
    return res.status(200).send(Buffer.from(result.data));
  } catch (err) {
    const status = err?.response?.status || 500;
    const message = err?.response?.data || "Could not fetch map tile";
    increment("mapbox", "tiles");
    recordServiceCall("Mapbox", status, String(message).slice(0, 100));
    return res.status(500).json("Could not fetch map tile").end();
  }
}

/**
 * Sunrise / sunset, computed locally (see ./solar.js) rather than fetched.
 *
 * Response shape:
 *   - Default (no `tomorrow` param): pass-through of the upstream JSON
 *     `{ status, results: {...} }`. Preserved for backward compatibility
 *     with any caller that only needs today.
 *   - With `tomorrow=1`: enriches into
 *     `{ status, results: {...today...}, tomorrowResults: {...tomorrow...} }`
 *     where `tomorrowResults` is the result of a second upstream call
 *     for the day after `date` (or after today UTC if no date supplied).
 *     Both upstream calls run in parallel. The tomorrow call's failure
 *     does NOT fail the whole response — `tomorrowResults` is omitted
 *     and the today payload is still returned (the SunDetailsPopover
 *     degrades to em-dashes for the tomorrow rows).
 *
 * @param {Object} req
 * @param {Object} req.query
 * @param {String} req.query.lat
 * @param {String} req.query.lon
 * @param {String} [req.query.date]      YYYY-MM-DD, local date for "today"
 * @param {String} [req.query.tomorrow]  truthy → also fetch the day after `date`
 * @param {Object} res
 */
async function sunriseSunset(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json("Invalid coordinates").end();
  }

  // Optional `date` parameter (YYYY-MM-DD). The client passes its LOCAL date
  // so the returned sunrise / sunset belong to the user's day: defaulting to
  // "today UTC" means that for users west of UTC during evening hours the
  // answer is already the next UTC day, which skips today's local sunset and
  // flips auto dark-mode early. Strict regex so junk cannot reach the maths.
  const todayDate = typeof req.query.date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toISOString().slice(0, 10);

  const results = sunTimesFor(todayDate, lat, lon);
  const payload = { results: results || null, status: results ? "OK" : "NO_CROSSING" };
  if (req.query.tomorrow) {
    payload.tomorrowResults = sunTimesFor(nextDate(todayDate), lat, lon) || null;
  }
  return res.status(200).json(payload).end();
}

module.exports = {
  reverseGeocode, mapTile, sunriseSunset,
};
