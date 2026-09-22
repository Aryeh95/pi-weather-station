// MRMS surface precipitation type — the low-zoom half of the rain / snow
// picture.
//
// The radar's own dual-pol classification (N0H, see radarRadialCtrl) says
// what the 0.5° beam is looking at, which 100 km out is ~1.5 km above the
// ground: snow aloft can melt on the way down. MRMS's PrecipFlag folds in
// model temperature profiles and reports the type AT THE SURFACE on a
// 1 km CONUS grid every two minutes, which is the "is it snowing where I
// stand" answer and the natural mosaic-band layer. PrecipRate from the
// same system supplies intensity, so the mosaic shades light → heavy the
// way the single-site layer does.
//
// Verified live 2026-09-16 (both decode through mrmsHailCtrl's GRIB2 PNG
// path unchanged):
//
//   PrecipFlag  8-bit PNG, ref −3, bin 0, dec 0 → value = X − 3
//               values seen: 0 none, 1 warm stratiform, 3 snow (four gates,
//               all in the high Canadian Rockies near Banff — plausible in
//               mid-September), 6 convective, 7 hail, 10 cool stratiform,
//               91 / 96 tropical; −3 no coverage
//   PrecipRate  16-bit PNG, ref −30, bin 0, dec 1 → mm/h = (X − 30) / 10
//
// Output: one byte per cell in the ./precipType encoding (class ‹‹ 4 |
// 5 dBZ tier), on a 2× subsampled grid (0.02°, ~2 km) — the flag is a type
// boundary, not a texture, and 2 km keeps the frame at ~290 KB of base64
// (measured: 851 KB at 1 km, 286 KB at 2 km) — run-length encoded. Each
// output cell takes the most intense typed input cell under it.

const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { latestKey, keyNearest, keyValidTime, fetchGrid } = require("./mrmsHailCtrl");
const { BoundedMap } = require("./boundedCache");
const precipType = require("./precipType");

const SERVICE_NAME = "MRMS (precip type)";
const PRODUCTS = {
  flag: "CONUS/PrecipFlag_00.00",
  rate: "CONUS/PrecipRate_00.00",
};
// Subsample factor over the 0.01° source grid.
const GRID_STEP = 2;
// New file every ~2 min; a built payload is immutable per file pair.
const PAYLOAD_TTL_MS = 10 * 60 * 1000;
// Type without a usable rate (the rate file failed or is missing): draw
// at a moderate tier rather than the faintest one, so a rate outage does
// not read as "drizzle everywhere" — and say so in `rate.available`.
const RATE_UNKNOWN_TIER = 5;
// The two products are written independently; tolerate the usual skew
// between the newest of each before calling the rate stale.
const RATE_SKEW_MAX_MS = 6 * 60 * 1000;

// A historical frame: the flag file nearest the requested stamp, within
// this window. MRMS writes every 2 min, so a 3-min window always finds the
// neighbour of an on-time stamp and refuses one that fell in an outage.
const STAMP_WINDOW_MS = 3 * 60 * 1000;

// Built payloads keyed by the flag file they came from — the newest one
// and the loop's history frames (11 mosaic offsets) share this.
const payloadCache = new BoundedMap(24);
const inflight = new Map();

/**
 * Reduce a PrecipFlag grid (+ optional PrecipRate grid) to encoded cells.
 *
 * @param {{g: Object, samples: Uint16Array}} flag decoded PrecipFlag
 * @param {{g: Object, samples: Uint16Array}|null} rate decoded PrecipRate, same grid, or null
 * @param {Number} [step] subsample factor
 * @returns {{grid: Object, cells: Uint8Array, drawn: Number}} output grid description + encoded cells
 */
function buildCells(flag, rate, step = GRID_STEP) {
  const fg = flag.g;
  if (rate && (rate.g.ni !== fg.ni || rate.g.nj !== fg.nj)) {
    throw new Error("PrecipRate grid does not match PrecipFlag");
  }
  const ni = Math.ceil(fg.ni / step);
  const nj = Math.ceil(fg.nj / step);
  const cells = new Uint8Array(ni * nj);
  // Flag value → class index, once per possible sample.
  const idxOfSample = new Uint8Array(256);
  for (let s = 0; s < 256; s += 1) {
    const idx = precipType.mrmsFlagClassIndex(fg.ref + s);
    idxOfSample[s] = precipType.isDrawnClass(idx) ? idx : 0;
  }
  const rateScale = rate ? (2 ** rate.g.binScale) / (10 ** rate.g.decScale) : 0;
  const rateOffset = rate ? rate.g.ref / (10 ** rate.g.decScale) : 0;
  const fs = flag.samples;
  const rs = rate ? rate.samples : null;
  let drawn = 0;
  for (let J = 0; J < nj; J += 1) {
    const j0 = J * step;
    const j1 = Math.min(fg.nj, j0 + step);
    for (let I = 0; I < ni; I += 1) {
      const i0 = I * step;
      const i1 = Math.min(fg.ni, i0 + step);
      let bestTier = 0;
      let bestIdx = 0;
      for (let j = j0; j < j1; j += 1) {
        const row = j * fg.ni;
        for (let i = i0; i < i1; i += 1) {
          const idx = idxOfSample[fs[row + i] & 255];
          if (!idx) continue;
          const tier = rs
            ? precipType.tierForRate(rateOffset + rs[row + i] * rateScale)
            : RATE_UNKNOWN_TIER;
          if (tier > bestTier) {
            bestTier = tier;
            bestIdx = idx;
          }
        }
      }
      if (bestTier) {
        cells[J * ni + I] = precipType.encodeGate(bestIdx, bestTier);
        drawn += 1;
      }
    }
  }
  // Cell centres: the source's first point is a cell centre at (lat0,
  // lon0); an output cell spans `step` source cells, so its centre sits
  // (step − 1) / 2 source cells further along.
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  let lon0 = fg.lon0 + ((step - 1) / 2) * fg.dLon;
  if (lon0 > 180) lon0 -= 360;
  const grid = {
    ni,
    nj,
    lat0: r6(fg.lat0 - ((step - 1) / 2) * fg.dLat),
    lon0: r6(lon0),
    dLat: r6(fg.dLat * step),
    dLon: r6(fg.dLon * step),
  };
  return { grid, cells, drawn };
}

/**
 * Build the payload for one flag file (+ its nearest rate file).
 *
 * @param {String} flagKey PrecipFlag bucket key
 * @param {String|null} [stamp] the frame stamp this answers, echoed back
 * @returns {Promise<Object>} payload for /api/radar/precip-mosaic
 */
async function buildPayloadFor(flagKey, stamp = null) {
  const hit = payloadCache.get(flagKey);
  if (hit && hit.expires > Date.now()) return stamp ? { ...hit.value, stamp } : hit.value;
  const flagEpochFromKey = Date.parse(keyValidTime(flagKey) || "");
  const [flag, rate] = await Promise.all([
    fetchGrid(flagKey, "precip-flag"),
    // The rate is the bonus: its failure must not take the type down. For
    // the newest frame it is the newest rate file; for a historical one,
    // the rate file nearest the flag's own time.
    (Number.isFinite(flagEpochFromKey)
      ? keyNearest(PRODUCTS.rate, flagEpochFromKey, RATE_SKEW_MAX_MS)
      : latestKey(PRODUCTS.rate))
      .then((k) => (k ? fetchGrid(k, "precip-rate") : null))
      .catch((err) => {
        recordServiceCall(SERVICE_NAME, err?.response?.status || 500, `PrecipRate unavailable: ${err.message}`);
        return null;
      }),
  ]);
  const flagEpoch = Date.parse(flag.validTime || "");
  const rateEpoch = rate ? Date.parse(rate.validTime || "") : NaN;
  const rateUsable = rate && Number.isFinite(rateEpoch) && Number.isFinite(flagEpoch)
    && Math.abs(rateEpoch - flagEpoch) <= RATE_SKEW_MAX_MS;
  const { grid, cells, drawn } = buildCells(flag, rateUsable ? rate : null);
  const value = {
    available: true,
    source: "MRMS",
    validTime: flag.validTime,
    key: flagKey.split("/").pop(),
    rate: {
      available: Boolean(rateUsable),
      validTime: rate ? rate.validTime : null,
      unknownTier: rateUsable ? null : RATE_UNKNOWN_TIER,
    },
    grid,
    tierDbz: precipType.TIER_DBZ,
    encoding: "rle8",
    drawn,
    data: Buffer.from(precipType.rleEncode(cells)).toString("base64"),
  };
  payloadCache.set(flagKey, { value, expires: Date.now() + PAYLOAD_TTL_MS });
  recordServiceCall(SERVICE_NAME, 200, `${drawn} typed cells in ${value.key}${rateUsable ? "" : " (no rate)"}`);
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
 * The payload for the newest frame, or for the frame nearest a stamp.
 *
 * @param {String|null} [stamp] "YYYYMMDDHHMM" UTC, or null for newest
 * @returns {Promise<Object>} payload for /api/radar/precip-mosaic
 */
async function buildPayload(stamp = null) {
  let flagKey;
  if (stamp) {
    flagKey = await keyNearest(PRODUCTS.flag, stampEpoch(stamp), STAMP_WINDOW_MS);
    if (!flagKey) {
      recordServiceCall(SERVICE_NAME, 200, `no PrecipFlag within ${STAMP_WINDOW_MS / 60000} min of ${stamp}`);
      return { available: false, source: "MRMS", stamp, reason: "no-matching-frame" };
    }
  } else {
    flagKey = await latestKey(PRODUCTS.flag);
    if (!flagKey) {
      recordServiceCall(SERVICE_NAME, 200, "no PrecipFlag in the bucket");
      return { available: false, source: "MRMS", reason: "no-recent-product" };
    }
  }
  return buildPayloadFor(flagKey, stamp);
}

/**
 * GET /api/radar/precip-mosaic[?stamp=YYYYMMDDHHMM]
 *
 * MRMS surface precipitation type over CONUS, 2 km cells, one byte per
 * cell in the shared class/tier encoding, run-length encoded. Without
 * `stamp`, the newest frame; with it, the frame nearest that UTC minute
 * (within 3 min) — how the low-zoom loop plays history. The whole grid is
 * small enough to ship and the client paints only its viewport from it.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getPrecipMosaic(req, res) {
  const stamp = req.query.stamp !== undefined ? String(req.query.stamp).trim() : null;
  if (stamp !== null && !Number.isFinite(stampEpoch(stamp))) {
    return res.status(400).json("Invalid stamp").end();
  }
  const flightKey = stamp || "latest";
  try {
    if (!inflight.has(flightKey)) {
      inflight.set(flightKey, buildPayload(stamp).finally(() => inflight.delete(flightKey)));
    }
    const payload = await inflight.get(flightKey);
    return res.status(200).json(payload).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `precip mosaic failed: ${err.message}`);
    return res.status(503).json({ available: false, source: "MRMS", reason: "upstream-unavailable" }).end();
  }
}

module.exports = {
  getPrecipMosaic,
  // Exported for tests.
  buildCells,
  stampEpoch,
  STAMP_WINDOW_MS,
  PRODUCTS,
  GRID_STEP,
  RATE_UNKNOWN_TIER,
  RATE_SKEW_MAX_MS,
};
