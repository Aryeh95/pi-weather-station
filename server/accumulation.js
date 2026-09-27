// Rainfall accumulation — the vocabulary shared by the radial products
// (DAA one-hour, DU3 three-hour, DTA storm total: inches, native scaling)
// and the MRMS QPE mosaic (millimetres on a CONUS grid, re-encoded here to
// one byte per cell). Plain CommonJS with no Node built-ins, like
// precipType.js: the kiosk client and the app import it straight from
// server/, and the tests require it, so there is one copy of the tier
// table and the colour ramp.

// Anything under this is "no measurable rain" and is not drawn — the
// products themselves report to 0.01 in.
const MIN_DEPTH_IN = 0.01;

// One byte per mosaic cell: tier 0 = nothing, tiers 1..255 a geometric
// ladder from 0.01 in to TOP_DEPTH_IN. Geometric because the interesting
// distinctions are 0.05 vs 0.1 vs 0.25 in at the bottom and 2 vs 4 in at
// the top — a linear step fine enough for the former wastes the byte.
const TIER_MAX = 255;
const TOP_DEPTH_IN = 20;
const TIER_RATIO = (TOP_DEPTH_IN / MIN_DEPTH_IN) ** (1 / (TIER_MAX - 1));

const MM_PER_IN = 25.4;

// Colour ramp by depth in inches: [in, r, g, b, a] stops, interpolated.
// Light grey-blue for a trace, blues and greens through a quarter inch,
// yellow at half an inch, orange at one, red past an inch and a half,
// magenta and purple for flooding rain, white beyond 5 in — the shape of
// the NWS / RadarScope accumulation palettes so a glance transfers, with
// the trace end kept muted so a damp map does not shout.
const ACCUM_STOPS = [
  [0.01, 150, 160, 185, 230],
  [0.05, 90, 170, 230, 255],
  [0.10, 40, 110, 255, 255],
  [0.25, 40, 200, 90, 255],
  [0.50, 250, 230, 40, 255],
  [1.00, 250, 150, 0, 255],
  [1.50, 240, 60, 40, 255],
  [2.00, 200, 0, 130, 255],
  [3.00, 150, 40, 220, 255],
  [5.00, 255, 255, 255, 255],
];

/**
 * RGBA for a depth (transparent below MIN_DEPTH_IN, last colour holds).
 *
 * @param {Number} inches accumulation
 * @returns {Array<Number>} [r, g, b, a]
 */
function colorForDepthIn(inches) {
  if (!Number.isFinite(inches) || inches < MIN_DEPTH_IN) return [0, 0, 0, 0];
  const stops = ACCUM_STOPS;
  if (inches >= stops[stops.length - 1][0]) return stops[stops.length - 1].slice(1);
  for (let i = 1; i < stops.length; i += 1) {
    if (inches <= stops[i][0]) {
      const [v0, r0, g0, b0, a0] = stops[i - 1];
      const [v1, r1, g1, b1, a1] = stops[i];
      // Interpolate in log depth: the stops are geometric-ish and a
      // linear blend would spend most of the 0.25→0.5 span near 0.5.
      const f = (Math.log(inches) - Math.log(v0)) / (Math.log(v1) - Math.log(v0));
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f, a0 + (a1 - a0) * f].map(Math.round);
    }
  }
  return stops[0].slice(1);
}

/**
 * Mosaic tier for a depth.
 *
 * @param {Number} inches
 * @returns {Number} 0 (nothing) or 1..TIER_MAX
 */
function tierForDepth(inches) {
  if (!Number.isFinite(inches) || inches < MIN_DEPTH_IN) return 0;
  const t = 1 + Math.round(Math.log(inches / MIN_DEPTH_IN) / Math.log(TIER_RATIO));
  return Math.max(1, Math.min(TIER_MAX, t));
}

/**
 * Depth a mosaic tier stands for.
 *
 * @param {Number} tier 1..TIER_MAX
 * @returns {Number} inches (0 for tier 0)
 */
function depthForTier(tier) {
  if (!(tier >= 1)) return 0;
  return MIN_DEPTH_IN * TIER_RATIO ** (Math.min(TIER_MAX, tier) - 1);
}

/**
 * 256-entry RGBA lookup for the mosaic's cell bytes.
 *
 * @returns {Uint8ClampedArray} 256 × 4
 */
function buildAccumLut() {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let tier = 1; tier <= TIER_MAX; tier += 1) {
    const [r, g, b, a] = colorForDepthIn(depthForTier(tier));
    lut[tier * 4] = r;
    lut[tier * 4 + 1] = g;
    lut[tier * 4 + 2] = b;
    lut[tier * 4 + 3] = a;
  }
  return lut;
}

/**
 * Depth in the user's unit, formatted.
 *
 * @param {Number} inches
 * @param {String} unit "in" | "mm"
 * @returns {String} e.g. "0.42 in" / "11 mm"
 */
function formatDepth(inches, unit) {
  if (!Number.isFinite(inches)) return "—";
  if (unit === "mm") {
    const mm = inches * MM_PER_IN;
    return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`;
  }
  return `${inches < 0.1 ? inches.toFixed(2) : inches.toFixed(2).replace(/0$/, "")} in`;
}

module.exports = {
  MIN_DEPTH_IN,
  TIER_MAX,
  TOP_DEPTH_IN,
  MM_PER_IN,
  ACCUM_STOPS,
  colorForDepthIn,
  tierForDepth,
  depthForTier,
  buildAccumLut,
  formatDepth,
};
