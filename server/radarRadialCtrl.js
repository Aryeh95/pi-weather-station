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
const precipType = require("./precipType");

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
  // Dual-pol correlation coefficient — RadarScope's "Super-Res Correlation
  // Coefficient". Product 161 shares 94's radial layout (the shim decodes
  // it: verified live LWX 2026-09-22, 360 radials × 1°, 1200 bins × 0.25
  // km), but NOT its scaling halfwords: the dual-pol products carry a
  // float SCALE and OFFSET at halfwords 31-34 (read 300 / −60.5 live), so
  // value = (level − offset) / scale, and the 94-layout `plot` fields read
  // garbage for it (`min 1730.2, increment 0`). See dualPolScaling().
  N0C: {
    code: 161,
    kind: "correlation",
    units: "ratio",
    abbreviations: ["N0C", "N1C", "N2C", "N3C"],
    description: "Digital Correlation Coefficient",
    // 0 = below threshold, 1 = range folded (drawn as RF, not skipped).
    reservedLevels: 2,
    dualPolScaling: true,
  },
  // Dual-pol hydrometeor classification. Not a shim: the library ships a
  // definition for 165, so this entry only names the product for the
  // route and the cleaner. Levels are CLASS CODES, not a linear scale —
  // hence the fixed scaling block, which would otherwise be read from a
  // `plot` descriptor that carries no minimum for this product.
  N0H: {
    code: 165,
    kind: "classification",
    units: "class",
    abbreviations: ["N0H", "N1H", "N2H", "N3H"],
    description: "Hydrometeor Classification",
    // 0 = below threshold; every other level is a class code.
    reservedLevels: 1,
    scaling: { min: 0, increment: 1, levels: 16 },
  },
};
const DEFAULT_PRODUCT = "N0B";
// The classification the dual-pol clean mode reads its verdict from.
const CLASS_PRODUCT = "N0H";
// Virtual product: the precipitation-type picture, N0H's class per gate
// combined with N0B's intensity for the same volume scan (see
// fetchPrecipType). Not a bucket product — deliberately outside PRODUCTS
// so the shim loop below never registers it with the parser.
const PRECIP_PRODUCT = "PTYPE";

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
// Dual-pol clean asked for but the classification was not in the bucket
// yet. Measured 2026-09-06 on LWX: N0H lands about 30 s after the N0B of
// the same scan (01:51:13 / 01:51:44), so a poll can fall between them.
// Caching that gap for the full minute would hold the unmasked frame long
// after the mask became possible.
const CLEAN_PENDING_TTL_MS = 15 * 1000;
// Reasons worth retrying soon; a grid mismatch will not fix itself.
const CLEAN_TRANSIENT = new Set(["no-classification", "classification-failed"]);
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
  return keyForEpoch(site, product, Date.UTC(y, mo - 1, d, hh, mm));
}

/**
 * Find the key for the volume scan nearest a UTC instant.
 *
 * The stamp form above rounds to the minute; this one keeps seconds,
 * which is what pairs one product of a scan with another (every product
 * of a volume scan is written with the same second).
 *
 * @param {String} site 3-letter radar id
 * @param {String} product bucket product token
 * @param {Number} target epoch ms
 * @returns {Promise<String|null>} nearest key within the window, or null
 */
async function keyForEpoch(site, product, target) {
  const mm = new Date(target).getUTCMinutes();

  // The target's own hour, plus a neighbour when the minute sits close
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
/**
 * Scaling for the dual-pol products (159 ZDR, 161 CC, 163 KDP), whose
 * product description carries a float scale at halfwords 31-32 and a float
 * offset at 33-34: value = (level − offset) / scale. Expressed in this
 * route's `min + level × increment` contract.
 *
 * The bucket object may start with a WMO / AWIPS text header ("SDUS81 KLWX
 * 220631\r\r\nN0CLWX\r\r\n", 30 bytes live), so the message start is found
 * by its own first halfword: the product code, followed by a plausible
 * modified-Julian date.
 *
 * @param {Buffer} buf the raw bucket object
 * @param {Number} code product code (e.g. 161)
 * @returns {{min: Number, increment: Number, levels: Number, dualPol: {scale: Number, offset: Number}}}
 */
function dualPolScaling(buf, code) {
  let start = -1;
  for (let i = 0; i + 68 <= buf.length && i < 256; i += 1) {
    if (buf.readUInt16BE(i) !== code) continue;
    const date = buf.readUInt16BE(i + 2);
    if (date > 10000 && date < 40000) {
      start = i;
      break;
    }
  }
  if (start < 0) throw new Error("dual-pol message start not found");
  // Halfword n sits (n − 1) × 2 bytes into the message.
  const scale = buf.readFloatBE(start + 60);
  const offset = buf.readFloatBE(start + 64);
  if (!(scale > 0) || !Number.isFinite(offset)) throw new Error(`dual-pol scaling unreadable (${scale}, ${offset})`);
  return { min: -offset / scale, increment: 1 / scale, levels: 254, dualPol: { scale, offset } };
}

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
    scaling: def.scaling || (def.dualPolScaling ? dualPolScaling(buf, def.code) : {
      min: pd.plot ? pd.plot.minimumDataValue : (def.kind === "velocity" ? -63.5 : -32),
      increment: pd.plot ? pd.plot.dataIncrement : 0.5,
      levels: pd.plot ? pd.plot.dataLevels : 254,
    }),
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

// ── Dual-pol clean ────────────────────────────────────────────────────
// A reflectivity threshold cannot separate insects from drizzle: both
// live at 15-25 dBZ. Dual-pol can, and the NWS already does it at the
// radar site and publishes the answer as its own Level III product, so
// this reads that verdict rather than classifying anything itself.
//
// Class codes are the product's own data levels (see the library's
// products/165 key). Measured against LWX 2026-09-06T01:29:38Z, a
// nocturnal bloom filling the whole disc:
//
//   BI biological   68.2% of drawn gates   median 19.5 dBZ, 56 km
//   BD "big drops"  26.9%                  median 19.5 dBZ, 67 km
//   RA light rain    1.9%                  median   22 dBZ, 126 km
//   GC clutter       0.3%                  median   20 dBZ, 12.5 km
//
// BI and BD are one population there — same median, same p95, same range
// band. The classifier splits the bloom because insects and genuine big
// drops share a high differential reflectivity. What separates them is
// intensity: real big drops live in convective cores, and only 59 of
// 71 803 BD gates in that scan (0.08%) reached 30 dBZ. So BD is masked
// only when it is weak, which keeps the real thing when a core makes it.
const CLASS_BIOLOGICAL = 10;
const CLASS_GROUND_CLUTTER = 20;
const CLASS_BIG_DROPS = 80;
const CLASS_UNKNOWN = 140;
// Always non-meteorological.
const MASK_CLASSES = new Set([CLASS_BIOLOGICAL, CLASS_GROUND_CLUTTER, CLASS_UNKNOWN]);
// Masked only below this reflectivity.
const BIG_DROPS_RAIN_MIN_DBZ = 30;
// The clear-air floor, applied HERE in clean mode — but only to gates the
// classifier has no verdict on (ND, range folded, and everything beyond
// the classification's 300 km reach). A gate the classifier calls
// precipitation draws at any intensity: measured 2026-09-22 at 04:00 Z,
// LWX / OKX / DIX each had ~45 000 rain-classified gates UNDER 15 dBZ
// against ~50 000 above it — the floor was hiding half the light rain —
// while at radars with no rain (FFC, GRR, ILN) the classifier called only
// 49–144 sub-15 dBZ gates rain out of ~200 000 echo gates. The verdict is
// trustworthy at low reflectivity; the floor is redundant where it exists.
// Must equal the client's NOISE_FILTER_MIN_DBZ (radialRender.js), which
// still applies to tiles and to scans with no classification.
const CLEAN_FLOOR_DBZ = 15;
const CLASS_NO_DATA = 0;
const CLASS_RANGE_FOLDED = 150;

/**
 * Blank the gates a dual-pol classification calls non-meteorological.
 *
 * Mutates nothing: returns a new bins buffer plus a report of what it
 * did. Geometry is checked rather than assumed — the two products are
 * re-bucketed to the same 0.5° slots and 0.25 km gates by packRadials,
 * but a mismatch would paint a stencil in the wrong place, so a
 * mismatch means no mask at all.
 *
 * The clear-air floor moves in here too: gates with NO verdict — class
 * ND, range folded, or past the classification's 300 km reach where
 * reflectivity still has 160 km of data — are dropped below `floorDbz`,
 * so the client can skip its own floor and let classified light rain
 * through. A verdict of precipitation is drawn at any intensity.
 *
 * @param {Object} refl decoded N0B payload
 * @param {Object} cls decoded N0H payload
 * @param {Number} [floorDbz] floor for unclassified gates (CLEAN_FLOOR_DBZ)
 * @returns {{bins: Buffer, masked: Number, considered: Number, floored: Number}}
 *   `considered` counts only echo gates the classification had a verdict
 *   for, so `masked / considered` reads as "of what could be judged, how
 *   much was not weather" instead of being diluted by the unjudgeable
 *   outer ring; `floored` counts the verdict-less gates the floor removed.
 */
function applyClassMask(refl, cls, floorDbz = CLEAN_FLOOR_DBZ) {
  const bins = Buffer.from(refl.bins, "base64");
  const cbins = Buffer.from(cls.bins, "base64");
  const out = Buffer.from(bins);
  // Level → below the big-drops rain floor? below the clear-air floor?
  const weak = new Uint8Array(256);
  const faint = new Uint8Array(256);
  for (let level = 0; level < 256; level += 1) {
    const dbz = refl.scaling.min + level * refl.scaling.increment;
    weak[level] = dbz < BIG_DROPS_RAIN_MIN_DBZ ? 1 : 0;
    faint[level] = dbz < floorDbz ? 1 : 0;
  }
  let masked = 0;
  let considered = 0;
  let floored = 0;
  const nb = refl.numBins;
  const cnb = cls.numBins;
  const buckets = Math.min(refl.numBuckets, cls.numBuckets);
  const span = Math.min(nb, cnb);
  for (let a = 0; a < buckets; a += 1) {
    const rowR = a * nb;
    const rowC = a * cnb;
    for (let b = 0; b < nb; b += 1) {
      const level = bins[rowR + b];
      if (level < refl.reservedLevels) continue;
      const code = b < span ? cbins[rowC + b] : CLASS_NO_DATA;
      if (code === CLASS_NO_DATA || code === CLASS_RANGE_FOLDED) {
        // No verdict: the plain clear-air floor, as the client would have
        // applied before the mask learned to do it.
        if (faint[level]) {
          out[rowR + b] = 0;
          floored += 1;
        }
        continue;
      }
      considered += 1;
      if (MASK_CLASSES.has(code) || (code === CLASS_BIG_DROPS && weak[level])) {
        out[rowR + b] = 0;
        masked += 1;
      }
    }
  }
  return { bins: out, masked, considered, floored };
}

/**
 * Same geometry? The mask indexes reflectivity's own bucket/bin grid, so
 * anything but an exact match on the grid would misplace it.
 *
 * @param {Object} refl decoded reflectivity payload
 * @param {Object} cls decoded classification payload
 * @returns {Boolean} true when the mask can be applied by index
 */
function gridsAlign(refl, cls) {
  return refl.bucketDeg === cls.bucketDeg
    && refl.binKm === cls.binKm
    && refl.firstBinKm === cls.firstBinKm
    && refl.numBuckets === cls.numBuckets;
}

/**
 * Reflectivity with the non-meteorological gates removed.
 *
 * Never fatal: when the classification for that exact volume scan is
 * missing, unreadable or on a different grid, the reflectivity comes
 * back untouched with `clean.applied` false and a reason. The client
 * still has the dBZ floor.
 *
 * @param {Object} refl decoded N0B payload (available:true)
 * @returns {Promise<Object>} a copy carrying `clean`
 */
async function cleanRadial(refl) {
  const scanEpoch = Date.parse(refl.scanTime || "");
  if (!Number.isFinite(scanEpoch)) {
    return { ...refl, clean: { applied: false, reason: "no-scan-time" } };
  }
  let cls;
  try {
    const key = await keyForEpoch(refl.site, CLASS_PRODUCT, scanEpoch);
    increment("nexrad-l3", "radial-list");
    if (!key) {
      return { ...refl, clean: { applied: false, reason: "no-classification" } };
    }
    cls = await decodeKey(refl.site, CLASS_PRODUCT, key);
  } catch {
    return { ...refl, clean: { applied: false, reason: "classification-failed" } };
  }
  if (!gridsAlign(refl, cls)) {
    return { ...refl, clean: { applied: false, reason: "grid-mismatch" } };
  }
  const { bins, masked, considered, floored } = applyClassMask(refl, cls);
  return {
    ...refl,
    bins: bins.toString("base64"),
    clean: {
      applied: true,
      product: CLASS_PRODUCT,
      key: cls.key,
      scanTime: cls.scanTime,
      masked,
      considered,
      // The floor has been applied server-side to verdict-less gates only;
      // the client must NOT apply its own, or classified drizzle vanishes.
      floorDbz: CLEAN_FLOOR_DBZ,
      floored,
    },
  };
}

/**
 * Fetch + decode the newest radial product for a site.
 *
 * @param {String} site 3-letter radar id
 * @param {String} [product] bucket product token, default N0B
 * @returns {Promise<Object>} payload for /api/radar/radial
 */
async function fetchRadial(site, product = DEFAULT_PRODUCT, clean = false) {
  const cacheKey = `${site}:${product}${clean ? ":clean" : ""}`;
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

  const decoded = await decodeKey(site, product, key);
  const value = clean ? await cleanRadial(decoded) : decoded;
  const ttl = (value.clean && !value.clean.applied && CLEAN_TRANSIENT.has(value.clean.reason))
    ? CLEAN_PENDING_TTL_MS
    : RADIAL_TTL_MS;
  radialCache.set(cacheKey, { value, expires: Date.now() + ttl });
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
async function fetchRadialAtStamp(site, stamp, product = DEFAULT_PRODUCT, clean = false) {
  const cacheKey = `${site}:${product}:${stamp}${clean ? ":clean" : ""}`;
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

  const decoded = await decodeKey(site, product, key);
  const value = clean ? await cleanRadial(decoded) : decoded;
  value.stamp = stamp;
  // Same reasoning as the live path: a historical scan whose
  // classification has not landed is not immutable yet.
  const ttl = (value.clean && !value.clean.applied && CLEAN_TRANSIENT.has(value.clean.reason))
    ? CLEAN_PENDING_TTL_MS
    : HISTORY_TTL_MS;
  historyCache.set(cacheKey, { value, expires: Date.now() + ttl });
  return value;
}

// ── Precipitation type ────────────────────────────────────────────────
// The same N0H classification dual-pol clean reads for its verdict names
// the precipitation itself: rain, heavy rain, big drops, dry snow, wet
// snow, ice crystals, graupel, hail. Here it is kept rather than reduced
// to a mask, and paired with N0B for intensity, into the one-byte-per-
// gate encoding in ./precipType (class in the high nibble, 5 dBZ tier in
// the low). The payload is the SAME shape as the other radial products —
// numBuckets × numBins raw levels — so the client renders it through the
// existing canvas pipeline with a different lookup table.
//
// The grid is the classification's (1200 bins = 300 km, exactly the
// renderer's display clip); reflectivity beyond it has no verdict and is
// not drawn. Non-weather classes (biological, clutter, unknown, range
// folded) are encoded as nothing, so the picture is inherently clean.

/**
 * Merge a reflectivity scan and its classification into encoded gates.
 *
 * @param {Object} refl decoded N0B payload
 * @param {Object} cls decoded N0H payload, same volume scan, same grid
 * @returns {{bins: Buffer, drawn: Number}} encoded levels on the classification's grid
 */
function mergePrecipType(refl, cls) {
  const rbins = Buffer.from(refl.bins, "base64");
  const cbins = Buffer.from(cls.bins, "base64");
  const out = Buffer.alloc(cbins.length);
  // Level → tier once per level, not per gate.
  const tierOfLevel = new Uint8Array(256);
  for (let level = refl.reservedLevels; level < 256; level += 1) {
    tierOfLevel[level] = precipType.tierForDbz(refl.scaling.min + level * refl.scaling.increment);
  }
  const idxOfCode = new Uint8Array(256);
  for (let code = 0; code < 256; code += 1) {
    const idx = precipType.hcaClassIndex(code);
    idxOfCode[code] = precipType.isDrawnClass(idx) ? idx : 0;
  }
  let drawn = 0;
  const rnb = refl.numBins;
  const cnb = cls.numBins;
  const span = Math.min(rnb, cnb);
  const buckets = Math.min(refl.numBuckets, cls.numBuckets);
  for (let a = 0; a < buckets; a += 1) {
    const rowR = a * rnb;
    const rowC = a * cnb;
    for (let b = 0; b < span; b += 1) {
      const idx = idxOfCode[cbins[rowC + b]];
      if (!idx) continue;
      // A class with no reflectivity behind it is not drawn either: the
      // intensity is what says "how much", and N0B's threshold is far
      // below anything the classifier would call precipitation.
      const tier = tierOfLevel[rbins[rowR + b]];
      if (!tier) continue;
      out[rowC + b] = precipType.encodeGate(idx, tier);
      drawn += 1;
    }
  }
  return { bins: out, drawn };
}

/**
 * The precipitation-type payload for one classification + reflectivity pair.
 *
 * @param {String} site 3-letter radar id
 * @param {Object} refl decoded N0B payload
 * @param {Object} cls decoded N0H payload
 * @returns {Object} available:true payload, `kind: "precip"`
 */
function precipPayload(site, refl, cls) {
  const { bins, drawn } = mergePrecipType(refl, cls);
  recordServiceCall(SERVICE_NAME, 200, `${drawn} typed gates for ${site}`);
  return {
    available: true,
    site,
    product: PRECIP_PRODUCT,
    kind: "precip",
    units: "class",
    key: cls.key,
    scanTime: cls.scanTime,
    radar: cls.radar,
    elevationAngle: cls.elevationAngle,
    // Level 0 is "nothing drawn"; every other level is an encoded gate,
    // not a linear scale — the `scaling` block is nominal.
    reservedLevels: 1,
    scaling: { min: 0, increment: 1, levels: 255 },
    numBuckets: cls.numBuckets,
    bucketDeg: cls.bucketDeg,
    numBins: cls.numBins,
    firstBinKm: cls.firstBinKm,
    binKm: cls.binKm,
    bins: bins.toString("base64"),
    precip: {
      tierDbz: precipType.TIER_DBZ,
      classification: { product: CLASS_PRODUCT, key: cls.key, scanTime: cls.scanTime },
      reflectivity: { product: DEFAULT_PRODUCT, key: refl.key, scanTime: refl.scanTime },
      drawn,
    },
  };
}

/**
 * Newest precipitation-type frame for a site.
 *
 * Paired from the CLASSIFICATION side on purpose: N0H lands 30-45 s after
 * the N0B of the same scan, so "newest N0B, then its N0H" would come back
 * empty for most of a minute after every scan and the layer would blink.
 * The newest N0H always has its N0B already in the bucket, so the frame
 * is simply the newest scan that CAN be typed — one scan older for those
 * seconds, with its own honest scanTime.
 *
 * @param {String} site 3-letter radar id
 * @returns {Promise<Object>} payload for /api/radar/radial?product=PTYPE
 */
async function fetchPrecipType(site) {
  const cacheKey = `${site}:${PRECIP_PRODUCT}`;
  const hit = radialCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const soft = (reason, ttl = RADIAL_TTL_MS) => {
    const empty = { available: false, site, product: PRECIP_PRODUCT, reason };
    radialCache.set(cacheKey, { value: empty, expires: Date.now() + ttl });
    recordServiceCall(SERVICE_NAME, 200, `no precip type for ${site}: ${reason}`);
    return empty;
  };

  const clsKey = await newestKey(site, CLASS_PRODUCT);
  increment("nexrad-l3", "radial-list");
  if (!clsKey) return soft("no-recent-classification");
  const cls = await decodeKey(site, CLASS_PRODUCT, clsKey);
  const scanEpoch = Date.parse(cls.scanTime || "");
  if (!Number.isFinite(scanEpoch)) return soft("no-scan-time");
  const reflKey = await keyForEpoch(site, DEFAULT_PRODUCT, scanEpoch);
  increment("nexrad-l3", "radial-list");
  // Reflectivity is published first, so a missing one is a transient
  // listing artefact at worst — short TTL.
  if (!reflKey) return soft("no-reflectivity", CLEAN_PENDING_TTL_MS);
  const refl = await decodeKey(site, DEFAULT_PRODUCT, reflKey);
  if (!gridsAlign(refl, cls)) return soft("grid-mismatch");

  const value = precipPayload(site, refl, cls);
  radialCache.set(cacheKey, { value, expires: Date.now() + RADIAL_TTL_MS });
  return value;
}

/**
 * Precipitation-type frame matching an IEM frame stamp (loop playback).
 *
 * @param {String} site 3-letter radar id
 * @param {String} stamp "YYYYMMDDHHMM" UTC
 * @returns {Promise<Object>} payload for /api/radar/radial?product=PTYPE&stamp=
 */
async function fetchPrecipTypeAtStamp(site, stamp) {
  const cacheKey = `${site}:${PRECIP_PRODUCT}:${stamp}`;
  const hit = historyCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const soft = (reason, ttl) => {
    const empty = { available: false, site, product: PRECIP_PRODUCT, stamp, reason };
    historyCache.set(cacheKey, { value: empty, expires: Date.now() + ttl });
    recordServiceCall(SERVICE_NAME, 200, `no precip type for ${site}@${stamp}: ${reason}`);
    return empty;
  };

  const reflKey = await keyForStamp(site, DEFAULT_PRODUCT, stamp);
  increment("nexrad-l3", "radial-list");
  if (!reflKey) return soft("no-matching-product", HISTORY_MISS_TTL_MS);
  const refl = await decodeKey(site, DEFAULT_PRODUCT, reflKey);
  const scanEpoch = Date.parse(refl.scanTime || "");
  if (!Number.isFinite(scanEpoch)) return soft("no-scan-time", HISTORY_TTL_MS);
  const clsKey = await keyForEpoch(site, CLASS_PRODUCT, scanEpoch);
  increment("nexrad-l3", "radial-list");
  // The classification may simply not have landed yet for the newest
  // stamps in the loop — the same gap the clean path retries across.
  if (!clsKey) return soft("no-classification", CLEAN_PENDING_TTL_MS);
  const cls = await decodeKey(site, CLASS_PRODUCT, clsKey);
  if (!gridsAlign(refl, cls)) return soft("grid-mismatch", HISTORY_TTL_MS);

  const value = precipPayload(site, refl, cls);
  value.stamp = stamp;
  historyCache.set(cacheKey, { value, expires: Date.now() + HISTORY_TTL_MS });
  return value;
}

// ── Tornado debris signature ──────────────────────────────────────────
// Lofted debris is non-uniform in size and shape, so its correlation
// coefficient collapses (< 0.8) while reflectivity stays high (≥ 30 dBZ)
// — inside a rotation. The operational recipe (NWS WDTD) is exactly that
// triple, and the rotation gate is what keeps it honest: biological
// scatter and the melting layer also drop CC, but not inside a
// mesocyclone with a 30+ dBZ core. So the search runs ONLY around the
// circulations the NMD product already reports, never over the whole disc.
const TDS_MAX_CC = 0.8;
const TDS_MIN_DBZ = 30;
const TDS_MIN_GATES = 10;
const TDS_RADIUS_KM = 3;
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/**
 * Count debris-signature gates within `radiusKm` of a point.
 *
 * @param {Object} refl decoded N0B payload (available:true)
 * @param {Object} cc decoded N0C payload, same volume scan
 * @param {Number} lat circulation latitude
 * @param {Number} lon circulation longitude
 * @param {Number} [radiusKm] search radius
 * @returns {{gates: Number, minCc: Number|null, detected: Boolean, sampled: Number}}
 */
function debrisSignature(refl, cc, lat, lon, radiusKm = TDS_RADIUS_KM) {
  const rbins = Buffer.from(refl.bins, "base64");
  const cbins = Buffer.from(cc.bins, "base64");
  const lat0 = (refl.radar.lat * Math.PI) / 180;
  const dy = (lat - refl.radar.lat) * KM_PER_DEG_LAT;
  const dx = (lon - refl.radar.lon) * KM_PER_DEG_LON_EQUATOR * Math.cos(lat0);
  const range = Math.hypot(dx, dy);
  if (!(range > radiusKm)) return { gates: 0, minCc: null, detected: false, sampled: 0 };
  let az = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (az < 0) az += 360;
  const halfDeg = (Math.asin(radiusKm / range) * 180) / Math.PI;
  const nb = refl.numBins;
  const cnb = cc.numBins;
  const span = Math.min(nb, cnb);
  const binLo = Math.max(0, Math.floor((range - radiusKm - refl.firstBinKm) / refl.binKm));
  const binHi = Math.min(span - 1, Math.ceil((range + radiusKm - refl.firstBinKm) / refl.binKm));
  const bucketLo = Math.floor((az - halfDeg) / refl.bucketDeg);
  const bucketHi = Math.ceil((az + halfDeg) / refl.bucketDeg);
  let gates = 0;
  let sampled = 0;
  let minCc = null;
  for (let a = bucketLo; a <= bucketHi; a += 1) {
    const bucket = ((a % refl.numBuckets) + refl.numBuckets) % refl.numBuckets;
    for (let b = binLo; b <= binHi; b += 1) {
      const rl = rbins[bucket * nb + b];
      const cl = cbins[bucket * cnb + b];
      if (rl < refl.reservedLevels || cl < cc.reservedLevels) continue;
      sampled += 1;
      const dbz = refl.scaling.min + rl * refl.scaling.increment;
      const rho = cc.scaling.min + cl * cc.scaling.increment;
      if (dbz >= TDS_MIN_DBZ && rho < TDS_MAX_CC) {
        gates += 1;
        if (minCc === null || rho < minCc) minCc = rho;
      }
    }
  }
  return {
    gates,
    minCc: minCc === null ? null : Math.round(minCc * 1000) / 1000,
    detected: gates >= TDS_MIN_GATES,
    sampled,
  };
}

/**
 * Attach a `tds` verdict to each circulation (mutates the mesos) from the
 * newest N0B + N0C pair of the same volume scan. Never throws: with either
 * product missing (many sites publish no N0C) the mesos are left alone and
 * the returned metadata says so.
 *
 * @param {String} site 3-letter radar id
 * @param {Array<Object>} mesos NMD circulations with lat/lon
 * @returns {Promise<{available: Boolean, scanTime: String|null, reason?: String}>}
 */
async function attachDebris(site, mesos) {
  const meta = { available: false, scanTime: null };
  if (!Array.isArray(mesos) || !mesos.length) return meta;
  try {
    const [refl, cc] = await Promise.all([fetchRadial(site, DEFAULT_PRODUCT), fetchRadial(site, "N0C")]);
    if (!refl.available || !cc.available) {
      meta.reason = cc.available ? "no-reflectivity" : "no-correlation";
      return meta;
    }
    if (refl.scanTime !== cc.scanTime) {
      // Different volume scans would pair a core with someone else's hole.
      meta.reason = "scan-mismatch";
      return meta;
    }
    if (!gridsAlign(refl, cc)) {
      meta.reason = "grid-mismatch";
      return meta;
    }
    for (const m of mesos) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) continue;
      m.tds = debrisSignature(refl, cc, m.lat, m.lon);
    }
    meta.available = true;
    meta.scanTime = cc.scanTime;
  } catch (err) {
    meta.reason = String(err && err.message ? err.message : err).slice(0, 120);
    recordServiceCall(SERVICE_NAME, err?.response?.status || 500, `debris check failed for ${site}: ${meta.reason}`);
  }
  return meta;
}

/**
 * Should this request be cleaned?
 *
 * Dual-pol clean is a reflectivity idea: the classification is derived
 * from the reflectivity field, so masking velocity by it would be a
 * different claim than the one that product makes.
 *
 * The value is compared as a STRING because that is what a query
 * parameter is — under Express and equally under the Android app, whose
 * axios adapter stringifies `params` before handing them to this handler
 * (standalone/install.js). A `=== 1` here would work on neither.
 *
 * @param {*} raw `req.query.clean`
 * @param {String} product bucket product token
 * @returns {Boolean} true to mask non-meteorological gates
 */
function wantsClean(raw, product) {
  return String(raw) === "1" && PRODUCTS[product]?.kind === "reflectivity";
}

/**
 * GET /api/radar/radial?site=DIX[&product=N0B|N0G][&stamp=YYYYMMDDHHMM][&clean=1]
 *
 * The raw-radial feed behind the client-side canvas renderer. Without
 * `stamp`, the newest scan; with it, the historical scan matching that
 * IEM frame stamp (used to render loop playback sharp). `product`
 * selects reflectivity (default) or velocity.
 *
 * `clean=1` blanks the gates the volume scan's dual-pol classification
 * calls non-meteorological — insects, birds, ground clutter — before
 * the payload is packed, so the client renders as it always did and the
 * payload does not grow. Reflectivity only; reports what it did (or why
 * it could not) in `clean`.
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
  if (!PRODUCTS[product] && product !== PRECIP_PRODUCT) {
    return res.status(400).json("Invalid product").end();
  }
  const stamp = req.query.stamp !== undefined ? String(req.query.stamp).trim() : null;
  if (stamp !== null && !/^\d{12}$/.test(stamp)) {
    return res.status(400).json("Invalid stamp").end();
  }
  const clean = wantsClean(req.query.clean, product);
  try {
    let payload;
    if (product === PRECIP_PRODUCT) {
      // `clean` is meaningless here — the non-weather classes are never
      // drawn — and wantsClean already answers false for it.
      payload = stamp ? await fetchPrecipTypeAtStamp(site, stamp) : await fetchPrecipType(site);
    } else {
      payload = stamp
        ? await fetchRadialAtStamp(site, stamp, product, clean)
        : await fetchRadial(site, product, clean);
    }
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
  keyForEpoch,
  wantsClean,
  applyClassMask,
  gridsAlign,
  cleanRadial,
  mergePrecipType,
  precipPayload,
  fetchPrecipType,
  fetchPrecipTypeAtStamp,
  PRECIP_PRODUCT,
  dualPolScaling,
  debrisSignature,
  attachDebris,
  TDS_MAX_CC,
  TDS_MIN_DBZ,
  TDS_MIN_GATES,
  TDS_RADIUS_KM,
  MASK_CLASSES,
  BIG_DROPS_RAIN_MIN_DBZ,
  CLEAN_FLOOR_DBZ,
  CLASS_PRODUCT,
  PRODUCTS,
  BIN_KM,
  NUM_BUCKETS,
  BUCKET_DEG,
};
