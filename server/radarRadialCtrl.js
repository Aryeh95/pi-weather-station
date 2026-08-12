// Raw NEXRAD Level III super-res base reflectivity (N0B, product 153).
//
// WHY THIS EXISTS: the IEM `ridge::` tiles the map uses for the
// single-site layer are genuinely built from N0B, but IEM pre-renders
// them server-side onto a smoothed web-mercator raster — measured over an
// active storm, a z12 tile carried only 10 distinct colours and z13 just
// 5. No amount of tile tuning recovers detail the raster never carried.
// RadarScope looks sharper because it renders the raw radial data
// client-side. This controller serves that raw data: 720 radials × 0.5°,
// 1840 range bins × 250 m, real dBZ scaling — from the same public
// `unidata-nexrad-level3` bucket the storm-tracks feature already polls
// (`SSS_N0B_*` keys, one file per volume scan, ~160 KB).
//
// ── The product-153 shim ─────────────────────────────────────────────
// `nexrad-level-3-data` has no definition for product 153 and its
// whitelist rejects the `N0B` header token. But 153 (Super Resolution
// Digital Base Reflectivity) shares product 94's descriptor layout —
// same halfword fields, same Digital Radial Data Array packet (code 16)
// — so the shim below clones 94's definition and re-badges it. Verified
// against a live DIX file on 2026-08-12: elevation 0.5°, max dBZ
// matching the descriptor, plot scaling `min −32 / inc 0.5 / 254
// levels`. Worth upstreaming as a small PR someday; until then the
// registration happens once at module load.
//
// ── Payload design ───────────────────────────────────────────────────
// The client needs every bin (720 × 1840 = 1.3 M values), so shipping
// scaled floats as JSON numbers would be several MB of text. Instead the
// RAW byte levels (0–255, exactly as read from the file; 0–1 = below
// threshold / missing) go out as one base64 Uint8Array plus the scaling
// constants to decode them (`dBZ = min + level × increment` — the same
// formula the parser's own lookup table uses). ~1.7 MB base64 once per
// volume scan on a localhost/LAN kiosk.
//
// Radials are re-bucketed into fixed 0.5° azimuth slots before packing,
// so the client indexes `bins[bucket × numBins + bin]` straight from an
// azimuth without searching start angles.

const axios = require("axios");
const parseLevel3 = require("nexrad-level-3-data");
const level3Products = require("nexrad-level-3-data/src/products");
const product94 = require("nexrad-level-3-data/src/products/94");
const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { BoundedMap } = require("./boundedCache");
const { newestKey, BUCKET_BASE, API_TIMEOUT_MS } = require("./stormTracksCtrl");

const SERVICE_NAME = "NEXRAD L3 (radial)";

// Register product 153 once. Mutating the library's exported tables is
// blunt but deliberate — it is exactly how the library's own products
// register themselves, and it keeps the shim in one findable place.
if (!level3Products.products["153"]) {
  level3Products.products["153"] = {
    ...product94,
    code: 153,
    abbreviation: ["N0B", "N1B", "N2B", "N3B"],
    description: "Super Resolution Digital Base Reflectivity",
  };
  level3Products.productAbbreviations.push("N0B", "N1B", "N2B", "N3B");
}

// One product per volume scan (4-6 min); 60 s matches the other radar caches.
const RADIAL_TTL_MS = 60 * 1000;
const radialCache = new BoundedMap(8);

// N0B geometry per the product spec. The packet's `rangeScale` field is a
// display scale factor (reads ~0.999), NOT the physical bin size — that
// is fixed at 0.25 km for super-res, and 1840 bins × 0.25 km = 460 km,
// exactly the documented super-res reflectivity range.
const BIN_KM = 0.25;
const BUCKET_DEG = 0.5;
const NUM_BUCKETS = 360 / BUCKET_DEG;

/**
 * Re-bucket radials into fixed azimuth slots and flatten to one byte
 * array. Radials arrive in scan order with arbitrary start angles; the
 * client wants O(1) lookup by azimuth. Slots that no radial covers stay
 * zero-filled (= no data), which is also the correct rendering for them.
 *
 * @param {Array<Object>} radialsRaw parser's `radialsRaw` (raw byte bins)
 * @param {Number} numBins bins per radial
 * @returns {Buffer} NUM_BUCKETS × numBins raw levels
 */
function packRadials(radialsRaw, numBins) {
  const out = Buffer.alloc(NUM_BUCKETS * numBins);
  for (const radial of radialsRaw || []) {
    const bucket = Math.floor((((radial.startAngle % 360) + 360) % 360) / BUCKET_DEG);
    const base = bucket * numBins;
    const bins = radial.bins || [];
    const n = Math.min(bins.length, numBins);
    for (let i = 0; i < n; i += 1) out[base + i] = bins[i];
  }
  return out;
}

/**
 * Fetch + decode the newest N0B radial product for a site.
 *
 * @param {String} site 3-letter radar id
 * @returns {Promise<Object>} payload for /api/radar/radial
 */
async function fetchRadial(site) {
  const hit = radialCache.get(site);
  if (hit && hit.expires > Date.now()) return hit.value;

  const key = await newestKey(site, "N0B");
  increment("nexrad-l3", "radial-list");
  if (!key) {
    // No recent N0B in the bucket for this site — the client falls back
    // to the IEM tiles, so this is a soft state, not an error.
    const empty = { available: false, site, reason: "no-recent-product" };
    radialCache.set(site, { value: empty, expires: Date.now() + RADIAL_TTL_MS });
    recordServiceCall(SERVICE_NAME, 200, `no recent N0B for ${site}`);
    return empty;
  }

  const res = await axios.get(`${BUCKET_BASE}/${key}`, {
    responseType: "arraybuffer",
    timeout: API_TIMEOUT_MS,
  });
  increment("nexrad-l3", "radial-product");

  const parsed = parseLevel3(Buffer.from(res.data));
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
    key,
    scanTime,
    radar: { lat: pd.latitude, lon: pd.longitude },
    elevationAngle: pd.elevationAngle,
    // Decode contract: level 0 and 1 are below-threshold/missing (render
    // transparent); level L ≥ 2 is `min + L × increment` dBZ — the same
    // table the parser builds internally for its scaled view.
    scaling: {
      min: pd.plot ? pd.plot.minimumDataValue : -32,
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
  radialCache.set(site, { value, expires: Date.now() + RADIAL_TTL_MS });
  recordServiceCall(SERVICE_NAME, 200, `${packet.radialsRaw.length} radials for ${site}`);
  return value;
}

/**
 * GET /api/radar/radial?site=DIX
 *
 * The raw-radial feed behind the client-side canvas renderer.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getRadarRadial(req, res) {
  const site = String(req.query.site || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(site)) {
    return res.status(400).json("Invalid or missing site").end();
  }
  try {
    const payload = await fetchRadial(site);
    return res.status(200).json(payload).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `radial failed for ${site}`);
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
  BIN_KM,
  NUM_BUCKETS,
  BUCKET_DEG,
};
