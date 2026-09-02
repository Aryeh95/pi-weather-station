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
const { newestKey, l3KeyEpoch, BUCKET_BASE, API_TIMEOUT_MS } = require("./stormTracksCtrl");

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

// Historical scans, keyed `site:stamp`. A completed volume scan is
// immutable, so the long TTL only bounds memory turnover, not staleness;
// 40 entries covers a full 30-frame loop plus turnover as new scans land.
// Misses (no matching file) get a short TTL — the file may simply not
// have arrived in the bucket yet.
const HISTORY_TTL_MS = 30 * 60 * 1000;
const HISTORY_MISS_TTL_MS = 2 * 60 * 1000;
const historyCache = new BoundedMap(40);

// N0B geometry per the product spec. The packet's `rangeScale` field is a
// display scale factor (reads ~0.999), NOT the physical bin size — that
// is fixed at 0.25 km for super-res, and 1840 bins × 0.25 km = 460 km,
// exactly the documented super-res reflectivity range.
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

// Hour-listing cache to avoid redundant S3 list queries during historical
// loop warmups. Current UTC hour uses 60s TTL; past closed hours are
// immutable and cached for 1 hour.
const HOUR_KEYS_TTL_MS = 60 * 1000;
const PAST_HOUR_KEYS_TTL_MS = 60 * 60 * 1000;
const hourKeysCache = new BoundedMap(32);

/**
 * List every N0B key for one UTC hour. Same hour-scoped prefix trick the
 * storm-tracks poller uses — keeps the listing at a dozen keys instead
 * of a full day's ~300.
 *
 * @param {String} site 3-letter radar id
 * @param {Date} t any time inside the wanted UTC hour
 * @returns {Promise<Array<String>>} bucket keys, lexicographic (= chronological)
 */
async function listHourKeys(site, t) {
  const p = `${site}_N0B_${t.getUTCFullYear()}_`
    + `${String(t.getUTCMonth() + 1).padStart(2, "0")}_`
    + `${String(t.getUTCDate()).padStart(2, "0")}_`
    + `${String(t.getUTCHours()).padStart(2, "0")}`;
  const hit = hourKeysCache.get(p);
  if (hit && hit.expires > Date.now()) return hit.value;

  const res = await axios.get(BUCKET_BASE, {
    params: { "list-type": 2, prefix: p, "max-keys": 1000 },
    timeout: API_TIMEOUT_MS,
    responseType: "text",
  });
  const keys = (String(res.data).match(/<Key>([^<]+)<\/Key>/g) || [])
    .map((k) => k.replace(/<\/?Key>/g, ""));

  const isCurrentHour = Math.abs(Date.now() - t.getTime()) < 60 * 60 * 1000
    && new Date().getUTCHours() === t.getUTCHours();
  const ttl = isCurrentHour ? HOUR_KEYS_TTL_MS : PAST_HOUR_KEYS_TTL_MS;
  hourKeysCache.set(p, { value: keys, expires: Date.now() + ttl });
  return keys;
}

// IEM frame stamps carry minutes; bucket keys carry seconds, and the two
// clocks can disagree by a little (product header time vs file time).
// ±150 s is comfortably under half the fastest scan interval (~3 min
// measured live), so the nearest key inside the window is unambiguous.
const STAMP_MATCH_MS = 150 * 1000;

/**
 * Find the bucket key for the volume scan an IEM frame stamp names.
 *
 * @param {String} site 3-letter radar id
 * @param {String} stamp "YYYYMMDDHHMM" UTC, as used in IEM tile URLs
 * @returns {Promise<String|null>} nearest key within the window, or null
 */
async function keyForStamp(site, stamp) {
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
  const keyLists = await Promise.all(hours.map((t) => listHourKeys(site, t)));
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
 * Fetch + decode one N0B file into the /api/radar/radial payload shape.
 *
 * @param {String} site 3-letter radar id
 * @param {String} key bucket object key
 * @returns {Promise<Object>} available:true payload
 */
async function decodeKey(site, key) {
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
  recordServiceCall(SERVICE_NAME, 200, `${packet.radialsRaw.length} radials for ${site}`);
  return value;
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

  const value = await decodeKey(site, key);
  radialCache.set(site, { value, expires: Date.now() + RADIAL_TTL_MS });
  return value;
}

/**
 * Fetch + decode the N0B scan matching an IEM frame stamp — the feed
 * behind sharp playback: the client renders each loop frame from raw
 * radials instead of IEM's smoothed historical tiles.
 *
 * @param {String} site 3-letter radar id
 * @param {String} stamp "YYYYMMDDHHMM" UTC
 * @returns {Promise<Object>} payload for /api/radar/radial
 */
async function fetchRadialAtStamp(site, stamp) {
  const cacheKey = `${site}:${stamp}`;
  const hit = historyCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const key = await keyForStamp(site, stamp);
  increment("nexrad-l3", "radial-list");
  if (!key) {
    // Not in the bucket (yet, or ever — very old stamps age out of the
    // client's frame list anyway). Soft state: the client keeps showing
    // the IEM tile for that frame.
    const empty = { available: false, site, stamp, reason: "no-matching-product" };
    historyCache.set(cacheKey, { value: empty, expires: Date.now() + HISTORY_MISS_TTL_MS });
    recordServiceCall(SERVICE_NAME, 200, `no N0B match for ${site}@${stamp}`);
    return empty;
  }

  const value = await decodeKey(site, key);
  value.stamp = stamp;
  historyCache.set(cacheKey, { value, expires: Date.now() + HISTORY_TTL_MS });
  return value;
}

/**
 * GET /api/radar/radial?site=DIX[&stamp=YYYYMMDDHHMM]
 *
 * The raw-radial feed behind the client-side canvas renderer. Without
 * `stamp`, the newest scan; with it, the historical scan matching that
 * IEM frame stamp (used to render loop playback sharp).
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getRadarRadial(req, res) {
  const site = String(req.query.site || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(site)) {
    return res.status(400).json("Invalid or missing site").end();
  }
  const stamp = req.query.stamp !== undefined ? String(req.query.stamp).trim() : null;
  if (stamp !== null && !/^\d{12}$/.test(stamp)) {
    return res.status(400).json("Invalid stamp").end();
  }
  try {
    const payload = stamp ? await fetchRadialAtStamp(site, stamp) : await fetchRadial(site);
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
  fetchRadialAtStamp,
  keyForStamp,
  BIN_KM,
  NUM_BUCKETS,
  BUCKET_DEG,
};
