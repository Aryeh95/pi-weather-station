// Point nowcast — "when does rain reach home, how heavy, when does it
// stop" — by extrapolating the radar's own recent motion.
//
// This is a Lagrangian-persistence nowcast, the same idea every consumer
// radar app uses: estimate how the echo field moved over the last few
// volume scans, assume it keeps moving that way, and read what passes
// over the pin. It cannot see initiation, so its skill decays with lead
// time — fast for convection, slowly for stratiform rain. The horizon is
// 90 min and every answer carries its own measured skill and confidence.
//
// Steps, all on the dual-pol CLEANED reflectivity so insects and clutter
// never count as rain:
//   1. Project the last NUM_SCANS scans onto a Cartesian grid centred on
//      HOME (not the radar): 1 km cells, ±GRID_HALF_KM.
//   2. Estimate one motion vector by normalized cross-correlation of the
//      echo field between the newest scan and each earlier one, coarse to
//      fine (shortest baseline in full, longer ones refine). Then a 3 × 3
//      LOCAL field of vectors around the pin, each constrained to the
//      global one, so shear in a broken band is followed.
//   3. Measure the GROWTH / DECAY trend along the motion over the same
//      baseline, in dB per hour.
//   4. Advect an ENSEMBLE: the motion vector perturbed in speed and
//      direction by the correlation's own uncertainty (plus the previous
//      nowcast's vector, so one odd scan does not flip the headline).
//      Each member's upstream point is walked through the local field;
//      the newest grid is sampled there (footprint majority), the trend
//      applied, and the fraction of wet members is the PROBABILITY of
//      rain at that lead. The same points can be read from the MRMS
//      surface rate field as a cross-check (OFF by default — see the
//      MRMS note below: measured against the radar it did not help).
//   5. Read the hydrometeor class (N0H) at the central upstream point so
//      the card can say snow, sleet or hail instead of rain.
//   6. Summarise: raining now?, arrival (as a range), peak, end, motion,
//      trend, confidence. Then remember the forecast so it can be scored
//      against the scans that arrive later (live verification).
//
// Skill measured offline (tools/nowcastHindcast.js) is in HINDCAST below
// and returned with every answer; the live score for THIS pin rides along
// as `liveSkill`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");
const { BoundedMap } = require("./boundedCache");
const { listHourKeys } = require("./nexradBucket");
const { fetchRadialByKey, keyForEpoch, CLASS_PRODUCT } = require("./radarRadialCtrl");
const { resolveRadarSite, overrideSite } = require("./iemRadarCtrl");
const { keyNearest, fetchGrid } = require("./mrmsHailCtrl");
const precipType = require("./precipType");

const SERVICE_NAME = "NEXRAD L3 (nowcast)";
const PRODUCT = "N0B";
const MRMS_RATE_PRODUCT = "CONUS/PrecipRate_00.00";

/**
 * Environment variable, or undefined where there is no process (the app).
 *
 * @param {String} name
 * @returns {String|undefined}
 */
function envVar(name) {
  try {
    return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  } catch {
    return undefined;
  }
}

// Grid geometry. 1 km cells over ±120 km covers 90 min of motion at
// 80 km/h; at higher speeds the horizon shortens (see `horizonMin`).
const GRID_CELL_KM = 1;
const GRID_HALF_KM = 120;
const GRID_N = 2 * GRID_HALF_KM / GRID_CELL_KM + 1;
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

// How many scans feed the motion estimate: the newest plus three earlier
// (15–20 min of history).
const NUM_SCANS = 4;
// Cross-correlation is done on the central core of the grid so the
// search window never runs off the field.
const CORR_HALF_KM = 60;
// Largest displacement searched, in km per baseline minute. 120 km/h is
// faster than any storm motion the kiosk will see; the first version
// allowed 240 and a 17-min baseline "found" a 203 km/h match at the far
// edge of its search window while the 5- and 11-min baselines agreed on
// 45 km/h — a different rain band had slid under the window.
const MAX_SPEED_KM_PER_MIN = 2;
// Longer baselines are searched only around the motion the shorter ones
// already found: this many cells of slack plus a fraction of the
// predicted shift, so they refine the speed instead of re-guessing it.
const REFINE_SLACK_CELLS = 6;
const REFINE_SLACK_FRACTION = 0.25;
// Fewer echo cells than this in the correlation core and the field has no
// texture to match — motion stays unknown.
const MIN_ECHO_CELLS = 150;
// Correlations below this are noise: the shortest baseline must clear it
// or the motion is "unknown"; a longer one that does not is simply not
// used to refine.
const MIN_NCC = 0.35;
// Local field: 3 × 3 blocks of this half-size, centred this far apart,
// each searched within LOCAL_SLACK_CELLS of the global shift and needing
// LOCAL_MIN_ECHO_CELLS + LOCAL_MIN_NCC to override the global vector.
const LOCAL_BLOCK_HALF_KM = 30;
const LOCAL_BLOCK_SPACING_KM = 50;
const LOCAL_SLACK_CELLS = 5;
const LOCAL_MIN_ECHO_CELLS = 60;
const LOCAL_MIN_NCC = 0.3;
// Echo only counts from here (the same floor the clean mask keeps for
// verdict-less gates); intensity for matching is dBZ above it.
const RAIN_DBZ = 15;
const LEAD_STEP_MIN = 5;
const HORIZON_MIN = 90;
// Two consecutive 5-min steps make an event — one lonely cell passing over
// the pin is not "rain arriving".
const PERSIST_STEPS = 2;
// Half-width of the sampling footprint around the pin, in cells: 1 gives
// the 3 × 3 km neighbourhood. Overridable for the hindcast harness only.
const SAMPLE_HALF = Math.max(1, parseInt(envVar("NOWCAST_SAMPLE_HALF") || "1", 10) || 1);
const SAMPLE_CELLS = (2 * SAMPLE_HALF + 1) ** 2;
const SAMPLE_MAJORITY = Math.ceil(SAMPLE_CELLS / 2);
// Ensemble: speed factors × direction offsets, spread by the correlation
// quality (a sharp peak means a tight ensemble). At ncc 0.9 the spread is
// ±13 % / ±11°; at ncc 0.5 it is ±25 % / ±23°.
const ENSEMBLE_SPEED_STEPS = [-1, -0.5, 0, 0.5, 1];
const ENSEMBLE_DIR_STEPS = [-1, -0.5, 0, 0.5, 1];
const SPEED_SPREAD_MIN = 0.10;
const SPEED_SPREAD_PER_NCC = 0.30;
const DIR_SPREAD_MIN_DEG = 8;
const DIR_SPREAD_PER_NCC_DEG = 30;
// The previous nowcast's vector joins the ensemble with this share of the
// total weight while it is younger than PREVIOUS_MAX_AGE_MS.
const PREVIOUS_WEIGHT = 0.25;
const PREVIOUS_MAX_AGE_MS = 20 * 60 * 1000;
// Growth / decay trend, clamped: ±12 dB/h is a cell doubling or halving
// its rain rate every 15 min, which is as fast as trends stay predictable.
const TREND_MAX_DB_PER_HOUR = 12;
const TREND_MAX_TOTAL_DB = 10;
// MRMS surface rate cross-check. OFF BY DEFAULT (`NOWCAST_ENABLE=mrms`
// turns it on): measured on 2026-09-27 against radar truth (≥ 15 dBZ at
// the pin), MRMS ≥ 0.2 mm/h was wet at 3× as many pins as the radar
// (P(radar wet | MRMS wet) = 29–39 %, P(MRMS wet | radar wet) = 94–97 %),
// so averaging the two probabilities ("blend") tripled the false-alarm
// ratio (DIX 15 min: 35 → 74 %), and using it only to LOWER a radar call
// ("veto") at 0.5–1 mm/h traded misses for false alarms with no net gain
// (DIX 30 min CSI 42 → 34–38 %; LWX 15 min 48 → 39–45 %). The code stays
// for a future surface-truth mode; the default nowcast is radar-only.
const MRMS_WET_MM_H = 0.5;
const MRMS_MAX_SKEW_MS = 6 * 60 * 1000;
// How the surface field enters when enabled: "veto" scales the radar
// probability by (floor + (1 − floor) · MRMS wet fraction), so a dry
// ground can only LOWER a rain call (virga, overshooting beam); "blend"
// averages the two probabilities and lets the ground raise a call too.
const MRMS_MODE = "veto";
const MRMS_VETO_FLOOR = 0.5;
const MRMS_WEIGHT = 0.5;
const DEFAULT_OFF = ["mrms"];
// Probability thresholds for the sentences: the rain call, and the range
// the arrival is quoted over.
const P_RAIN = 0.5;
const P_EARLIEST = 0.3;
const P_LATEST = 0.7;

// Intensity categories by dBZ, in the vocabulary the client's i18n uses.
const CATEGORIES = [
  ["none", -Infinity],
  ["light", RAIN_DBZ],
  ["moderate", 30],
  ["heavy", 40],
  ["intense", 50],
];

// Precipitation-type words the card can use, from precipType's groups.
const PTYPE_OF_GROUP = ["none", "rain", "snow", "mix", "graupel", "hail"];

// Skill measured by tools/nowcastHindcast.js against archived scans (see
// CLAUDE.md, "Nowcast"). Two cases, 9 pins each, 3 × 3 km footprint,
// scored on the ≥ 50 % probability call with the default features
// (ensemble + trend + local field + previous vector; MRMS off):
//   DIX 2026-09-27 14–20 Z — broken bands of showers, 729 nowcasts
//   LWX 2026-09-22 03–06 Z — a fast stratiform band, 540 nowcasts
// `leads` is the mean of the two cases; `persistence` is the "it keeps
// doing what it does now" baseline the nowcast has to beat, and does at
// every lead. POD = probability of detection (rain forecast AND rain
// fell / all rain that fell); FAR = false-alarm ratio (rain forecast but
// dry / all rain forecasts); CSI = hits / (hits + misses + false alarms);
// Brier = mean squared error of the probability (0 perfect, 0.25 = a
// coin toss at every step).
const HINDCAST = {
  measuredOn: "2026-09-27",
  cases: ["DIX 2026-09-27 14-20Z (showers)", "LWX 2026-09-22 03-06Z (band)"],
  leads: {
    15: {
      leadMin: 15, pod: 0.71, far: 0.37, csi: 0.51, brier: 0.057, persistence: { pod: 0.41, far: 0.56, csi: 0.28 },
    },
    30: {
      leadMin: 30, pod: 0.58, far: 0.41, csi: 0.42, brier: 0.075, persistence: { pod: 0.28, far: 0.70, csi: 0.17 },
    },
    45: {
      leadMin: 45, pod: 0.38, far: 0.53, csi: 0.26, brier: 0.093, persistence: { pod: 0.17, far: 0.83, csi: 0.10 },
    },
    60: {
      leadMin: 60, pod: 0.36, far: 0.46, csi: 0.26, brier: 0.092, persistence: { pod: 0.12, far: 0.89, csi: 0.06 },
    },
  },
};

// Live verification: the leads scored, the match window around each, and
// where the running score is kept between restarts (best effort — the
// Android app has no filesystem and keeps it in memory only).
const VERIFY_LEADS = [15, 30, 60];
const VERIFY_MATCH_MS = 3 * 60 * 1000;
const VERIFY_PENDING_MAX_MS = 75 * 60 * 1000;
const SKILL_FILE = path.join(typeof os.homedir === "function" ? os.homedir() : "", ".local", "state", "pi-weather-station", "nowcast-skill.json");

const cache = new BoundedMap(16);
const NOWCAST_TTL_MS = 60 * 1000;
// Previous nowcast per site+home, for the temporal ensemble members.
const previousMotion = new BoundedMap(32);
// The newest MRMS rate grid, decoded once per file and shared by every
// home (a CONUS field is 49 MB decoded — one copy at a time).
let mrmsLatest = null;
let mrmsInflight = null;

/**
 * Feature switches. Everything on by default except DEFAULT_OFF;
 * `NOWCAST_DISABLE` / `NOWCAST_ENABLE` (comma lists) or explicit sets
 * override — the hindcast uses this to attribute skill to each piece.
 *
 * @param {Iterable<String>} [disable] feature names to turn off
 * @param {Iterable<String>} [enable] feature names to turn on (beats DEFAULT_OFF)
 * @returns {{ensemble: Boolean, trend: Boolean, local: Boolean, mrms: Boolean, persist: Boolean, ptype: Boolean}}
 */
function featureSet(disable, enable) {
  const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  const on = new Set([...list(envVar("NOWCAST_ENABLE")), ...(enable || [])]);
  const off = new Set([
    ...DEFAULT_OFF.filter((f) => !on.has(f)),
    ...list(envVar("NOWCAST_DISABLE")),
    ...(disable || []),
  ]);
  return {
    ensemble: !off.has("ensemble"),
    trend: !off.has("trend"),
    local: !off.has("local"),
    mrms: !off.has("mrms"),
    persist: !off.has("persist"),
    ptype: !off.has("ptype"),
  };
}

/**
 * dBZ category name.
 *
 * @param {Number} dbz reflectivity, or −Infinity / NaN for none
 * @returns {String} "none" | "light" | "moderate" | "heavy" | "intense"
 */
function categoryFor(dbz) {
  let out = "none";
  if (!Number.isFinite(dbz)) return out;
  for (const [name, min] of CATEGORIES) if (dbz >= min) out = name;
  return out;
}

/**
 * Marshall–Palmer rain rate for a reflectivity.
 *
 * @param {Number} dbz reflectivity
 * @returns {Number} mm/h, 0 when none
 */
function rateForDbz(dbz) {
  if (!Number.isFinite(dbz) || dbz < 0) return 0;
  return Math.round((10 ** ((dbz - 23) / 16)) * 10) / 10;
}

/**
 * Geometry shared by every projection onto the home grid.
 *
 * @param {{lat: Number, lon: Number}} home
 * @returns {{c: Number, kmPerDegLon: Number}}
 */
function homeGeometry(home) {
  return {
    c: (GRID_N - 1) / 2,
    kmPerDegLon: KM_PER_DEG_LON_EQUATOR * Math.cos((home.lat * Math.PI) / 180),
  };
}

/**
 * Project a radial payload onto the home-centred grid through a
 * per-level lookup.
 *
 * @param {Object} p radial payload (bins, radar, numBins, numBuckets, …)
 * @param {{lat: Number, lon: Number}} home
 * @param {Float32Array|Uint8Array} valueOfLevel 256-entry lookup, level → cell value
 * @param {Float32Array|Uint8Array} grid output, pre-filled with the "nothing" value
 * @returns {Float32Array|Uint8Array} grid
 */
function projectRadial(p, home, valueOfLevel, grid) {
  const bins = Buffer.from(p.bins, "base64");
  const { c, kmPerDegLon } = homeGeometry(home);
  // Home relative to the radar, km east / north.
  const hx = (home.lon - p.radar.lon) * kmPerDegLon;
  const hy = (home.lat - p.radar.lat) * KM_PER_DEG_LAT;
  const nb = p.numBins;
  for (let i = 0; i < GRID_N; i += 1) {
    const dy = hy + (c - i) * GRID_CELL_KM;
    for (let j = 0; j < GRID_N; j += 1) {
      const dx = hx + (j - c) * GRID_CELL_KM;
      const range = Math.hypot(dx, dy);
      const bin = Math.floor((range - p.firstBinKm) / p.binKm);
      if (bin < 0 || bin >= nb) continue;
      let az = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (az < 0) az += 360;
      const bucket = Math.min(p.numBuckets - 1, Math.floor(az / p.bucketDeg));
      grid[i * GRID_N + j] = valueOfLevel[bins[bucket * nb + bin]];
    }
  }
  return grid;
}

/**
 * Project a reflectivity payload onto the home-centred Cartesian grid.
 *
 * @param {Object} p /api/radar/radial payload (available:true, reflectivity)
 * @param {{lat: Number, lon: Number}} home grid centre
 * @returns {Float32Array} GRID_N × GRID_N dBZ, row 0 = north; −Infinity where no echo
 */
function projectToGrid(p, home) {
  const dbzOf = new Float32Array(256);
  for (let l = 0; l < 256; l += 1) {
    dbzOf[l] = l < p.reservedLevels ? -Infinity : p.scaling.min + l * p.scaling.increment;
  }
  return projectRadial(p, home, dbzOf, new Float32Array(GRID_N * GRID_N).fill(-Infinity));
}

/**
 * Project a hydrometeor-classification payload (N0H) onto the home grid
 * as precipType GROUP ids (0 none / non-weather, 1 rain … 5 hail). N0H
 * levels are the class codes themselves (0, 10, … 150).
 *
 * @param {Object} cls decoded N0H payload
 * @param {{lat: Number, lon: Number}} home
 * @returns {Uint8Array} GRID_N × GRID_N group ids
 */
function projectClassGrid(cls, home) {
  const groupOfCode = new Uint8Array(256);
  for (let code = 0; code < 256; code += 1) {
    const idx = precipType.hcaClassIndex(code);
    groupOfCode[code] = idx < 16 ? precipType.GROUP_OF_CLASS[idx] : 0;
  }
  return projectRadial(cls, home, groupOfCode, new Uint8Array(GRID_N * GRID_N));
}

/**
 * Project a decoded MRMS PrecipRate field onto the home grid, mm/h.
 *
 * @param {{g: Object, samples: Uint16Array}} rate from mrmsHailCtrl.fetchGrid
 * @param {{lat: Number, lon: Number}} home
 * @returns {Float32Array} GRID_N × GRID_N mm/h (0 where dry or uncovered)
 */
function projectMrmsGrid(rate, home) {
  const { g, samples } = rate;
  const scale = (2 ** g.binScale) / (10 ** g.decScale);
  const offset = g.ref / (10 ** g.decScale);
  const out = new Float32Array(GRID_N * GRID_N);
  const { c, kmPerDegLon } = homeGeometry(home);
  for (let i = 0; i < GRID_N; i += 1) {
    const lat = home.lat + ((c - i) * GRID_CELL_KM) / KM_PER_DEG_LAT;
    const row = Math.round((g.lat0 - lat) / g.dLat);
    if (row < 0 || row >= g.nj) continue;
    for (let j = 0; j < GRID_N; j += 1) {
      let lon = home.lon + ((j - c) * GRID_CELL_KM) / kmPerDegLon;
      if (lon < 0) lon += 360;
      const col = Math.round((lon - g.lon0) / g.dLon);
      if (col < 0 || col >= g.ni) continue;
      const v = offset + samples[row * g.ni + col] * scale;
      out[i * GRID_N + j] = v > 0 ? v : 0;
    }
  }
  return out;
}

/**
 * Echo intensity field for matching: dBZ above the rain floor, 0 elsewhere,
 * smoothed with a 3 × 3 box so the match follows the rain band's shape
 * rather than gate-scale speckle.
 *
 * @param {Float32Array} grid dBZ grid
 * @returns {Float32Array} same shape
 */
function intensity(grid) {
  const raw = new Float32Array(grid.length);
  for (let k = 0; k < grid.length; k += 1) {
    const v = grid[k];
    raw[k] = v > RAIN_DBZ ? v - RAIN_DBZ : 0;
  }
  const out = new Float32Array(grid.length);
  for (let i = 1; i < GRID_N - 1; i += 1) {
    for (let j = 1; j < GRID_N - 1; j += 1) {
      let sum = 0;
      for (let di = -1; di <= 1; di += 1) {
        const row = (i + di) * GRID_N + j;
        sum += raw[row - 1] + raw[row] + raw[row + 1];
      }
      out[i * GRID_N + j] = sum / 9;
    }
  }
  return out;
}

/**
 * Displacement (cells east, cells south) that best maps intensity field
 * `a` onto `b`, by normalized cross-correlation over a core of the grid,
 * with a parabolic sub-cell refinement of the peak.
 *
 * @param {Float32Array} a intensity of the earlier grid (from `intensity`)
 * @param {Float32Array} b intensity of the newer grid
 * @param {Number} maxShift half-width of the search window, cells
 * @param {{dj: Number, di: Number}} [centre] window centre (default no shift)
 * @param {{ci: Number, cj: Number, h: Number}} [core] core centre row/col and half-size, cells
 * @returns {{dj: Number, di: Number, ncc: Number, echoCells: Number, atEdge: Boolean}|null}
 *   null when the core holds too little echo; `atEdge` when the peak sits on
 *   the window boundary, which means the true peak may lie outside it
 */
function correlate(a, b, maxShift, centre = { dj: 0, di: 0 }, core = null) {
  const c = (GRID_N - 1) / 2;
  const ci = core ? core.ci : c;
  const cj = core ? core.cj : c;
  const h = core ? core.h : CORR_HALF_KM / GRID_CELL_KM;
  const minEcho = core ? LOCAL_MIN_ECHO_CELLS : MIN_ECHO_CELLS;
  let echoCells = 0;
  let sumB2 = 0;
  for (let i = ci - h; i <= ci + h; i += 1) {
    for (let j = cj - h; j <= cj + h; j += 1) {
      const v = b[i * GRID_N + j];
      if (v > 0) echoCells += 1;
      sumB2 += v * v;
    }
  }
  if (echoCells < minEcho || sumB2 === 0) return null;

  // The window may never read outside the grid.
  const limitI = Math.min(ci - h, GRID_N - 1 - (ci + h));
  const limitJ = Math.min(cj - h, GRID_N - 1 - (cj + h));
  const c0j = Math.round(centre.dj);
  const c0i = Math.round(centre.di);
  const loI = Math.max(c0i - maxShift, -limitI);
  const hiI = Math.min(c0i + maxShift, limitI);
  const loJ = Math.max(c0j - maxShift, -limitJ);
  const hiJ = Math.min(c0j + maxShift, limitJ);
  if (loI > hiI || loJ > hiJ) return null;
  let best = { dj: 0, di: 0, ncc: -1 };
  const scores = new Map();
  for (let di = loI; di <= hiI; di += 1) {
    for (let dj = loJ; dj <= hiJ; dj += 1) {
      // next(i, j) ≈ prev(i − di, j − dj): the echo moved by (dj, di).
      let dot = 0;
      let sumA2 = 0;
      for (let i = ci - h; i <= ci + h; i += 1) {
        const rowB = i * GRID_N;
        const rowA = (i - di) * GRID_N;
        for (let j = cj - h; j <= cj + h; j += 1) {
          const va = a[rowA + j - dj];
          const vb = b[rowB + j];
          dot += va * vb;
          sumA2 += va * va;
        }
      }
      const ncc = sumA2 > 0 ? dot / Math.sqrt(sumA2 * sumB2) : 0;
      scores.set(`${di},${dj}`, ncc);
      if (ncc > best.ncc) best = { dj, di, ncc };
    }
  }
  const atEdge = best.dj === loJ || best.dj === hiJ || best.di === loI || best.di === hiI;
  // Sub-cell peak: fit a parabola through the peak and its neighbours on
  // each axis. Only when the peak is interior to the search window.
  const at = (di, dj) => scores.get(`${di},${dj}`);
  let dj = best.dj;
  let di = best.di;
  if (!atEdge) {
    const l = at(best.di, best.dj - 1);
    const r = at(best.di, best.dj + 1);
    const denJ = l - 2 * best.ncc + r;
    if (denJ < 0) dj += 0.5 * (l - r) / denJ;
    const u = at(best.di - 1, best.dj);
    const d = at(best.di + 1, best.dj);
    const denI = u - 2 * best.ncc + d;
    if (denI < 0) di += 0.5 * (u - d) / denI;
  }
  return { dj, di, ncc: best.ncc, echoCells, atEdge };
}

/**
 * Displacement between two dBZ grids over the central core (see
 * `correlate`); kept for tests and the harness.
 *
 * @param {Float32Array} prev earlier dBZ grid
 * @param {Float32Array} next newer dBZ grid
 * @param {Number} maxShift half-width of the search window, cells
 * @param {{dj: Number, di: Number}} [centre] window centre
 * @returns {Object|null} see `correlate`
 */
function estimateShift(prev, next, maxShift, centre = { dj: 0, di: 0 }) {
  return correlate(intensity(prev), intensity(next), maxShift, centre);
}

/**
 * Vector from a shift over a baseline.
 *
 * @param {{dj: Number, di: Number}} s shift, cells
 * @param {Number} dtMin baseline, minutes
 * @returns {{vx: Number, vy: Number, speedKmh: Number, towardDeg: Number}} km/min east / north
 */
function vectorFromShift(s, dtMin) {
  const vx = (s.dj * GRID_CELL_KM) / dtMin;
  const vy = (-s.di * GRID_CELL_KM) / dtMin;
  let towardDeg = (Math.atan2(vx, vy) * 180) / Math.PI;
  if (towardDeg < 0) towardDeg += 360;
  return { vx, vy, speedKmh: Math.hypot(vx, vy) * 60, towardDeg };
}

/**
 * The intensity field of a frame, computed once and cached on it.
 *
 * @param {{grid: Float32Array, field?: Float32Array}} f
 * @returns {Float32Array}
 */
function fieldOf(f) {
  if (!f.field) f.field = intensity(f.grid);
  return f.field;
}

/**
 * Motion vector from a sequence of scans, newest last.
 *
 * Coarse to fine: the SHORTEST baseline is searched in full (it cannot
 * alias onto a different rain band, but resolves speed only to
 * ~12 km/h per cell), then each longer baseline is searched in a small
 * window around the motion found so far and, when it correlates, takes
 * over — a 15-min baseline resolves the same cell to ~4 km/h. A peak on
 * a window edge is never accepted: the true match may lie outside.
 *
 * @param {Array<{grid: Float32Array, epoch: Number}>} frames oldest → newest
 * @returns {{vx: Number, vy: Number, speedKmh: Number, towardDeg: Number, ncc: Number, baselineMin: Number, echoCells: Number, shift: {dj: Number, di: Number}, dtMin: Number, frame: Object}|null}
 *   vx east / vy north in km per minute; null when no baseline correlates
 */
function estimateMotion(frames) {
  const newest = frames[frames.length - 1];
  const b = fieldOf(newest);
  const older = frames.slice(0, -1)
    .map((f) => ({ frame: f, dtMin: (newest.epoch - f.epoch) / 60000 }))
    .filter((f) => f.dtMin > 0.5)
    .sort((p, q) => p.dtMin - q.dtMin);
  let motion = null;
  for (const { frame, dtMin } of older) {
    const full = Math.ceil((MAX_SPEED_KM_PER_MIN * dtMin) / GRID_CELL_KM);
    let s;
    if (!motion) {
      s = correlate(fieldOf(frame), b, full);
      if (!s) return null;
      if (s.ncc < MIN_NCC || s.atEdge) return null;
    } else {
      const centre = { dj: (motion.vx * dtMin) / GRID_CELL_KM, di: (-motion.vy * dtMin) / GRID_CELL_KM };
      const slack = Math.ceil(REFINE_SLACK_CELLS + REFINE_SLACK_FRACTION * Math.hypot(centre.dj, centre.di));
      s = correlate(fieldOf(frame), b, Math.min(slack, full), centre);
      if (!s || s.ncc < MIN_NCC || s.atEdge) continue;
    }
    motion = {
      ...vectorFromShift(s, dtMin),
      ncc: s.ncc,
      baselineMin: Math.round(dtMin),
      echoCells: s.echoCells,
      shift: { dj: s.dj, di: s.di },
      dtMin,
      frame,
    };
  }
  return motion;
}

/**
 * Local motion field: a 3 × 3 array of vectors around the pin, each from
 * the same baseline as the global vector and searched only close to it,
 * so a block follows the shear of its own part of the band without ever
 * jumping to a different echo. Blocks with too little echo or a poor
 * match fall back to the global vector.
 *
 * @param {Array<Object>} frames as passed to estimateMotion
 * @param {Object} motion estimateMotion result
 * @returns {{spacingKm: Number, vectors: Array<{vx: Number, vy: Number, ncc: Number|null, local: Boolean}>}} row-major, north-west first
 */
function estimateLocalField(frames, motion) {
  const newest = frames[frames.length - 1];
  const a = fieldOf(motion.frame);
  const b = fieldOf(newest);
  const c = (GRID_N - 1) / 2;
  const h = LOCAL_BLOCK_HALF_KM / GRID_CELL_KM;
  const step = LOCAL_BLOCK_SPACING_KM / GRID_CELL_KM;
  const centre = { dj: motion.shift.dj, di: motion.shift.di };
  const vectors = [];
  for (const bi of [-1, 0, 1]) {
    for (const bj of [-1, 0, 1]) {
      const core = { ci: c + bi * step, cj: c + bj * step, h };
      const s = correlate(a, b, LOCAL_SLACK_CELLS, centre, core);
      if (s && s.ncc >= LOCAL_MIN_NCC && !s.atEdge) {
        const v = vectorFromShift(s, motion.dtMin);
        vectors.push({ vx: v.vx, vy: v.vy, ncc: s.ncc, local: true });
      } else {
        vectors.push({ vx: motion.vx, vy: motion.vy, ncc: null, local: false });
      }
    }
  }
  return { spacingKm: LOCAL_BLOCK_SPACING_KM, vectors };
}

/**
 * Vector of the local field at a point (nearest block), or the global one.
 *
 * @param {Object|null} field estimateLocalField result
 * @param {{vx: Number, vy: Number}} motion global vector
 * @param {Number} xKm east of home
 * @param {Number} yKm north of home
 * @returns {{vx: Number, vy: Number}}
 */
function vectorAt(field, motion, xKm, yKm) {
  if (!field) return motion;
  const bj = Math.max(-1, Math.min(1, Math.round(xKm / field.spacingKm)));
  const bi = Math.max(-1, Math.min(1, Math.round(-yKm / field.spacingKm)));
  return field.vectors[(bi + 1) * 3 + (bj + 1)];
}

/**
 * Growth / decay along the motion: the newest intensity over the core,
 * against the baseline frame shifted into place, in dB per hour.
 *
 * @param {Array<Object>} frames
 * @param {Object} motion estimateMotion result
 * @returns {{dbPerHour: Number, areaRatio: Number, label: String}|null}
 */
function estimateTrend(frames, motion) {
  const newest = frames[frames.length - 1];
  const a = fieldOf(motion.frame);
  const b = fieldOf(newest);
  const c = (GRID_N - 1) / 2;
  const h = CORR_HALF_KM / GRID_CELL_KM;
  const dj = Math.round(motion.shift.dj);
  const di = Math.round(motion.shift.di);
  let sumA = 0;
  let sumB = 0;
  let wetA = 0;
  let wetB = 0;
  for (let i = c - h; i <= c + h; i += 1) {
    for (let j = c - h; j <= c + h; j += 1) {
      const vb = b[i * GRID_N + j];
      const va = a[(i - di) * GRID_N + (j - dj)];
      sumA += va;
      sumB += vb;
      if (va > 0) wetA += 1;
      if (vb > 0) wetB += 1;
    }
  }
  if (sumA <= 0 || sumB <= 0) return null;
  // Intensity is dBZ above the floor, so its mean over the wet area is a
  // mean dBZ excess; the change in that mean per hour is the trend.
  const meanA = sumA / Math.max(1, wetA);
  const meanB = sumB / Math.max(1, wetB);
  const perHour = ((meanB - meanA) / motion.dtMin) * 60;
  const dbPerHour = Math.max(-TREND_MAX_DB_PER_HOUR, Math.min(TREND_MAX_DB_PER_HOUR, perHour));
  const areaRatio = wetA ? wetB / wetA : 1;
  let label = "steady";
  if (dbPerHour >= 3 || areaRatio >= 1.3) label = "growing";
  if (dbPerHour <= -3 || areaRatio <= 0.7) label = "decaying";
  return { dbPerHour: Math.round(dbPerHour * 10) / 10, areaRatio: Math.round(areaRatio * 100) / 100, label };
}

/**
 * The ensemble of motion perturbations: (speed factor, direction offset,
 * weight) triples, spread by the correlation quality, plus the previous
 * nowcast's vector when it is recent.
 *
 * @param {Object} motion estimateMotion result
 * @param {{vx: Number, vy: Number, epoch: Number}|null} previous last nowcast's vector
 * @param {Object} features featureSet
 * @param {Number} nowEpoch scan epoch
 * @returns {Array<{speedFactor: Number, dirOffsetDeg: Number, weight: Number, base: {vx: Number, vy: Number}, previous: Boolean}>}
 */
function ensembleMembers(motion, previous, features, nowEpoch) {
  const base = { vx: motion.vx, vy: motion.vy };
  if (!features.ensemble) return [{ speedFactor: 1, dirOffsetDeg: 0, weight: 1, base, previous: false }];
  const q = Math.max(0, Math.min(1, 1 - motion.ncc));
  const speedSpread = SPEED_SPREAD_MIN + SPEED_SPREAD_PER_NCC * q;
  const dirSpread = DIR_SPREAD_MIN_DEG + DIR_SPREAD_PER_NCC_DEG * q;
  const members = [];
  for (const sf of ENSEMBLE_SPEED_STEPS) {
    for (const df of ENSEMBLE_DIR_STEPS) {
      // Triangular weighting: the centre counts most.
      const w = (1.5 - Math.abs(sf)) * (1.5 - Math.abs(df));
      members.push({
        speedFactor: 1 + sf * speedSpread, dirOffsetDeg: df * dirSpread, weight: w, base, previous: false,
      });
    }
  }
  const total = members.reduce((s, m) => s + m.weight, 0);
  for (const m of members) m.weight /= total;
  if (features.persist && previous && nowEpoch - previous.epoch <= PREVIOUS_MAX_AGE_MS
    && previous.epoch < nowEpoch && Number.isFinite(previous.vx) && Number.isFinite(previous.vy)) {
    for (const m of members) m.weight *= 1 - PREVIOUS_WEIGHT;
    const prevBase = { vx: previous.vx, vy: previous.vy };
    const prevSteps = [[-0.5, 0], [0, 0], [0.5, 0], [0, -0.5], [0, 0.5]];
    for (const [sf, df] of prevSteps) {
      members.push({
        speedFactor: 1 + sf * speedSpread,
        dirOffsetDeg: df * dirSpread,
        weight: PREVIOUS_WEIGHT / prevSteps.length,
        base: prevBase,
        previous: true,
      });
    }
  }
  return members;
}

/**
 * Where a member's air parcel that reaches home at `leadMin` is NOW: walk
 * back through the local field in 5-min steps, applying the member's
 * perturbation to each step.
 *
 * @param {Object} member ensemble member
 * @param {Object|null} field local field
 * @param {Number} leadMin
 * @returns {{x: Number, y: Number}} km east / north of home
 */
function upstreamPoint(member, field, leadMin) {
  let x = 0;
  let y = 0;
  const rad = (member.dirOffsetDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let remaining = leadMin;
  while (remaining > 0) {
    const dt = Math.min(LEAD_STEP_MIN, remaining);
    const v = vectorAt(field, member.base, x, y);
    // Rotate by the direction offset (clockwise positive, like bearings).
    const vx = (v.vx * cos + v.vy * sin) * member.speedFactor;
    const vy = (-v.vx * sin + v.vy * cos) * member.speedFactor;
    x -= vx * dt;
    y -= vy * dt;
    remaining -= dt;
  }
  return { x, y };
}

/**
 * Footprint bounds around a point, or null when it leaves the grid.
 *
 * @param {Number} xKm
 * @param {Number} yKm
 * @returns {{i0: Number, j0: Number}|null} centre row / col
 */
function footprintAt(xKm, yKm) {
  const c = (GRID_N - 1) / 2;
  const h = SAMPLE_HALF;
  const j0 = Math.round(c + xKm / GRID_CELL_KM);
  const i0 = Math.round(c - yKm / GRID_CELL_KM);
  if (i0 < h || j0 < h || i0 > GRID_N - 1 - h || j0 > GRID_N - 1 - h) return null;
  return { i0, j0 };
}

/**
 * dBZ at a grid point over its (2·SAMPLE_HALF + 1)² neighbourhood: the
 * maximum, and the mean of the cells that hold rain (≥ RAIN_DBZ).
 *
 * @param {Float32Array} grid dBZ grid
 * @param {Number} xKm east of home
 * @param {Number} yKm north of home
 * @returns {{max: Number, rainMean: Number, rainCells: Number, raining: Boolean}|null} null when outside the grid
 */
function sampleGrid(grid, xKm, yKm) {
  const at = footprintAt(xKm, yKm);
  if (!at) return null;
  const h = SAMPLE_HALF;
  let max = -Infinity;
  let sum = 0;
  let rainCells = 0;
  for (let i = at.i0 - h; i <= at.i0 + h; i += 1) {
    for (let j = at.j0 - h; j <= at.j0 + h; j += 1) {
      const v = grid[i * GRID_N + j];
      if (v > max) max = v;
      if (v >= RAIN_DBZ) {
        sum += v;
        rainCells += 1;
      }
    }
  }
  // Rain / no rain needs a MAJORITY of the neighbourhood wet: one wet
  // cell is the edge of a band or a stray gate, while a 1 km miss of a
  // solid band still leaves most of the footprint wet.
  return {
    max, rainMean: rainCells ? sum / rainCells : -Infinity, rainCells, raining: rainCells >= SAMPLE_MAJORITY,
  };
}

/**
 * Is the MRMS surface field wet at a point (footprint majority ≥ MRMS_WET_MM_H)?
 *
 * @param {Float32Array} rateGrid projected MRMS rate
 * @param {Number} xKm
 * @param {Number} yKm
 * @param {Number} [wetMmh] wet threshold, mm/h
 * @returns {{wet: Boolean, rate: Number}|null} null when outside the grid
 */
function sampleRate(rateGrid, xKm, yKm, wetMmh = MRMS_WET_MM_H) {
  const at = footprintAt(xKm, yKm);
  if (!at) return null;
  const h = SAMPLE_HALF;
  let wetCells = 0;
  let sum = 0;
  for (let i = at.i0 - h; i <= at.i0 + h; i += 1) {
    for (let j = at.j0 - h; j <= at.j0 + h; j += 1) {
      const v = rateGrid[i * GRID_N + j];
      if (v >= wetMmh) {
        wetCells += 1;
        sum += v;
      }
    }
  }
  return { wet: wetCells >= SAMPLE_MAJORITY, rate: wetCells ? sum / wetCells : 0 };
}

/**
 * Dominant precipitation group over the footprint (rain / snow / mix /
 * graupel / hail), or "none" when no cell carries a weather class.
 *
 * @param {Uint8Array} classGrid projected N0H groups
 * @param {Number} xKm
 * @param {Number} yKm
 * @returns {String}
 */
function samplePtype(classGrid, xKm, yKm) {
  const at = footprintAt(xKm, yKm);
  if (!at) return "none";
  const h = SAMPLE_HALF;
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = at.i0 - h; i <= at.i0 + h; i += 1) {
    for (let j = at.j0 - h; j <= at.j0 + h; j += 1) counts[classGrid[i * GRID_N + j]] += 1;
  }
  let best = 0;
  for (let g = 1; g < counts.length; g += 1) if (counts[g] > (best ? counts[best] : 0)) best = g;
  return PTYPE_OF_GROUP[best] || "none";
}

/**
 * Advect the newest grid over the pin with the ensemble: at each lead,
 * the weighted fraction of members that find rain is the probability.
 *
 * @param {Float32Array} grid newest dBZ grid
 * @param {Object|null} motion estimateMotion result (null: persistence only)
 * @param {Object} [ctx]
 * @param {Array<Object>} [ctx.members] ensembleMembers result
 * @param {Object|null} [ctx.field] local field
 * @param {Object|null} [ctx.trend] estimateTrend result
 * @param {Float32Array|null} [ctx.rateGrid] MRMS rate on the home grid
 * @param {Uint8Array|null} [ctx.classGrid] N0H groups on the home grid
 * @param {Object} [ctx.features]
 * @param {"veto"|"blend"} [ctx.mrmsMode] how the surface field enters (default MRMS_MODE)
 * @param {Number} [ctx.mrmsWet] surface wet threshold, mm/h (default MRMS_WET_MM_H)
 * @returns {Array<Object>} one entry per lead: {leadMin, prob, probRadar, probMrms, dbz, dbzMax, category, rateMmh, ptype}
 */
function advectSeries(grid, motion, ctx = {}) {
  const features = ctx.features || featureSet();
  const mrmsMode = ctx.mrmsMode || MRMS_MODE;
  const mrmsWet = ctx.mrmsWet || MRMS_WET_MM_H;
  const members = motion
    ? (ctx.members || [{ speedFactor: 1, dirOffsetDeg: 0, weight: 1, base: { vx: motion.vx, vy: motion.vy } }])
    : [{ speedFactor: 1, dirOffsetDeg: 0, weight: 1, base: { vx: 0, vy: 0 } }];
  const field = features.local ? ctx.field || null : null;
  const trendDb = features.trend && ctx.trend ? ctx.trend.dbPerHour : 0;
  const series = [];
  for (let lead = 0; lead <= HORIZON_MIN; lead += LEAD_STEP_MIN) {
    let wetW = 0;
    let totalW = 0;
    let mrmsWetW = 0;
    let mrmsTotalW = 0;
    let dbzSum = 0;
    let dbzW = 0;
    let dbzMax = -Infinity;
    let central = null;
    const adjust = Math.max(-TREND_MAX_TOTAL_DB, Math.min(TREND_MAX_TOTAL_DB, (trendDb * lead) / 60));
    for (const m of members) {
      const p = upstreamPoint(m, field, lead);
      const s = sampleGrid(grid, p.x, p.y);
      if (!s) continue; // this member's parcel is off the grid
      totalW += m.weight;
      const adjusted = Number.isFinite(s.rainMean) ? s.rainMean + adjust : -Infinity;
      const wet = s.raining && adjusted >= RAIN_DBZ;
      if (wet) {
        wetW += m.weight;
        dbzSum += adjusted * m.weight;
        dbzW += m.weight;
      }
      if (Number.isFinite(s.max) && s.max + adjust > dbzMax) dbzMax = s.max + adjust;
      if (!central && m.speedFactor === 1 && m.dirOffsetDeg === 0 && !m.previous) central = p;
      if (ctx.rateGrid) {
        const r = sampleRate(ctx.rateGrid, p.x, p.y, mrmsWet);
        if (r) {
          mrmsTotalW += m.weight;
          if (r.wet) mrmsWetW += m.weight;
        }
      }
    }
    // The horizon ends where most of the ensemble has left the grid: rain
    // that would arrive from beyond the radar's view is unknowable here.
    if (totalW < 0.5) break;
    const probRadar = wetW / totalW;
    const probMrms = ctx.rateGrid && mrmsTotalW > 0 ? mrmsWetW / mrmsTotalW : null;
    let prob = probRadar;
    if (probMrms !== null && features.mrms) {
      prob = mrmsMode === "blend"
        ? (1 - MRMS_WEIGHT) * probRadar + MRMS_WEIGHT * probMrms
        : probRadar * (MRMS_VETO_FLOOR + (1 - MRMS_VETO_FLOOR) * probMrms);
    }
    const raining = prob >= P_RAIN;
    const dbz = dbzW > 0 ? Math.round((dbzSum / dbzW) * 2) / 2 : null;
    let ptype = "none";
    if (raining) {
      ptype = ctx.classGrid && features.ptype && central ? samplePtype(ctx.classGrid, central.x, central.y) : "rain";
      if (ptype === "none") ptype = "rain";
    }
    series.push({
      leadMin: lead,
      prob: Math.round(prob * 100) / 100,
      probRadar: Math.round(probRadar * 100) / 100,
      probMrms: probMrms === null ? null : Math.round(probMrms * 100) / 100,
      dbz: raining ? (dbz ?? RAIN_DBZ) : dbz,
      dbzMax: Number.isFinite(dbzMax) ? Math.round(dbzMax * 2) / 2 : null,
      category: raining ? categoryFor(Math.max(dbz ?? RAIN_DBZ, RAIN_DBZ)) : "none",
      rateMmh: raining ? rateForDbz(dbz ?? RAIN_DBZ) : 0,
      ptype,
    });
  }
  return series;
}

/**
 * Turn the series into the sentences the card prints.
 *
 * @param {Array<Object>} series from advectSeries
 * @returns {{now: Object, arrival: Object|null, peak: Object|null, end: Object|null, horizonMin: Number}}
 */
function summarize(series) {
  const rainAt = series.map((s) => s.prob >= P_RAIN);
  const persistentAt = (k) => {
    for (let m = 0; m < PERSIST_STEPS; m += 1) {
      if (k + m >= rainAt.length) return k + m === rainAt.length && m > 0; // the horizon edge counts
      if (!rainAt[k + m]) return false;
    }
    return true;
  };
  const dryAt = (k) => {
    for (let m = 0; m < PERSIST_STEPS; m += 1) {
      if (k + m >= rainAt.length) return true;
      if (rainAt[k + m]) return false;
    }
    return true;
  };
  const first = series[0] || {
    prob: 0, dbz: null, category: "none", rateMmh: 0, ptype: "none",
  };
  const now = {
    raining: Boolean(rainAt[0] && (rainAt.length === 1 || rainAt[1] || (first.dbz ?? 0) >= 25)),
    prob: first.prob,
    dbz: first.dbz,
    category: first.category,
    rateMmh: first.rateMmh,
    ptype: first.ptype,
  };
  let start = now.raining ? 0 : -1;
  if (!now.raining) {
    for (let k = 1; k < series.length; k += 1) {
      if (persistentAt(k)) {
        start = k;
        break;
      }
    }
  }
  let arrival = null;
  let peak = null;
  let end = null;
  if (start >= 0) {
    if (start > 0) {
      // The arrival RANGE: from the first step the ensemble gives rain a
      // real chance to the first it calls likely. Quoted as "20–35 min".
      let earliest = start;
      for (let k = 1; k <= start; k += 1) {
        if (series[k].prob >= P_EARLIEST) {
          earliest = k;
          break;
        }
      }
      let latest = null;
      for (let k = start; k < series.length; k += 1) {
        if (series[k].prob >= P_LATEST) {
          latest = k;
          break;
        }
        if (!rainAt[k]) break;
      }
      arrival = {
        leadMin: series[start].leadMin,
        earliestMin: series[earliest].leadMin,
        latestMin: latest === null ? null : series[latest].leadMin,
        prob: series[start].prob,
        category: series[start].category,
        dbz: series[start].dbz,
        ptype: series[start].ptype,
      };
    }
    let endIdx = -1;
    for (let k = start + 1; k < series.length; k += 1) {
      if (dryAt(k)) {
        endIdx = k;
        break;
      }
    }
    const last = endIdx >= 0 ? endIdx : series.length;
    let best = series[start];
    for (let k = start; k < last; k += 1) {
      if ((series[k].dbz ?? -Infinity) > (best.dbz ?? -Infinity)) best = series[k];
    }
    peak = {
      leadMin: best.leadMin, category: best.category, dbz: best.dbz, rateMmh: best.rateMmh, ptype: best.ptype,
    };
    if (endIdx >= 0) {
      // How sure is the end: the probability of rain just past it.
      end = { leadMin: series[endIdx].leadMin, prob: series[endIdx].prob };
    }
  }
  return {
    now, arrival, peak, end, horizonMin: series.length ? series[series.length - 1].leadMin : 0,
  };
}

/**
 * Confidence label from the motion fit, the ensemble's agreement at the
 * key event and how far out it is.
 *
 * @param {Object|null} motion estimateMotion result
 * @param {Number|null} keyLeadMin lead of the arrival (or end) being reported
 * @param {Number|null} [keyProb] probability at that lead
 * @returns {"high"|"medium"|"low"|"unknown"}
 */
function confidenceFor(motion, keyLeadMin, keyProb = null) {
  if (!motion) return "unknown";
  let level = motion.ncc >= 0.7 ? "high" : (motion.ncc >= 0.5 ? "medium" : "low");
  // Agreement: how far the ensemble is from a coin toss at the key lead.
  if (keyProb !== null && Math.abs(keyProb - 0.5) < 0.2 && level === "high") level = "medium";
  if (keyLeadMin !== null && keyLeadMin > 45 && level === "high") level = "medium";
  if (keyLeadMin !== null && keyLeadMin > 75 && level === "medium") level = "low";
  return level;
}

/**
 * The nowcast for a home point from a set of decoded scans (oldest →
 * newest). Pure: no network, no cache — the hindcast harness calls it too.
 *
 * @param {Array<Object>} scans radial payloads, available:true, oldest first
 * @param {{lat: Number, lon: Number}} home
 * @param {Object} [opts]
 * @param {Object|null} [opts.classification] decoded N0H payload for the newest scan
 * @param {{g: Object, samples: Uint16Array, validTime: String}|null} [opts.mrms] decoded MRMS PrecipRate near the newest scan
 * @param {{vx: Number, vy: Number, epoch: Number}|null} [opts.previous] the previous nowcast's vector for this pin
 * @param {Iterable<String>} [opts.disable] features to switch off
 * @param {Iterable<String>} [opts.enable] features to switch on (MRMS is off by default)
 * @param {Float32Array|null} [opts.rateGrid] MRMS rate already on the home grid (harness shortcut; overrides opts.mrms)
 * @param {"veto"|"blend"} [opts.mrmsMode] harness override of MRMS_MODE
 * @param {Number} [opts.mrmsWet] harness override of MRMS_WET_MM_H
 * @returns {Object} nowcast payload without the transport fields
 */
function nowcastFromScans(scans, home, opts = {}) {
  const features = featureSet(opts.disable, opts.enable);
  const frames = scans.map((p) => ({ grid: projectToGrid(p, home), epoch: Date.parse(p.scanTime) }));
  const newest = frames[frames.length - 1];
  const motion = frames.length > 1 ? estimateMotion(frames) : null;
  const field = motion && features.local ? estimateLocalField(frames, motion) : null;
  const trend = motion && features.trend ? estimateTrend(frames, motion) : null;
  const members = motion ? ensembleMembers(motion, opts.previous || null, features, newest.epoch) : null;

  // MRMS surface rate: only when it is FRESH relative to the scan, else
  // the ground truth would lag the radar by more than one volume scan.
  let rateGrid = null;
  let mrmsInfo = null;
  if (features.mrms && opts.rateGrid) {
    rateGrid = opts.rateGrid;
    mrmsInfo = { validTime: null, skewMin: null, mode: opts.mrmsMode || MRMS_MODE, weight: 1 };
  } else if (features.mrms && opts.mrms) {
    const skew = Date.parse(opts.mrms.validTime || "") - newest.epoch;
    if (Number.isFinite(skew) && Math.abs(skew) <= MRMS_MAX_SKEW_MS) {
      rateGrid = projectMrmsGrid(opts.mrms, home);
      mrmsInfo = { validTime: opts.mrms.validTime, skewMin: Math.round(skew / 60000), mode: MRMS_MODE, weight: 1 };
    } else {
      mrmsInfo = {
        validTime: opts.mrms.validTime || null,
        skewMin: Number.isFinite(skew) ? Math.round(skew / 60000) : null,
        weight: 0,
        reason: "stale",
      };
    }
  }
  const classGrid = features.ptype && opts.classification ? projectClassGrid(opts.classification, home) : null;

  const series = advectSeries(newest.grid, motion, {
    members, field, trend, rateGrid, classGrid, features, mrmsMode: opts.mrmsMode, mrmsWet: opts.mrmsWet,
  });
  const summary = summarize(series);
  const key = summary.arrival || summary.end;
  let echoCells = 0;
  for (let k = 0; k < newest.grid.length; k += 1) if (newest.grid[k] >= RAIN_DBZ) echoCells += 1;
  return {
    ...summary,
    series,
    motion: motion ? {
      speedKmh: Math.round(motion.speedKmh),
      towardDeg: Math.round(motion.towardDeg),
      fromDeg: Math.round((motion.towardDeg + 180) % 360),
      quality: Math.round(motion.ncc * 100) / 100,
      baselineMin: motion.baselineMin,
      vx: motion.vx,
      vy: motion.vy,
      localBlocks: field ? field.vectors.filter((v) => v.local).length : 0,
    } : null,
    trend,
    ensemble: members ? { members: members.length, previousUsed: members.some((m) => m.previous) } : null,
    mrms: mrmsInfo,
    classification: classGrid ? { product: CLASS_PRODUCT, scanTime: opts.classification.scanTime || null } : null,
    confidence: confidenceFor(motion, key ? key.leadMin : null, key ? key.prob : null),
    echoCellsInRange: echoCells,
    gridKm: GRID_HALF_KM,
    rainDbz: RAIN_DBZ,
    features,
    hindcast: HINDCAST,
  };
}

// ---------------------------------------------------------------------
// Live verification
// ---------------------------------------------------------------------

/**
 * Scores per pin. `pending` holds issued forecasts waiting for their
 * verifying scan; `scores` accumulates per lead.
 *
 * @type {Map<String, {pending: Array, scores: Object, updatedAt: Number}>}
 */
const verification = new Map();
let skillLoaded = false;

/**
 * Fresh per-lead score table.
 *
 * @returns {Object}
 */
function emptyScores() {
  const out = {};
  for (const L of VERIFY_LEADS) {
    out[L] = {
      hit: 0, miss: 0, fa: 0, cn: 0, brier: 0, n: 0,
    };
  }
  return out;
}

/**
 * Load the persisted live scores (once, best effort).
 */
function loadSkill() {
  if (skillLoaded) return;
  skillLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(SKILL_FILE, "utf8"));
    for (const [key, v] of Object.entries(raw || {})) {
      if (v && v.scores) {
        verification.set(key, { pending: [], scores: { ...emptyScores(), ...v.scores }, updatedAt: v.updatedAt || 0 });
      }
    }
  } catch {
    // No file yet, or no filesystem (the app): start empty.
  }
}

/**
 * Persist the live scores (best effort, never throws).
 */
function saveSkill() {
  try {
    const out = {};
    for (const [key, v] of verification) out[key] = { scores: v.scores, updatedAt: v.updatedAt };
    fs.mkdirSync(path.dirname(SKILL_FILE), { recursive: true });
    fs.writeFileSync(SKILL_FILE, JSON.stringify(out));
  } catch {
    // Read-only or absent filesystem: in-memory only.
  }
}

/**
 * Per-lead live scores in the payload's shape.
 *
 * @param {{scores: Object, updatedAt: Number}} v
 * @returns {{leads: Object, updatedAt: Number|null}}
 */
function liveSkillFor(v) {
  const leads = {};
  for (const L of VERIFY_LEADS) {
    const c = v.scores[L];
    const events = c.hit + c.miss;
    const calls = c.hit + c.fa;
    leads[L] = {
      leadMin: L,
      n: c.n,
      hit: c.hit,
      miss: c.miss,
      falseAlarm: c.fa,
      correctNegative: c.cn,
      pod: events ? Math.round((c.hit / events) * 100) / 100 : null,
      far: calls ? Math.round((c.fa / calls) * 100) / 100 : null,
      csi: (c.hit + c.miss + c.fa) ? Math.round((c.hit / (c.hit + c.miss + c.fa)) * 100) / 100 : null,
      brier: c.n ? Math.round((c.brier / c.n) * 1000) / 1000 : null,
    };
  }
  return { leads, updatedAt: v.updatedAt || null };
}

/**
 * Score pending forecasts for a pin against the newest scan, then queue
 * this nowcast for scoring later.
 *
 * @param {String} key `${site}:${lat},${lon}`
 * @param {Number} scanEpoch newest scan time
 * @param {Float32Array} newestGrid its projection on the home grid
 * @param {Array<Object>} series this nowcast's series
 * @returns {Object} per-lead summary for the payload
 */
function verifyAndRecord(key, scanEpoch, newestGrid, series) {
  loadSkill();
  let v = verification.get(key);
  if (!v) {
    v = { pending: [], scores: emptyScores(), updatedAt: 0 };
    verification.set(key, v);
  }
  const s = sampleGrid(newestGrid, 0, 0);
  const actual = Boolean(s && s.raining);
  let changed = false;
  for (const f of v.pending) {
    for (const L of VERIFY_LEADS) {
      if (f.done[L]) continue;
      const target = f.epoch + L * 60000;
      if (Math.abs(scanEpoch - target) > VERIFY_MATCH_MS) continue;
      const prob = f.probs[L];
      f.done[L] = true;
      if (prob === undefined) continue;
      const c = v.scores[L];
      const predicted = prob >= P_RAIN;
      if (predicted && actual) c.hit += 1;
      else if (predicted) c.fa += 1;
      else if (actual) c.miss += 1;
      else c.cn += 1;
      c.brier += (prob - (actual ? 1 : 0)) ** 2;
      c.n += 1;
      changed = true;
    }
  }
  v.pending = v.pending.filter((f) => scanEpoch - f.epoch <= VERIFY_PENDING_MAX_MS && !VERIFY_LEADS.every((L) => f.done[L]));
  if (!v.pending.some((f) => f.epoch === scanEpoch)) {
    const probs = {};
    for (const L of VERIFY_LEADS) {
      const step = series.find((x) => x.leadMin === L);
      if (step) probs[L] = step.prob;
    }
    v.pending.push({ epoch: scanEpoch, probs, done: {} });
  }
  if (changed) {
    v.updatedAt = Date.now();
    saveSkill();
  }
  return liveSkillFor(v);
}

// ---------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------

/**
 * The last NUM_SCANS reflectivity keys for a site, oldest first.
 *
 * @param {String} site 3-letter radar id
 * @returns {Promise<Array<String>>}
 */
async function recentKeys(site) {
  const now = Date.now();
  const keys = [];
  for (let back = 0; back < 3 && keys.length < NUM_SCANS; back += 1) {
    // eslint-disable-next-line no-await-in-loop -- newest hour first
    const hour = await listHourKeys(site, PRODUCT, new Date(now - back * 3600 * 1000));
    keys.unshift(...hour);
  }
  return keys.slice(-NUM_SCANS);
}

/**
 * The N0H classification for a scan, or null (never throws).
 *
 * @param {String} site
 * @param {Number} scanEpoch
 * @returns {Promise<Object|null>}
 */
async function fetchClassification(site, scanEpoch) {
  try {
    const key = await keyForEpoch(site, CLASS_PRODUCT, scanEpoch);
    increment("nexrad-l3", "nowcast-class-list");
    if (!key) return null;
    const cls = await fetchRadialByKey(site, CLASS_PRODUCT, key, false);
    return cls && cls.available ? cls : null;
  } catch {
    return null;
  }
}

/**
 * The MRMS PrecipRate field nearest a time, decoded and shared (one copy
 * resident). Null when none is close enough or the fetch fails.
 *
 * @param {Number} epoch target time
 * @returns {Promise<{g: Object, samples: Uint16Array, validTime: String}|null>}
 */
async function fetchMrmsRate(epoch) {
  try {
    const key = await keyNearest(MRMS_RATE_PRODUCT, epoch, MRMS_MAX_SKEW_MS);
    increment("mrms", "nowcast-rate-list");
    if (!key) return null;
    if (mrmsLatest && mrmsLatest.key === key) return mrmsLatest;
    if (mrmsInflight && mrmsInflight.key === key) return mrmsInflight.promise;
    const promise = fetchGrid(key, "nowcast-rate").then((r) => {
      mrmsLatest = r;
      return r;
    }).finally(() => {
      if (mrmsInflight && mrmsInflight.key === key) mrmsInflight = null;
    });
    mrmsInflight = { key, promise };
    return await promise;
  } catch (err) {
    recordServiceCall("MRMS (precip type)", err?.response?.status || 500, `nowcast rate unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Cached nowcast for a site and home point.
 *
 * @param {String} site
 * @param {{lat: Number, lon: Number}} home
 * @returns {Promise<Object>} payload for /api/radar/nowcast
 */
async function fetchNowcast(site, home) {
  const keys = await recentKeys(site);
  increment("nexrad-l3", "nowcast-list");
  if (!keys.length) {
    recordServiceCall(SERVICE_NAME, 200, `no recent scans for ${site}`);
    return { available: false, site, reason: "no-recent-scans" };
  }
  const newestKey = keys[keys.length - 1];
  const pinKey = `${site}:${home.lat.toFixed(3)},${home.lon.toFixed(3)}`;
  const cacheKey = `${pinKey}:${newestKey}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const scans = (await Promise.all(keys.map((k) => fetchRadialByKey(site, PRODUCT, k, true))))
    .filter((p) => p && p.available && Number.isFinite(Date.parse(p.scanTime)));
  if (!scans.length) {
    return { available: false, site, reason: "no-decodable-scans" };
  }
  const newest = scans[scans.length - 1];
  const scanEpoch = Date.parse(newest.scanTime);
  const features = featureSet();
  const [classification, mrms] = await Promise.all([
    features.ptype ? fetchClassification(site, scanEpoch) : null,
    features.mrms ? fetchMrmsRate(scanEpoch) : null,
  ]);
  const t0 = Date.now();
  const previous = previousMotion.get(pinKey) || null;
  const core = nowcastFromScans(scans, home, { classification, mrms, previous });
  if (core.motion) previousMotion.set(pinKey, { vx: core.motion.vx, vy: core.motion.vy, epoch: scanEpoch });
  const liveSkill = verifyAndRecord(pinKey, scanEpoch, projectToGrid(newest, home), core.series);
  const value = {
    available: true,
    site,
    home,
    scanTime: newest.scanTime,
    scans: scans.map((p) => p.key),
    cleaned: scans.every((p) => p.clean && p.clean.applied),
    ...core,
    liveSkill,
    computedIn: Date.now() - t0,
  };
  cache.set(cacheKey, { value, expires: Date.now() + NOWCAST_TTL_MS });
  const m = value.motion ? `${value.motion.speedKmh} km/h toward ${value.motion.towardDeg}° (ncc ${value.motion.quality})` : "motion unknown";
  const what = value.now.raining
    ? `${value.now.ptype} now`
    : (value.arrival ? `${value.arrival.ptype} in ${value.arrival.leadMin} min (p ${value.arrival.prob})` : "dry");
  recordServiceCall(SERVICE_NAME, 200, `${site} nowcast: ${what}, ${m}${value.mrms && value.mrms.weight ? ", +MRMS" : ""}`);
  return value;
}

/**
 * GET /api/radar/nowcast?lat=&lon=[&site=]
 *
 * The site follows the same precedence as /api/radar/frames: the
 * settings.json override, then an explicit `site` query, then the radar
 * nearest the pin. The pin is the HOME the nowcast is for, so the site
 * is always the one that covers the pin, never the one the map view is
 * on.
 *
 * @param {Object} req
 * @param {Object} res
 */
async function getNowcast(req, res) {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json("Invalid or missing lat/lon").end();
  }
  const querySite = String(req.query.site || "").trim().toUpperCase();
  if (querySite && !/^[A-Z]{3,4}$/.test(querySite)) return res.status(400).json("Invalid site").end();
  try {
    let site = await overrideSite();
    if (!site && querySite) site = querySite.length === 4 ? querySite.slice(1) : querySite;
    if (!site) site = (await resolveRadarSite(lat, lon)).site;
    const payload = await fetchNowcast(site, { lat, lon });
    return res.status(200).json(payload).end();
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `nowcast failed: ${err.message}`);
    return res.status(503).json({ available: false, reason: "upstream-unavailable" }).end();
  }
}

/**
 * GET /api/radar/nowcast/skill — the live verification scores for every
 * pin this server has nowcast for (the debug panel reads it).
 *
 * @param {Object} req
 * @param {Object} res
 */
function getNowcastSkill(req, res) {
  loadSkill();
  const pins = {};
  for (const [key, v] of verification) pins[key] = { ...liveSkillFor(v), pending: v.pending.length };
  return res.status(200).json({ leads: VERIFY_LEADS, pins, hindcast: HINDCAST }).end();
}

module.exports = {
  getNowcast,
  getNowcastSkill,
  fetchNowcast,
  // Pure pieces, for the hindcast harness and tests.
  nowcastFromScans,
  projectToGrid,
  projectClassGrid,
  projectMrmsGrid,
  estimateMotion,
  estimateShift,
  estimateLocalField,
  estimateTrend,
  ensembleMembers,
  upstreamPoint,
  advectSeries,
  summarize,
  sampleGrid,
  categoryFor,
  rateForDbz,
  featureSet,
  verifyAndRecord,
  HINDCAST,
  GRID_N,
  GRID_CELL_KM,
  GRID_HALF_KM,
  RAIN_DBZ,
  HORIZON_MIN,
  LEAD_STEP_MIN,
  P_RAIN,
  MRMS_RATE_PRODUCT,
  MRMS_MAX_SKEW_MS,
  MRMS_WET_MM_H,
  sampleRate,
};
