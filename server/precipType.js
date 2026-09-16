// Precipitation-type vocabulary shared by the server and the client.
//
// Two very different upstreams answer "is that rain or snow":
//
//   - at high zoom, the radar's own dual-pol hydrometeor classification
//     (Level III N0H, product 165) paired with the same volume scan's
//     super-res reflectivity (N0B) — see radarRadialCtrl.fetchPrecipType;
//   - at low zoom, MRMS's surface precipitation type (PrecipFlag) paired
//     with its rate (PrecipRate) — see mrmsPrecipTypeCtrl.
//
// Both are reduced HERE to one byte per gate/cell, so a single client
// lookup table colours either layer and the legend describes both:
//
//   high nibble  class index   0..15, the N0H class code / 10
//   low nibble   intensity tier 1..15 in 5 dBZ steps (0 = nothing drawn)
//
// The class codes are the product's own (N0H data levels are multiples of
// ten: 0 ND, 10 BI, 20 GC, 30 IC, 40 DS, 50 WS, 60 RA, 70 HR, 80 BD,
// 90 GR, 100 HA, 110 LH, 120 GH, 140 UK, 150 RF), which is why the index
// is simply code / 10. MRMS flags are mapped onto the same indices so one
// vocabulary serves both layers.
//
// This file is plain CommonJS with no Node dependencies on purpose: the
// kiosk client bundles it straight from `server/` (webpack handles CJS
// without babel), and the Android app already runs the server controllers
// in its WebView. One copy, no verbatim-copy drift to police.

// Intensity tiers: 5 dBZ each. Tier t covers [(t−1)·5, t·5) dBZ, tier 1
// also takes everything below 0 dBZ, tier 15 everything from 70 dBZ up.
const TIER_DBZ = 5;
const TIER_MAX = 15;

// Class indices (N0H code / 10).
const CLASS_ND = 0;   // no data / below threshold
const CLASS_BI = 1;   // biological
const CLASS_GC = 2;   // ground clutter
const CLASS_IC = 3;   // ice crystals
const CLASS_DS = 4;   // dry snow
const CLASS_WS = 5;   // wet snow
const CLASS_RA = 6;   // rain
const CLASS_HR = 7;   // heavy rain
const CLASS_BD = 8;   // big drops
const CLASS_GR = 9;   // graupel
const CLASS_HA = 10;  // hail (possibly with rain)
const CLASS_LH = 11;  // large hail
const CLASS_GH = 12;  // giant hail
const CLASS_UK = 14;  // unknown
const CLASS_RF = 15;  // range folded

// Legend groups. Everything not listed is NOT drawn: ND, BI, GC, UK and
// RF are exactly the non-weather verdicts dual-pol clean removes, so the
// precipitation-type picture is inherently clean.
const GROUP_NONE = 0;
const GROUP_RAIN = 1;
const GROUP_SNOW = 2;
const GROUP_MIX = 3;
const GROUP_GRAUPEL = 4;
const GROUP_HAIL = 5;

const GROUP_OF_CLASS = new Uint8Array(16);
GROUP_OF_CLASS[CLASS_RA] = GROUP_RAIN;
GROUP_OF_CLASS[CLASS_HR] = GROUP_RAIN;
GROUP_OF_CLASS[CLASS_BD] = GROUP_RAIN;
// Ice crystals at the 0.5° tilt are snow aloft; the legend calls them snow.
GROUP_OF_CLASS[CLASS_IC] = GROUP_SNOW;
GROUP_OF_CLASS[CLASS_DS] = GROUP_SNOW;
GROUP_OF_CLASS[CLASS_WS] = GROUP_MIX;
GROUP_OF_CLASS[CLASS_GR] = GROUP_GRAUPEL;
GROUP_OF_CLASS[CLASS_HA] = GROUP_HAIL;
GROUP_OF_CLASS[CLASS_LH] = GROUP_HAIL;
GROUP_OF_CLASS[CLASS_GH] = GROUP_HAIL;

// Legend order and i18n keys (radar.ptype*), one entry per drawn group;
// `sampleClass` is the class the legend swatches are drawn from.
const GROUPS = [
  { id: GROUP_RAIN, key: "rain", sampleClass: CLASS_RA },
  { id: GROUP_SNOW, key: "snow", sampleClass: CLASS_DS },
  { id: GROUP_MIX, key: "mix", sampleClass: CLASS_WS },
  { id: GROUP_GRAUPEL, key: "graupel", sampleClass: CLASS_GR },
  { id: GROUP_HAIL, key: "hail", sampleClass: CLASS_HA },
];

// Colour ramps per group: [dBZ, r, g, b, a] stops, interpolated. The
// hues follow the consumer-radar convention (green rain, blue snow, pink
// mix, purple graupel, magenta hail) and each ramp darkens/saturates with
// intensity so a rain shaft still reads as heavy or light. Rain avoids the
// reflectivity ramp's blues on purpose — blue means snow on this layer.
const RAIN_STOPS = [
  [0, 120, 200, 120, 170],
  [15, 70, 185, 80, 225],
  [25, 25, 155, 35, 255],
  [35, 245, 235, 40, 255],
  [45, 250, 150, 0, 255],
  [55, 235, 35, 35, 255],
  [70, 165, 0, 0, 255],
];
const SNOW_STOPS = [
  [0, 200, 220, 255, 190],
  [10, 150, 185, 255, 225],
  [20, 90, 135, 240, 255],
  [30, 45, 85, 220, 255],
  [45, 25, 45, 170, 255],
  [60, 15, 25, 120, 255],
];
const MIX_STOPS = [
  [0, 250, 195, 235, 195],
  [15, 240, 145, 215, 235],
  [30, 220, 85, 185, 255],
  [45, 180, 35, 145, 255],
  [60, 130, 0, 100, 255],
];
const GRAUPEL_STOPS = [
  [0, 195, 165, 235, 205],
  [20, 155, 115, 225, 255],
  [40, 115, 65, 195, 255],
  [60, 70, 20, 140, 255],
];
const HAIL_STOPS = [
  [0, 255, 130, 255, 255],
  [40, 255, 70, 230, 255],
  [60, 240, 0, 200, 255],
  [70, 255, 255, 255, 255],
];
const STOPS_OF_GROUP = [null, RAIN_STOPS, SNOW_STOPS, MIX_STOPS, GRAUPEL_STOPS, HAIL_STOPS];

/**
 * RGBA for a value along a stop table (same contract as the client's
 * colorForValue: transparent below the first stop, last colour holds).
 *
 * @param {Array<Array<Number>>} stops [value, r, g, b, a] rows, ascending
 * @param {Number} v value to colour
 * @returns {Array<Number>} [r, g, b, a]
 */
function interpolateStops(stops, v) {
  if (v < stops[0][0]) return [0, 0, 0, 0];
  const last = stops[stops.length - 1];
  if (v >= last[0]) return [last[1], last[2], last[3], last[4]];
  for (let i = 1; i < stops.length; i += 1) {
    if (v < stops[i][0]) {
      const lo = stops[i - 1];
      const hi = stops[i];
      const t = (v - lo[0]) / (hi[0] - lo[0]);
      return [
        Math.round(lo[1] + (hi[1] - lo[1]) * t),
        Math.round(lo[2] + (hi[2] - lo[2]) * t),
        Math.round(lo[3] + (hi[3] - lo[3]) * t),
        Math.round(lo[4] + (hi[4] - lo[4]) * t),
      ];
    }
  }
  return [0, 0, 0, 0];
}

/**
 * Class index for an N0H data level (class code).
 *
 * @param {Number} code N0H level, a multiple of 10
 * @returns {Number} 0..15; anything unrecognised is treated as unknown
 */
function hcaClassIndex(code) {
  if (!Number.isFinite(code) || code < 0 || code > 150 || code % 10 !== 0) return CLASS_UK;
  return code / 10;
}

// MRMS PrecipFlag values, verified live 2026-09-16 (histogram of a CONUS
// frame matched this table exactly): −3 no coverage, 0 none, 1 warm
// stratiform rain, 3 snow, 6 convective rain, 7 hail, 10 cool stratiform
// rain, 91 tropical/stratiform mix, 96 tropical/convective mix. MRMS has
// no sleet / freezing-rain flag, so the mix group never comes from here.
const MRMS_FLAG_CLASS = {
  1: CLASS_RA,
  10: CLASS_RA,
  91: CLASS_RA,
  6: CLASS_HR,
  96: CLASS_HR,
  3: CLASS_DS,
  7: CLASS_HA,
};

/**
 * Class index for an MRMS PrecipFlag value.
 *
 * @param {Number} flag decoded PrecipFlag value
 * @returns {Number} class index, 0 when the flag means no precipitation
 */
function mrmsFlagClassIndex(flag) {
  return MRMS_FLAG_CLASS[flag] || CLASS_ND;
}

/**
 * Intensity tier for a reflectivity.
 *
 * @param {Number} dbz reflectivity
 * @returns {Number} 1..15
 */
function tierForDbz(dbz) {
  if (!Number.isFinite(dbz)) return 1;
  return Math.max(1, Math.min(TIER_MAX, Math.floor(dbz / TIER_DBZ) + 1));
}

/**
 * Reflectivity equivalent of a rain rate — Marshall–Palmer, Z = 200 R^1.6,
 * so dBZ = 23 + 16·log10(R). Used only to put MRMS's rate field on the
 * same intensity tiers as the radar's dBZ; 0.3 mm/h ≈ 15 dBZ, 1 mm/h ≈ 23,
 * 10 mm/h ≈ 39, 50 mm/h ≈ 50.
 *
 * @param {Number} mmPerHour rain rate
 * @returns {Number} dBZ, −Infinity for a non-positive rate
 */
function dbzForRate(mmPerHour) {
  if (!(mmPerHour > 0)) return -Infinity;
  return 23 + 16 * Math.log10(mmPerHour);
}

/**
 * Intensity tier for a rain rate.
 *
 * @param {Number} mmPerHour
 * @returns {Number} 1..15
 */
function tierForRate(mmPerHour) {
  return tierForDbz(dbzForRate(mmPerHour));
}

/**
 * Lowest tier still drawn under a reflectivity floor.
 *
 * @param {Number} [minDbz] noise-filter floor; absent or −Infinity draws every tier
 * @returns {Number} 1..15
 */
function minTierForDbz(minDbz) {
  if (!Number.isFinite(minDbz)) return 1;
  return tierForDbz(minDbz);
}

/**
 * Midpoint reflectivity of a tier, for colouring.
 *
 * @param {Number} tier 1..15
 * @returns {Number} dBZ
 */
function tierMidDbz(tier) {
  return (tier - 1) * TIER_DBZ + TIER_DBZ / 2;
}

/**
 * Pack a class index and a tier into one byte.
 *
 * @param {Number} classIdx 0..15
 * @param {Number} tier 0..15
 * @returns {Number} 0..255
 */
function encodeGate(classIdx, tier) {
  return ((classIdx & 15) << 4) | (tier & 15);
}

const gateClass = (level) => level >> 4;
const gateTier = (level) => level & 15;
const isDrawnClass = (classIdx) => GROUP_OF_CLASS[classIdx & 15] !== GROUP_NONE;

/**
 * RGBA for one encoded gate.
 *
 * @param {Number} level encoded byte
 * @param {Number} [minDbz] noise-filter floor
 * @returns {Array<Number>} [r, g, b, a]; a = 0 when nothing is drawn
 */
function colorForGate(level, minDbz) {
  const tier = gateTier(level);
  const group = GROUP_OF_CLASS[gateClass(level)];
  if (tier === 0 || group === GROUP_NONE || tier < minTierForDbz(minDbz)) return [0, 0, 0, 0];
  return interpolateStops(STOPS_OF_GROUP[group], tierMidDbz(tier));
}

/**
 * The 256-entry level → RGBA lookup for an encoded precipitation-type
 * field. Level 0 and every non-weather class stay transparent; tiers under
 * the noise-filter floor are cleared here once, not per pixel.
 *
 * @param {Number} [minDbz] noise-filter floor
 * @returns {Uint8ClampedArray} 256 × 4 RGBA entries
 */
function buildPrecipLut(minDbz) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let level = 1; level < 256; level += 1) {
    const [r, g, b, a] = colorForGate(level, minDbz);
    if (a === 0) continue;
    lut[level * 4] = r;
    lut[level * 4 + 1] = g;
    lut[level * 4 + 2] = b;
    lut[level * 4 + 3] = a;
  }
  return lut;
}

/**
 * Run-length encode a byte field: pairs of (value, run) with runs capped at
 * 255. A CONUS precipitation grid is overwhelmingly zero, so this is small,
 * and decoding is a loop any client can write in five lines.
 *
 * @param {Uint8Array} bytes field values
 * @returns {Uint8Array} encoded pairs
 */
function rleEncode(bytes) {
  const out = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const v = bytes[i];
    let run = 1;
    while (i + run < n && bytes[i + run] === v && run < 255) run += 1;
    out.push(v, run);
    i += run;
  }
  return Uint8Array.from(out);
}

/**
 * Inverse of rleEncode.
 *
 * @param {Uint8Array} pairs encoded pairs
 * @param {Number} length expected field length
 * @returns {Uint8Array} field values
 */
function rleDecode(pairs, length) {
  const out = new Uint8Array(length);
  let p = 0;
  for (let i = 0; i + 1 < pairs.length && p < length; i += 2) {
    const v = pairs[i];
    const run = pairs[i + 1];
    if (v !== 0) out.fill(v, p, Math.min(length, p + run));
    p += run;
  }
  return out;
}

module.exports = {
  TIER_DBZ,
  TIER_MAX,
  CLASS_ND,
  CLASS_BI,
  CLASS_GC,
  CLASS_IC,
  CLASS_DS,
  CLASS_WS,
  CLASS_RA,
  CLASS_HR,
  CLASS_BD,
  CLASS_GR,
  CLASS_HA,
  CLASS_LH,
  CLASS_GH,
  CLASS_UK,
  CLASS_RF,
  GROUP_NONE,
  GROUP_RAIN,
  GROUP_SNOW,
  GROUP_MIX,
  GROUP_GRAUPEL,
  GROUP_HAIL,
  GROUP_OF_CLASS,
  GROUPS,
  STOPS_OF_GROUP,
  MRMS_FLAG_CLASS,
  interpolateStops,
  hcaClassIndex,
  mrmsFlagClassIndex,
  tierForDbz,
  dbzForRate,
  tierForRate,
  minTierForDbz,
  tierMidDbz,
  encodeGate,
  gateClass,
  gateTier,
  isDrawnClass,
  colorForGate,
  buildPrecipLut,
  rleEncode,
  rleDecode,
};
