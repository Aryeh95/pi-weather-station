// GOES GLM lightning — flash positions for the map overlay.
//
// The Geostationary Lightning Mapper on GOES-19 (GOES-East since April
// 2025 — older tutorials point at the retired `noaa-goes16` bucket)
// detects TOTAL lightning, in-cloud included. That matters for the
// display's purpose: storms electrify aloft minutes before the first
// cloud-to-ground strike, so "does that incoming storm have lightning"
// gets answered earlier than any CG-only network could.
//
// SOURCE: the public `noaa-goes19` bucket, one ~320 KB netCDF-4 file per
// 20 seconds under `GLM-L2-LCFA/YYYY/DDD/HH/` (DDD = UTC day-of-year).
// Listed over plain HTTPS like the Level III buckets — keyless.
//
// DECODING: the files are HDF5, decoded with `h5wasm` (WebAssembly HDF5)
// — pure JS, no Python sidecar. Verified against a live file on
// 2026-08-12: `flash_lat` / `flash_lon` arrive as plain Float32Array
// (no scale/offset unpacking), with `flash_quality_flag` (0 = good) for
// filtering. GLM pixel resolution is ~8-14 km; this is a "storm is
// electrified" indicator, not a strike locator, and the client renders
// it accordingly.
//
// WINDOW ASSEMBLY: a rolling window (default 5 min ≈ 15 files) is kept
// as a per-file cache keyed by object key, so each poll only fetches the
// 1-3 files that appeared since the last one. The first request after a
// cold start pulls the whole window (~10-14 MB, fetched 6 at a time) —
// worth a few seconds once, free afterwards. Flashes are filtered to the
// caller's radius server-side so the JSON stays small.

const axios = require("axios");
const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { BoundedMap } = require("./boundedCache");

const SERVICE_NAME = "GOES GLM (lightning)";
const BUCKET_BASE = "https://noaa-goes19.s3.amazonaws.com";
const PREFIX = "GLM-L2-LCFA";
const API_TIMEOUT_MS = 15_000;

const WINDOW_MINUTES = 5;
// Per-file flash cache: ~15 files cover the window; 96 leaves generous
// headroom for clock skew and a window that straddles a list refresh.
const fileCache = new BoundedMap(96);
// Assembled-response cache — one 20 s product cadence means anything
// fresher than 20 s is identical anyway.
const RESPONSE_TTL_MS = 20 * 1000;
const responseCache = new BoundedMap(16);
// Cold-start fetch parallelism. 6 keeps first-call latency to a few
// seconds without hammering the bucket.
const FETCH_CONCURRENCY = 6;

// h5wasm loads once (WASM init is not free); the promise is shared.
let h5wasmReady = null;
function getH5() {
  if (!h5wasmReady) {
    h5wasmReady = import("h5wasm/node").then(async (mod) => {
      await mod.ready;
      return mod;
    });
  }
  return h5wasmReady;
}

/**
 * Parse the start-time token out of a GLM object key.
 * `OR_GLM-L2-LCFA_G19_s20262240134000_…` → epoch ms. The token is
 * sYYYYDDDHHMMSSt (t = tenths, ignored). UTC by definition.
 *
 * @param {String} key bucket object key
 * @returns {Number|null} epoch ms, or null when the key doesn't match
 */
function keyEpoch(key) {
  const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d/.exec(key || "");
  if (!m) return null;
  const [, y, doy, hh, mm, ss] = m;
  return Date.UTC(Number(y), 0, 1)
    + ((Number(doy) - 1) * 86400 + Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * 1000;
}

/**
 * Hour-prefix string for a Date, matching the bucket layout.
 *
 * @param {Date} t
 * @returns {String} e.g. "GLM-L2-LCFA/2026/224/01/"
 */
function hourPrefix(t) {
  const start = Date.UTC(t.getUTCFullYear(), 0, 1);
  const doy = Math.floor((t.getTime() - start) / 86400000) + 1;
  return `${PREFIX}/${t.getUTCFullYear()}/${String(doy).padStart(3, "0")}/`
    + `${String(t.getUTCHours()).padStart(2, "0")}/`;
}

/**
 * List every GLM key inside the window. Only queries the previous hour
 * prefix if the window actually crosses an hour boundary (during the first
 * minutes of an hour), halving S3 listing queries during normal operation.
 *
 * @param {Number} nowMs epoch ms
 * @returns {Promise<Array<String>>} keys newer than the window start
 */
async function listWindowKeys(nowMs) {
  const cutoff = nowMs - WINDOW_MINUTES * 60 * 1000;
  const curPrefix = hourPrefix(new Date(nowMs));
  const cutPrefix = hourPrefix(new Date(cutoff));
  const prefixes = curPrefix === cutPrefix ? [curPrefix] : [cutPrefix, curPrefix];
  const keys = [];
  for (const prefix of prefixes) {
    const res = await axios.get(BUCKET_BASE, {
      params: { "list-type": 2, prefix, "max-keys": 1000 },
      timeout: API_TIMEOUT_MS,
      responseType: "text",
    });
    for (const m of String(res.data).match(/<Key>([^<]+)<\/Key>/g) || []) {
      const key = m.replace(/<\/?Key>/g, "");
      const t = keyEpoch(key);
      if (t != null && t >= cutoff) keys.push(key);
    }
  }
  increment("glm", "list");
  return keys;
}

/**
 * Decode a GLM L2 LCFA buffer into quality-filtered flash points.
 * Split out from the fetch path so the committed fixture can exercise
 * the h5wasm decode offline.
 *
 * @param {Uint8Array} data raw file bytes
 * @returns {Promise<Array<Array<Number>>>} [lat, lon] pairs (quality 0 only)
 */
async function decodeGlmBuffer(data) {
  const h5 = await getH5();
  const { FS } = await h5.ready;
  // Unique scratch name per decode; removed afterwards so the in-memory
  // WASM filesystem doesn't grow without bound on an always-on server.
  const scratch = `glm-${Math.random().toString(36).slice(2)}.nc`;
  FS.writeFile(scratch, data);
  const flashes = [];
  try {
    const f = new h5.File(scratch, "r");
    try {
      const latDs = f.get("flash_lat");
      const lonDs = f.get("flash_lon");
      const qDs = f.get("flash_quality_flag");
      if (!latDs || !lonDs || !qDs) return flashes;
      const lat = latDs.value;
      const lon = lonDs.value;
      const q = qDs.value;
      if (!lat || !lon || !q) return flashes;
      for (let i = 0; i < lat.length; i += 1) {
        if (q[i] !== 0) continue;
        // 3 decimals is ~110 m — far below GLM's ~10 km pixel, and it
        // keeps the JSON payload tight.
        flashes.push([Number(lat[i].toFixed(3)), Number(lon[i].toFixed(3))]);
      }
    } finally {
      f.close();
    }
  } finally {
    try { FS.unlink(scratch); } catch { /* scratch may not exist on decode failure */ }
  }
  return flashes;
}

/**
 * Fetch + decode one GLM file into quality-filtered flash points.
 *
 * @param {String} key bucket object key
 * @returns {Promise<Array<Array<Number>>>} [lat, lon] pairs
 */
async function fetchFile(key) {
  const hit = fileCache.get(key);
  if (hit) return hit;

  const res = await axios.get(`${BUCKET_BASE}/${key}`, {
    responseType: "arraybuffer",
    timeout: API_TIMEOUT_MS,
  });
  increment("glm", "file");

  const flashes = await decodeGlmBuffer(new Uint8Array(res.data));
  fileCache.set(key, flashes);
  return flashes;
}

/**
 * Filter flash points to a radius around a centre, tagging each with the
 * file's age. Equirectangular distance — at 300 km scale the error is
 * far below one GLM pixel.
 *
 * @param {Array} entries [{epoch, flashes}] per file
 * @param {Number} lat centre latitude
 * @param {Number} lon centre longitude
 * @param {Number} radiusKm keep flashes within this range
 * @param {Number} nowMs epoch ms for age computation
 * @returns {Array<Array<Number>>} [lat, lon, ageSeconds] triples
 */
function filterFlashes(entries, lat, lon, radiusKm, nowMs) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const kmPerDegLat = 111.32;
  const out = [];
  for (const { epoch, flashes } of entries) {
    const ageSec = Math.max(0, Math.round((nowMs - epoch) / 1000));
    for (const [fla, flo] of flashes) {
      const dy = (fla - lat) * kmPerDegLat;
      const dx = (flo - lon) * kmPerDegLat * cosLat;
      if (dx * dx + dy * dy <= radiusKm * radiusKm) out.push([fla, flo, ageSec]);
    }
  }
  return out;
}

// Single-flight on window assembly: the kiosk plus a phone polling at
// the same moment must not both trigger a cold-start fetch burst.
let assembling = null;

/**
 * Assemble the rolling window (list keys, fetch what's missing).
 *
 * @param {Number} nowMs epoch ms
 * @returns {Promise<Array>} [{epoch, flashes}] entries, newest last
 */
async function assembleWindow(nowMs) {
  if (assembling) return assembling;
  assembling = (async () => {
    const keys = await listWindowKeys(nowMs);
    const missing = keys.filter((k) => !fileCache.get(k));
    for (let i = 0; i < missing.length; i += FETCH_CONCURRENCY) {
      await Promise.all(missing.slice(i, i + FETCH_CONCURRENCY).map((k) => fetchFile(k).catch(() => null)));
    }
    return keys
      .map((k) => ({ epoch: keyEpoch(k), flashes: fileCache.get(k) || [] }))
      .sort((a, b) => a.epoch - b.epoch);
  })();
  try {
    return await assembling;
  } finally {
    assembling = null;
  }
}

/**
 * GET /api/lightning?lat&lon&radiusKm=300
 *
 * Flash positions from the last WINDOW_MINUTES within the radius, each
 * as [lat, lon, ageSeconds]. The client fades markers by age.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getLightning(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json("Invalid coordinates").end();
  }
  let radiusKm = parseFloat(req.query.radiusKm);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) radiusKm = 300;
  radiusKm = Math.min(radiusKm, 800);

  const cacheKey = `${lat.toFixed(2)}:${lon.toFixed(2)}:${radiusKm}`;
  const hit = responseCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return res.status(200).json(hit.value).end();
  }

  try {
    const nowMs = Date.now();
    const entries = await assembleWindow(nowMs);
    const flashes = filterFlashes(entries, lat, lon, radiusKm, nowMs);
    const value = {
      available: true,
      windowMinutes: WINDOW_MINUTES,
      count: flashes.length,
      flashes,
      generatedAt: new Date(nowMs).toISOString(),
    };
    responseCache.set(cacheKey, { value, expires: Date.now() + RESPONSE_TTL_MS });
    recordServiceCall(SERVICE_NAME, 200, `${flashes.length} flash(es) in ${radiusKm} km`);
    return res.status(200).json(value).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, "lightning window failed");
    // 503 like the other feeds: the client keeps its last flashes,
    // aging out naturally, rather than blanking the overlay.
    return res.status(503).json({ available: false, flashes: [], reason: "upstream-unavailable" }).end();
  }
}

module.exports = {
  getLightning,
  // Exported for tests.
  decodeGlmBuffer,
  keyEpoch,
  hourPrefix,
  filterFlashes,
  fetchFile,
  WINDOW_MINUTES,
};
