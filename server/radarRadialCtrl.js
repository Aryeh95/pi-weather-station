// Raw NEXRAD Level III super-res radial products: base reflectivity
// (N0B, product 153) and base velocity (N0G, product 154).
//
// WHY THIS EXISTS: the IEM `ridge::` tiles the map uses for the
// single-site layer are genuinely built from N0B, but IEM pre-renders
// them server-side onto a smoothed web-mercator raster — measured over an
// active storm, a z12 tile carried only 10 distinct colours and z13 just
// 5. No amount of tile tuning recovers detail the raster never carried.
// RadarScope looks sharper because it renders the raw radial data
// client-side. This controller serves that raw data: 720 radials × 0.5°,
// real physical scaling — from the same public `unidata-nexrad-level3`
// bucket the storm-tracks feature already polls (`SSS_N0B_*` /
// `SSS_N0G_*` keys, one file per volume scan, ~160-200 KB).
//
// ── The product shims ────────────────────────────────────────────────
// `nexrad-level-3-data` has no definition for products 153 or 154 and
// its whitelist rejects the `N0B` / `N0G` header tokens. Both share
// product 94's descriptor layout — same halfword fields, same Digital
// Radial Data Array packet (code 16) — so the shims below clone 94's
// definition and re-badge it. Verified against live DIX files:
//
//   153 / N0B (2026-08-12): elevation 0.5°, 1840 bins × 0.25 km, plot
//       scaling `min −32 / inc 0.5 / 254 levels` (dBZ).
//   154 / N0G (2026-09-03): elevation 0.5°, 1200 bins × 0.25 km, plot
//       scaling `min −63.5 / inc 0.5 / 254 levels` (m/s, negative =
//       toward the radar). Level 1 is RANGE FOLDED for velocity, not
//       merely "missing" — 23k RF gates in the verified file.
//
// Worth upstreaming as a small PR someday; until then the registration
// happens once at module load.
//
// ── Payload design ───────────────────────────────────────────────────
// The client needs every bin (720 × 1840 = 1.3 M values for N0B), so
// shipping scaled floats as JSON numbers would be several MB of text.
// Instead the RAW byte levels (0–255, exactly as read from the file;
// 0–1 = below threshold / missing / RF) go out as one base64 Uint8Array
// plus the scaling constants to decode them (`value = min + level ×
// increment` — the same formula the parser's own lookup table uses).
// ~1.7 MB base64 once per volume scan on a localhost/LAN kiosk.
//
// Radials are re-bucketed into fixed 0.5° azimuth slots before packing,
// so the client indexes `bins[bucket × numBins + bin]` straight from an
// azimuth without searching start angles.

const parseLevel3 = require("nexrad-level-3-data");
const level3Products = require("nexrad-level-3-data/src/products");
const product94 = require("nexrad-level-3-data/src/products/94");
const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { BoundedMap } = require("./boundedCache");
const { newestKey, listHourKeys, l3KeyEpoch, fetchObject } = require("./nexradBucket");

const SERVICE_NAME = "NEXRAD L3 (radial)";

// The two products this route serves, keyed by the IEM/bucket token the
// client asks for. `kind` and `units` travel in the payload so the
// renderer never has to infer them from the token.
const PRODUCTS = {
  N0B: {
    code: 153,
    kind: "reflectivity",
    units: "dBZ",
    abbreviations: ["N0B", "N1B", "N2B", "N3B"],
    description: "Super Resolution Digital Base Reflectivity",
    // Below-threshold and missing; nothing to draw.
    reservedLevels: 2,
  },
  N0G: {
    code: 154,
    kind: "velocity",
    units: "m/s",
    abbreviations: ["N0G", "N1G", "N2G", "N3G"],
    description: "Super Resolution Digital Base Velocity",
    // 0 = below threshold, 1 = range folded (drawn as RF, not skipped).
    reservedLevels: 2,
  },
};
const DEFAULT_PRODUCT = "N0B";

// Register the shims once. Mutating the library's exported tables is
// blunt but deliberate — it is exactly how the library's own products
// register themselves, and it keeps the shims in one findable place.
for (const def of Object.values(PRODUCTS)) {
  if (!level3Products.products[String(def.code)]) {
    level3Products.products[String(def.code)] = {
      ...product94,
      code: def.code,
      abbreviation: def.abbreviations,
      description: def.description,
    };
    level3Products.productAbbreviations.push(...def.abbreviations);
  }
}

// One product per volume scan (4-6 min); 60 s matches the other radar
// caches. Keyed `site:product`.
const RADIAL_TTL_MS = 60 * 1000;
const radialCache = new BoundedMap(16);

// Historical scans, keyed `site:product:stamp`. A completed volume scan
// is immutable, so the long TTL only bounds memory turnover, not
// staleness; 80 entries covers a full 30-frame loop of both products
// plus turnover as new scans land. Misses (no matching file) get a short
// TTL — the file may simply not have arrived in the bucket yet.
const HISTORY_TTL_MS = 30 * 60 * 1000;
const HISTORY_MISS_TTL_MS = 2 * 60 * 1000;
const historyCache = new BoundedMap(80);

// Super-res geometry per the product spec. The packet's `rangeScale`
// field is a display scale factor (reads ~0.999), NOT the physical bin
// size — that is fixed at 0.25 km for super-res: 1840 bins × 0.25 km =
// 460 km for N0B, 1200 × 0.25 = 300 km for N0G, exactly the documented
// ranges of the two products.
const BIN_KM = 0.25;
const BUCKET_DEG = 0.5;
const NUM_BUCKETS = 360 / BUCKET_DEG;

/**
 * Re-bucket radials into fixed azimuth slots and flatten to one byte
 * array.
 *
 * COVERAGE-BASED, not floor-based — and that distinction is visible on
 * screen. Real start angles don't land on 0.5° boundaries, so flooring
 * each radial into one slot lets two consecutive radials collide into
 * the same bucket and leaves the neighbouring bucket EMPTY — which
 * rendered as a transparent spoke from the radar out to the edge of
 * coverage (user-reported from the kiosk, 2026-08-11: dark lines
 * radiating across the storm). Instead, each radial is written to every
 * bucket whose CENTER its sweep [startAngle, startAngle + angleDelta)
 * actually covers; a continuous sweep then covers every bucket by
 * construction. Overlaps resolve last-wins, same as before.
 *
 * Buckets no radial covered (a sweep gap wider than half a bucket) are
 * filled from the nearest covered neighbour, up to ±4 buckets away.
 * The honesty line: a bucket the radar REPORTED (written, all zero —
 * genuinely no echo) is never touched; only buckets we had no radial
 * for are interpolated, which is the same nearest-radial lookup any
 * polar renderer does implicitly.
 *
 * @param {Array<Object>} radialsRaw parser's `radialsRaw` (raw byte bins)
 * @param {Number} numBins bins per radial
 * @returns {Buffer} NUM_BUCKETS × numBins raw levels
 */
function packRadials(radialsRaw, numBins) {
  const out = Buffer.alloc(NUM_BUCKETS * numBins);
  const written = new Uint8Array(NUM_BUCKETS);

  for (const radial of radialsRaw || []) {
    const start = ((radial.startAngle % 360) + 360) % 360;
    const delta = radial.angleDelta || BUCKET_DEG;
    // Buckets whose centre (b + 0.5) × BUCKET_DEG lies in [start, start + delta).
    const bStart = Math.ceil(start / BUCKET_DEG - 0.5);
    const bEnd = Math.ceil((start + delta) / BUCKET_DEG - 0.5);
    const bins = radial.bins || [];
    const n = Math.min(bins.length, numBins);
    for (let b = bStart; b < bEnd; b += 1) {
      const bucket = ((b % NUM_BUCKETS) + NUM_BUCKETS) % NUM_BUCKETS;
      const base = bucket * numBins;
      // Reset then copy — last-wins must not blend two radials when the
      // later one is shorter than the earlier.
      out.fill(0, base, base + numBins);
      for (let i = 0; i < n; i += 1) out[base + i] = bins[i];
      written[bucket] = 1;
    }
  }

  // Fill uncovered buckets from the nearest covered neighbour.
  for (let bucket = 0; bucket < NUM_BUCKETS; bucket += 1) {
    if (written[bucket]) continue;
    for (let d = 1; d <= 4; d += 1) {
      const lo = (bucket - d + NUM_BUCKETS) % NUM_BUCKETS;
      const hi = (bucket + d) % NUM_BUCKETS;
      const src = written[lo] ? lo : (written[hi] ? hi : -1);
      if (src >= 0) {
        out.copy(out, bucket * numBins, src * numBins, (src + 1) * numBins);
        break;
      }
    }
  }
  return out;
}

// IEM frame stamps carry minutes; bucket keys carry seconds, and the two
// clocks can disagree by a little (product header time vs file time).
// ±150 s is comfortably under half the fastest scan interval (~3 min
// measured live), so the nearest key inside the window is unambiguous.
const STAMP_MATCH_MS = 150 * 1000;

/**
 * Find the bucket key for the volume scan an IEM frame stamp names.
 *
 * The frame stamps come from the N0B frame list, but every product of
 * one volume scan shares its timestamp (verified live: `DIX_N0B_…_02_55_41`
 * and `DIX_N0G_…_02_55_41` sit side by side), so the same stamp resolves
 * a velocity key too.
 *
 * @param {String} site 3-letter radar id
 * @param {String} product bucket product token ("N0B" | "N0G")
 * @param {String} stamp "YYYYMMDDHHMM" UTC, as used in IEM tile URLs
 * @returns {Promise<String|null>} nearest key within the window, or null
 */
async function keyForStamp(site, product, stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m.map(Number);
  const target = Date.UTC(y, mo - 1, d, hh, mm);

  // The stamp's own hour, plus a neighbour when the minute sits close
  // enough to the boundary that the matching key could live next door.
  const hours = [new Date(target)];
  if (mm <= 2) hours.push(new Date(target - 60 * 60 * 1000));
  if (mm >= 57) hours.push(new Date(target + 60 * 60 * 1000));

  let best = null;
  let bestDelta = Infinity;
  const keyLists = await Promise.all(hours.map((t) => listHourKeys(site, product, t)));
  for (const keyList of keyLists) {
    for (const key of keyList) {
      const epoch = l3KeyEpoch(key);
      if (epoch === null) continue;
      const delta = Math.abs(epoch - target);
      if (delta <= STAMP_MATCH_MS && delta < bestDelta) {
        best = key;
        bestDelta = delta;
      }
    }
  }
  return best;
}

/**
 * Fetch + decode one radial file into the /api/radar/radial payload shape.
 *
 * @param {String} site 3-letter radar id
 * @param {String} product bucket product token ("N0B" | "N0G")
 * @param {String} key bucket object key
 * @returns {Promise<Object>} available:true payload
 */
async function decodeKey(site, product, key) {
  const def = PRODUCTS[product];
  const buf = await fetchObject(key);
  increment("nexrad-l3", "radial-product");

  const parsed = parseLevel3(buf);
  const pd = parsed.productDescription;
  const packet = parsed.radialPackets && parsed.radialPackets[0];
  if (!packet || !Array.isArray(packet.radialsRaw)) {
    throw new Error("product carried no radial packet");
  }

  const numBins = packet.numberBins;
  const scanTime = (Number.isFinite(pd.volumeScanDate) && Number.isFinite(pd.volumeScanTime))
    ? new Date(((pd.volumeScanDate - 1) * 86400 + pd.volumeScanTime) * 1000).toISOString()
    : null;

  const value = {
    available: true,
    site,
    product,
    kind: def.kind,
    units: def.units,
    key,
    scanTime,
    radar: { lat: pd.latitude, lon: pd.longitude },
    elevationAngle: pd.elevationAngle,
    // Decode contract: levels below `reservedLevels` are below-threshold
    // / missing (reflectivity) or below-threshold / range-folded
    // (velocity); level L ≥ 2 is `min + L × increment` in `units` — the
    // same table the parser builds internally for its scaled view.
    reservedLevels: def.reservedLevels,
    scaling: {
      min: pd.plot ? pd.plot.minimumDataValue : (def.kind === "velocity" ? -63.5 : -32),
      increment: pd.plot ? pd.plot.dataIncrement : 0.5,
      levels: pd.plot ? pd.plot.dataLevels : 254,
    },
    numBuckets: NUM_BUCKETS,
    bucketDeg: BUCKET_DEG,
    numBins,
    firstBinKm: (packet.firstBin || 0) * BIN_KM,
    binKm: BIN_KM,
    bins: packRadials(packet.radialsRaw, numBins).toString("base64"),
  };
  recordServiceCall(SERVICE_NAME, 200, `${packet.radialsRaw.length} ${product} radials for ${site}`);
  return value;
}

/**
 * Fetch + decode the newest radial product for a site.
 *
 * @param {String} site 3-letter radar id
 * @param {String} [product] bucket product token, default N0B
 * @returns {Promise<Object>} payload for /api/radar/radial
 */
async function fetchRadial(site, product = DEFAULT_PRODUCT) {
  const cacheKey = `${site}:${product}`;
  const hit = radialCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const key = await newestKey(site, product);
  increment("nexrad-l3", "radial-list");
  if (!key) {
    // No recent product in the bucket for this site — the client falls
    // back to the IEM tiles, so this is a soft state, not an error.
    const empty = { available: false, site, product, reason: "no-recent-product" };
    radialCache.set(cacheKey, { value: empty, expires: Date.now() + RADIAL_TTL_MS });
    recordServiceCall(SERVICE_NAME, 200, `no recent ${product} for ${site}`);
    return empty;
  }

  const value = await decodeKey(site, product, key);
  radialCache.set(cacheKey, { value, expires: Date.now() + RADIAL_TTL_MS });
  return value;
}

/**
 * Fetch + decode the scan matching an IEM frame stamp — the feed behind
 * sharp playback: the client renders each loop frame from raw radials
 * instead of IEM's smoothed historical tiles.
 *
 * @param {String} site 3-letter radar id
 * @param {String} stamp "YYYYMMDDHHMM" UTC
 * @param {String} [product] bucket product token, default N0B
 * @returns {Promise<Object>} payload for /api/radar/radial
 */
async function fetchRadialAtStamp(site, stamp, product = DEFAULT_PRODUCT) {
  const cacheKey = `${site}:${product}:${stamp}`;
  const hit = historyCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const key = await keyForStamp(site, product, stamp);
  increment("nexrad-l3", "radial-list");
  if (!key) {
    // Not in the bucket (yet, or ever — very old stamps age out of the
    // client's frame list anyway). Soft state: the client keeps showing
    // the IEM tile for that frame.
    const empty = { available: false, site, product, stamp, reason: "no-matching-product" };
    historyCache.set(cacheKey, { value: empty, expires: Date.now() + HISTORY_MISS_TTL_MS });
    recordServiceCall(SERVICE_NAME, 200, `no ${product} match for ${site}@${stamp}`);
    return empty;
  }

  const value = await decodeKey(site, product, key);
  value.stamp = stamp;
  historyCache.set(cacheKey, { value, expires: Date.now() + HISTORY_TTL_MS });
  return value;
}

/**
 * GET /api/radar/radial?site=DIX[&product=N0B|N0G][&stamp=YYYYMMDDHHMM]
 *
 * The raw-radial feed behind the client-side canvas renderer. Without
 * `stamp`, the newest scan; with it, the historical scan matching that
 * IEM frame stamp (used to render loop playback sharp). `product`
 * selects reflectivity (default) or velocity.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getRadarRadial(req, res) {
  const site = String(req.query.site || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(site)) {
    return res.status(400).json("Invalid or missing site").end();
  }
  const product = String(req.query.product || DEFAULT_PRODUCT).trim().toUpperCase();
  if (!PRODUCTS[product]) {
    return res.status(400).json("Invalid product").end();
  }
  const stamp = req.query.stamp !== undefined ? String(req.query.stamp).trim() : null;
  if (stamp !== null && !/^\d{12}$/.test(stamp)) {
    return res.status(400).json("Invalid stamp").end();
  }
  try {
    const payload = stamp
      ? await fetchRadialAtStamp(site, stamp, product)
      : await fetchRadial(site, product);
    return res.status(200).json(payload).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `${product} radial failed for ${site}`);
    // 503 like the other radar feeds: the client keeps its last rendered
    // frame (or the IEM tile fallback) instead of blanking the radar.
    return res.status(503).json({ available: false, reason: "upstream-unavailable" }).end();
  }
}

module.exports = {
  getRadarRadial,
  // Exported for tests.
  packRadials,
  fetchRadial,
  fetchRadialAtStamp,
  keyForStamp,
  PRODUCTS,
  BIN_KM,
  NUM_BUCKETS,
  BUCKET_DEG,
};
