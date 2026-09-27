// MRMS rainfall accumulation over CONUS — the low-zoom half of the
// accumulation mode. The single-radar products (DAA / DU3 / DTA) stop at
// 230 km and see one radar's beam; MRMS RadarOnly_QPE blends every radar
// in range onto a 1 km grid every 2 min, so at mosaic zoom the picture
// keeps going past the home radar's edge and across the gaps between
// radars. Radar-only (not the gauge-corrected MultiSensor passes) so it
// is as fresh as the radar layer it sits under; the 1-hour and 3-hour
// products are published, storm total has no MRMS equivalent.
//
// Decodes through the hail controller's GRIB2 PNG path unchanged. The
// field is reduced to 2 km cells (max of each 2 × 2) and re-encoded to one
// byte per cell on the geometric depth ladder in accumulation.js, then
// run-length encoded — ~50–150 KB of base64 on a wet day. The client
// paints its viewport from it (PrecipMosaicLayer with the accumulation
// LUT).

const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { latestKey, keyNearest, keyValidTime, fetchGrid } = require("./mrmsHailCtrl");
const { BoundedMap } = require("./boundedCache");
const precipType = require("./precipType");
const accumulation = require("./accumulation");

const SERVICE_NAME = "MRMS (rainfall)";
const PRODUCTS = {
  60: "CONUS/RadarOnly_QPE_01H_00.00",
  180: "CONUS/RadarOnly_QPE_03H_00.00",
};
// Subsample factor over the 0.01° source grid.
const GRID_STEP = 2;
// New file every ~2 min; a built payload is immutable per file.
const PAYLOAD_TTL_MS = 10 * 60 * 1000;
// A historical frame: the file nearest the requested stamp, within this.
const STAMP_WINDOW_MS = 3 * 60 * 1000;

const payloadCache = new BoundedMap(24);
const inflight = new Map();

/**
 * Reduce a decoded QPE grid (mm) to encoded 2 km cells.
 *
 * @param {{g: Object, samples: Uint16Array}} qpe decoded field
 * @param {Number} [step] subsample factor
 * @returns {{grid: Object, cells: Uint8Array, drawn: Number, maxIn: Number}}
 */
function buildCells(qpe, step = GRID_STEP) {
  const { g, samples } = qpe;
  const scale = (2 ** g.binScale) / (10 ** g.decScale);
  const offset = g.ref / (10 ** g.decScale);
  const ni = Math.ceil(g.ni / step);
  const nj = Math.ceil(g.nj / step);
  const cells = new Uint8Array(ni * nj);
  // Sample value → tier, once per possible 16-bit sample is too big a
  // table (65 536) to be worth it against 12 M lookups; compute inline.
  let drawn = 0;
  let maxIn = 0;
  for (let J = 0; J < nj; J += 1) {
    const j0 = J * step;
    const j1 = Math.min(g.nj, j0 + step);
    for (let I = 0; I < ni; I += 1) {
      const i0 = I * step;
      const i1 = Math.min(g.ni, i0 + step);
      let best = 0;
      for (let j = j0; j < j1; j += 1) {
        const row = j * g.ni;
        for (let i = i0; i < i1; i += 1) {
          const v = samples[row + i];
          if (v > best) best = v;
        }
      }
      const mm = offset + best * scale;
      if (mm <= 0) continue;
      const inches = mm / accumulation.MM_PER_IN;
      const tier = accumulation.tierForDepth(inches);
      if (!tier) continue;
      cells[J * ni + I] = tier;
      drawn += 1;
      if (inches > maxIn) maxIn = inches;
    }
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  let lon0 = g.lon0 + ((step - 1) / 2) * g.dLon;
  if (lon0 > 180) lon0 -= 360;
  return {
    grid: {
      ni,
      nj,
      lat0: r6(g.lat0 - ((step - 1) / 2) * g.dLat),
      lon0: r6(lon0),
      dLat: r6(g.dLat * step),
      dLon: r6(g.dLon * step),
    },
    cells,
    drawn,
    maxIn: Math.round(maxIn * 100) / 100,
  };
}

/**
 * Build (or reuse) the payload for one QPE file.
 *
 * @param {Number} periodMin 60 | 180
 * @param {String} key bucket key
 * @param {String|null} stamp the requested stamp, echoed back
 * @returns {Promise<Object>}
 */
async function buildPayloadFor(periodMin, key, stamp = null) {
  const hit = payloadCache.get(key);
  if (hit && hit.expires > Date.now()) return stamp ? { ...hit.value, stamp } : hit.value;
  const qpe = await fetchGrid(key, "qpe");
  const { grid, cells, drawn, maxIn } = buildCells(qpe);
  const value = {
    available: true,
    source: "MRMS",
    product: PRODUCTS[periodMin].split("/")[1].replace(/_00\.00$/, ""),
    periodMin,
    validTime: qpe.validTime,
    key: key.split("/").pop(),
    grid,
    encoding: "rle8",
    tiers: { minIn: accumulation.MIN_DEPTH_IN, topIn: accumulation.TOP_DEPTH_IN, max: accumulation.TIER_MAX },
    drawn,
    maxIn,
    data: Buffer.from(precipType.rleEncode(cells)).toString("base64"),
  };
  payloadCache.set(key, { value, expires: Date.now() + PAYLOAD_TTL_MS });
  recordServiceCall(SERVICE_NAME, 200, `${drawn} wet cells (max ${maxIn} in) in ${value.key}`);
  return stamp ? { ...value, stamp } : value;
}

/**
 * Parse a "YYYYMMDDHHMM" UTC frame stamp.
 *
 * @param {String} stamp 12 digits
 * @returns {Number} epoch ms, NaN when malformed
 */
function stampEpoch(stamp) {
  if (!/^\d{12}$/.test(stamp || "")) return NaN;
  return Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12));
}

/**
 * The payload for the newest frame of a period, or the frame nearest a stamp.
 *
 * @param {Number} periodMin
 * @param {String|null} [stamp]
 * @returns {Promise<Object>}
 */
async function buildPayload(periodMin, stamp = null) {
  const product = PRODUCTS[periodMin];
  let key;
  if (stamp) {
    key = await keyNearest(product, stampEpoch(stamp), STAMP_WINDOW_MS);
    if (!key) {
      recordServiceCall(SERVICE_NAME, 200, `no ${product.split("/")[1]} within ${STAMP_WINDOW_MS / 60000} min of ${stamp}`);
      return { available: false, source: "MRMS", periodMin, stamp, reason: "no-matching-frame" };
    }
  } else {
    key = await latestKey(product);
    if (!key) {
      recordServiceCall(SERVICE_NAME, 200, `no ${product.split("/")[1]} in the bucket`);
      return { available: false, source: "MRMS", periodMin, reason: "no-recent-product" };
    }
  }
  return buildPayloadFor(periodMin, key, stamp);
}

/**
 * GET /api/radar/qpe-mosaic?period=60|180[&stamp=YYYYMMDDHHMM]
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getQpeMosaic(req, res) {
  const periodMin = parseInt(req.query.period || "60", 10);
  if (!PRODUCTS[periodMin]) return res.status(400).json("Invalid period").end();
  const stamp = req.query.stamp !== undefined ? String(req.query.stamp).trim() : null;
  if (stamp !== null && !Number.isFinite(stampEpoch(stamp))) {
    return res.status(400).json("Invalid stamp").end();
  }
  const flightKey = `${periodMin}:${stamp || "latest"}`;
  try {
    if (!inflight.has(flightKey)) {
      inflight.set(flightKey, buildPayload(periodMin, stamp).finally(() => inflight.delete(flightKey)));
    }
    const payload = await inflight.get(flightKey);
    return res.status(200).json(payload).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `QPE mosaic failed: ${err.message}`);
    return res.status(503).json({ available: false, source: "MRMS", reason: "upstream-unavailable" }).end();
  }
}

module.exports = {
  getQpeMosaic,
  // Exported for tests.
  buildCells,
  stampEpoch,
  keyValidTime,
  PRODUCTS,
  GRID_STEP,
  STAMP_WINDOW_MS,
};
