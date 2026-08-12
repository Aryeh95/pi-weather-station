// NEXRAD Level III storm tracks (STI, product 58 / "NST").
//
// NWS already runs the cell-detection algorithm (SCIT), so this is not a
// detector — it reads the answer NWS published and puts it on the map.
// Each volume scan yields a set of storm cells with a current position,
// a motion vector, and forecast positions 15/30/45/60 minutes out.
//
// SOURCE: the public `unidata-nexrad-level3` S3 bucket, keys shaped
// `SSS_NST_YYYY_MM_DD_HH_MM_SS`. The bucket is world-readable, so it is
// listed and fetched over plain HTTPS — no AWS SDK, no credentials. Keys
// sort lexicographically, which for this naming is also chronologically,
// so "newest" is just the last key under an hour-scoped prefix.
//
// PARSING: `nexrad-level-3-data` decodes the Level III wrapper. The cell
// table itself arrives as the product's TABULAR block — fixed-width text,
// the same page a forecaster reads. Page 0 looks like:
//
//    STORM    CURRENT POSITION              FORECAST POSITIONS       ERROR
//     ID     AZRAN     MOVEMENT    15 MIN    30 MIN    45 MIN    60 MIN
//            (DEG/NM)  (DEG/KTS)   (DEG/NM)  (DEG/NM)  (DEG/NM)  (DEG/NM)
//
//     T3      48/110   308/ 22      51/111    54/112    56/114    59/116
//     E4      33/ 61     NEW       NO DATA   NO DATA   NO DATA   NO DATA
//
// ── The one trap worth stating loudly ────────────────────────────────
// The MOVEMENT column is the direction the storm comes FROM, not the
// direction it is heading. Verified against this very product on
// 2026-08-12: cell T3 reads `308/22`, yet its own forecast positions walk
// from (41.159, -72.603) to (40.922, -72.219) — a bearing of ~129°, i.e.
// 308 − 180. Cell X3 agrees independently (`320` vs a measured ~140°).
//
// Drawing an arrow straight from MOVEMENT would therefore point every
// track backwards, which is worse than drawing nothing on a severe-
// weather display. So the track geometry here is built ONLY from the
// forecast positions, which are unambiguous coordinates. MOVEMENT is
// carried through for the label and never used to derive direction.

const axios = require("axios");
const parseLevel3 = require("nexrad-level-3-data");
const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { BoundedMap } = require("./boundedCache");

const SERVICE_NAME = "NEXRAD L3 (storm tracks)";
const BUCKET_BASE = "https://unidata-nexrad-level3.s3.amazonaws.com";
const API_TIMEOUT_MS = 15_000;

// One volume scan per file (4-6 min). 60 s keeps the display close to the
// radar's own cadence without re-listing the bucket for every client poll.
const TRACKS_TTL_MS = 60 * 1000;
const tracksCache = new BoundedMap(16);

const NM_TO_KM = 1.852;
const EARTH_R_KM = 6371;

// Forecast columns, in the order the product prints them.
const FORECAST_MINUTES = [15, 30, 45, 60];

/**
 * Offset a coordinate by a bearing and distance along a great circle.
 * Mirrors `offsetLatLon` in client/src/components/WeatherMap/geometry.js —
 * same formula, same earth radius, so a cell plotted server-side lands
 * exactly where the client's own geometry would put it.
 *
 * @param {Number} lat origin latitude (degrees)
 * @param {Number} lon origin longitude (degrees)
 * @param {Number} bearingDeg bearing clockwise from true north
 * @param {Number} distKm distance in kilometres
 * @returns {{lat: Number, lon: Number}} destination coordinate
 */
function offsetLatLon(lat, lon, bearingDeg, distKm) {
  const br = (bearingDeg * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const d = distKm / EARTH_R_KM;
  const la2 = Math.asin(
    Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br)
  );
  const lo2 = lo + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(la),
    Math.cos(d) - Math.sin(la) * Math.sin(la2)
  );
  return { lat: (la2 * 180) / Math.PI, lon: (lo2 * 180) / Math.PI };
}

/**
 * Parse an `AZ/RAN`-style token into degrees + nautical miles.
 *
 * @param {String} tok e.g. "48/110"
 * @returns {{azimuth: Number, rangeNm: Number}|null} null when not a pair
 */
function parsePair(tok) {
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(tok || "");
  if (!m) return null;
  return { azimuth: Number(m[1]), rangeNm: Number(m[2]) };
}

/**
 * Extract storm cells from the product's tabular page.
 *
 * Normalisation matters more than it looks: the product pads columns, so
 * a movement reads `308/ 22` with an embedded space, and "NO DATA" is two
 * words. Collapsing the spaces around slashes and joining "NO DATA" makes
 * every row a clean whitespace-delimited token list:
 *
 *   ["T3", "48/110", "308/22", "51/111", …, "0.3/0.8"]
 *   ["E4", "33/61",  "NEW",    "NODATA", …, "0.0/0.0"]
 *
 * which is far less brittle than slicing by column offset.
 *
 * @param {Array<String>} lines page 0 of the tabular block
 * @returns {Array<Object>} raw cell rows (azimuth/range space, not lat/lon)
 */
function parseCellRows(lines) {
  const rows = [];
  for (const raw of lines || []) {
    const line = String(raw || "")
      .replace(/NO\s+DATA/g, "NODATA")
      .replace(/\s*\/\s*/g, "/")
      .trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    // A data row is "<ID> <az/ran> …". Requiring token 1 to be a numeric
    // pair rejects the header rows ("ID AZRAN MOVEMENT", "(DEG/NM) …")
    // without hardcoding how many header lines the product happens to use.
    if (tok.length < 3) continue;
    const position = parsePair(tok[1]);
    if (!position) continue;
    if (!/^[A-Z0-9]{2,3}$/.test(tok[0])) continue;

    const movement = tok[2] === "NEW" ? null : parsePair(tok[2]);
    const forecast = [];
    for (let i = 0; i < FORECAST_MINUTES.length; i += 1) {
      const t = tok[3 + i];
      forecast.push(t && t !== "NODATA" ? parsePair(t) : null);
    }
    rows.push({ id: tok[0], position, movement, forecast });
  }
  return rows;
}

/**
 * Convert one parsed row into map-ready geometry.
 *
 * `track` is the polyline the client draws: the current position followed
 * by each forecast position that exists. A cell SCIT has just detected
 * reports `NEW` with no forecasts, so its track is a single point — the
 * client renders that as a dot with no arrow rather than inventing a
 * direction for it.
 *
 * @param {Object} row output of parseCellRows
 * @param {Number} radarLat radar site latitude
 * @param {Number} radarLon radar site longitude
 * @returns {Object} cell with lat/lon geometry
 */
function toGeoCell(row, radarLat, radarLon) {
  const at = (p) => offsetLatLon(radarLat, radarLon, p.azimuth, p.rangeNm * NM_TO_KM);
  const current = at(row.position);
  const track = [current];
  const forecast = [];
  row.forecast.forEach((p, i) => {
    if (!p) return;
    const pt = at(p);
    forecast.push({ minutes: FORECAST_MINUTES[i], ...pt });
    track.push(pt);
  });
  return {
    id: row.id,
    ...current,
    // Speed is meaningful on its own; direction is deliberately NOT
    // republished as a heading — see the header note. `movementFromDeg`
    // is named for what it actually is.
    speedKt: row.movement ? row.movement.rangeNm : null,
    movementFromDeg: row.movement ? row.movement.azimuth : null,
    isNew: !row.movement,
    rangeNm: row.position.rangeNm,
    forecast,
    track,
  };
}

/**
 * List the bucket and return the newest STI key for a site.
 *
 * Scoped to an hour prefix so the listing stays ~12 keys instead of a
 * full day's ~300. Falls back to the previous hour, which also covers the
 * first minutes after a UTC day/hour rollover when the current prefix is
 * still empty.
 *
 * @param {String} site 3-letter radar id (e.g. "DIX")
 * @returns {Promise<String|null>} newest key, or null when none recently
 */
async function newestKey(site) {
  const now = new Date();
  for (let back = 0; back < 3; back += 1) {
    const t = new Date(now.getTime() - back * 60 * 60 * 1000);
    const p = `${site}_NST_${t.getUTCFullYear()}_`
      + `${String(t.getUTCMonth() + 1).padStart(2, "0")}_`
      + `${String(t.getUTCDate()).padStart(2, "0")}_`
      + `${String(t.getUTCHours()).padStart(2, "0")}`;
    const res = await axios.get(BUCKET_BASE, {
      params: { "list-type": 2, prefix: p, "max-keys": 1000 },
      timeout: API_TIMEOUT_MS,
      responseType: "text",
    });
    const keys = String(res.data).match(/<Key>([^<]+)<\/Key>/g) || [];
    if (keys.length) {
      // Lexicographic order is chronological for this key shape.
      return keys[keys.length - 1].replace(/<\/?Key>/g, "");
    }
  }
  return null;
}

/**
 * Fetch + parse the newest storm-track product for a site.
 *
 * @param {String} site 3-letter radar id
 * @returns {Promise<Object>} payload for /api/storm-tracks
 */
async function fetchTracks(site) {
  const hit = tracksCache.get(site);
  if (hit && hit.expires > Date.now()) return hit.value;

  const key = await newestKey(site);
  increment("nexrad-l3", "list");
  if (!key) {
    // No recent product. Normal for a radar in clear-air mode with no
    // cells — not an error.
    const empty = { available: true, site, cells: [], generatedAt: new Date().toISOString() };
    tracksCache.set(site, { value: empty, expires: Date.now() + TRACKS_TTL_MS });
    recordServiceCall(SERVICE_NAME, 200, `no recent STI for ${site}`);
    return empty;
  }

  const res = await axios.get(`${BUCKET_BASE}/${key}`, {
    responseType: "arraybuffer",
    timeout: API_TIMEOUT_MS,
  });
  increment("nexrad-l3", "product");

  const parsed = parseLevel3(Buffer.from(res.data));
  const pd = parsed && parsed.productDescription;
  const radarLat = pd && pd.latitude;
  const radarLon = pd && pd.longitude;
  if (!Number.isFinite(radarLat) || !Number.isFinite(radarLon)) {
    throw new Error("product missing radar coordinates");
  }

  const page = (parsed.tabular && parsed.tabular.pages && parsed.tabular.pages[0]) || [];
  const cells = parseCellRows(page).map((r) => toGeoCell(r, radarLat, radarLon));

  // Scan time: the product prints its volume-scan date as a Julian day
  // (days since 1970-01-01, 1-based) plus seconds past midnight UTC.
  let scanTime = null;
  if (Number.isFinite(pd.volumeScanDate) && Number.isFinite(pd.volumeScanTime)) {
    scanTime = new Date(((pd.volumeScanDate - 1) * 86400 + pd.volumeScanTime) * 1000).toISOString();
  }

  const value = {
    available: true,
    site,
    key,
    scanTime,
    radar: { lat: radarLat, lon: radarLon },
    cells,
    generatedAt: new Date().toISOString(),
  };
  tracksCache.set(site, { value, expires: Date.now() + TRACKS_TTL_MS });
  recordServiceCall(SERVICE_NAME, 200, `${cells.length} cell(s) for ${site}`);
  return value;
}

/**
 * GET /api/storm-tracks?site=DIX
 *
 * Returns the SCIT storm cells for a radar, each with its current
 * position, its forecast positions, and a ready-to-draw `track` polyline.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getStormTracks(req, res) {
  const site = String(req.query.site || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(site)) {
    return res.status(400).json("Invalid or missing site").end();
  }
  try {
    const payload = await fetchTracks(site);
    return res.status(200).json(payload).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `storm tracks failed for ${site}`);
    // 503, matching the radar frame poller: an upstream blip should leave
    // the client showing its last good tracks, not blank the overlay.
    return res.status(503).json({ available: false, cells: [], reason: "upstream-unavailable" }).end();
  }
}

module.exports = {
  getStormTracks,
  // Exported for tests.
  parseCellRows,
  toGeoCell,
  offsetLatLon,
  parsePair,
};
