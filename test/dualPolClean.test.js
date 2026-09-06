// Tests for the dual-pol clean mode — the third setting of the clear-air
// noise filter, which drops the gates the volume scan's own hydrometeor
// classification calls non-meteorological.
//
// Two halves:
//
//   1. The MASK RULE, against synthetic payloads. Which classes go and
//      which stay is the whole feature, and a hand-built grid pins every
//      branch (including the one that is conditional on reflectivity)
//      without depending on what the weather happened to be doing.
//
//   2. The N0H DECODE, against a committed fixture — LWX at
//      2026-09-06T01:29:38Z, the scan behind the "why is there so much
//      noise even with the filter on" report. Unlike N0B and N0G this
//      product needs no shim (the library ships a definition for 165),
//      so the thing worth pinning is that it stays that way and that the
//      class codes keep their documented meanings.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  applyClassMask,
  gridsAlign,
  MASK_CLASSES,
  BIG_DROPS_RAIN_MIN_DBZ,
  CLASS_PRODUCT,
  PRODUCTS,
  packRadials,
} = require("../server/radarRadialCtrl");
const parseLevel3 = require("nexrad-level-3-data");

const FIXTURE = path.join(__dirname, "fixtures", "LWX_N0H_2026_09_06_01_29_38.bin");

// Product 165's data levels, from the library's own key. The mask is
// written against these numbers, so a change in the library's table
// would silently repoint it.
const BI = 10;   // biological
const GC = 20;   // ground clutter / AP
const RA = 60;   // light and/or moderate rain
const BD = 80;   // big drops (rain)
const UK = 140;  // unknown

const SCALING = { min: -32, increment: 0.5, levels: 254 };
const levelFor = (dbz) => Math.round((dbz - SCALING.min) / SCALING.increment);

/**
 * Build a reflectivity payload and a classification payload over the
 * same tiny grid, one gate per (bucket, bin).
 *
 * @param {Array<Array<Number>>} gates rows of [dBZ, classCode]
 * @param {Number} [classBins] bins the classification covers (default: all)
 * @returns {{refl: Object, cls: Object}} payloads shaped like /api/radar/radial
 */
function grid(gates, classBins = gates.length) {
  const refl = {
    numBuckets: 1,
    numBins: gates.length,
    bucketDeg: 0.5,
    binKm: 0.25,
    firstBinKm: 0,
    reservedLevels: 2,
    scaling: SCALING,
    bins: Buffer.from(gates.map(([dbz]) => levelFor(dbz))).toString("base64"),
  };
  const cls = {
    numBuckets: 1,
    numBins: classBins,
    bucketDeg: 0.5,
    binKm: 0.25,
    firstBinKm: 0,
    reservedLevels: 1,
    scaling: { min: 0, increment: 1, levels: 16 },
    bins: Buffer.from(gates.slice(0, classBins).map(([, c]) => c)).toString("base64"),
  };
  return { refl, cls };
}

const levels = (payload) => [...Buffer.from(payload, "base64")];

test("biological, ground clutter and unknown are masked; weather is not", () => {
  const { refl, cls } = grid([
    [20, BI],   // the nocturnal bloom: masked
    [20, GC],   // clutter: masked
    [20, UK],   // unclassified: masked
    [20, RA],   // light rain at the same dBZ: kept
    [45, RA],   // a core: kept
  ]);
  const { bins, masked, considered } = applyClassMask(refl, cls);
  assert.deepEqual(levels(bins.toString("base64")).map((l) => l !== 0),
                   [false, false, false, true, true]);
  assert.equal(masked, 3);
  assert.equal(considered, 5);
});

test("big drops are masked only below the rain floor", () => {
  // BI and BD were one population in the scan this was built from — same
  // median dBZ, same range band — because insects and genuine big drops
  // share a high differential reflectivity. Intensity is what separates
  // them: real big drops live in convective cores.
  const below = BIG_DROPS_RAIN_MIN_DBZ - 0.5;
  const { refl, cls } = grid([
    [below, BD],
    [BIG_DROPS_RAIN_MIN_DBZ, BD],
    [45, BD],
  ]);
  const { bins, masked } = applyClassMask(refl, cls);
  assert.deepEqual(levels(bins.toString("base64")).map((l) => l !== 0),
                   [false, true, true]);
  assert.equal(masked, 1);
});

test("gates past the classification's range are left alone", () => {
  // The classification reaches 300 km, reflectivity 460. Beyond the
  // shorter product there is no verdict, so there is nothing to act on —
  // and inventing one would blank the outer ring of every scan.
  const { refl, cls } = grid([[20, BI], [20, BI], [20, BI]], 1);
  const { bins, masked, considered } = applyClassMask(refl, cls);
  assert.deepEqual(levels(bins.toString("base64")).map((l) => l !== 0),
                   [false, true, true]);
  assert.equal(masked, 1);
  // `considered` counts the gates there was a verdict for, not every echo
  // gate — so masked/considered reads as "of what could be judged, how
  // much was junk" rather than being diluted by the unjudgeable ring.
  assert.equal(considered, 1);
});

test("below-threshold reflectivity gates are not counted as considered", () => {
  const { refl, cls } = grid([[20, BI], [20, RA]]);
  const b = Buffer.from(refl.bins, "base64");
  b[0] = 0; // below threshold
  refl.bins = b.toString("base64");
  const { masked, considered } = applyClassMask(refl, cls);
  assert.equal(considered, 1);
  assert.equal(masked, 0);
});

test("a mismatched grid is refused rather than misapplied", () => {
  // The mask indexes reflectivity's own bucket/bin grid. A different
  // grid would paint the stencil somewhere else on the map, which is
  // worse than not painting it at all.
  const { refl, cls } = grid([[20, BI]]);
  assert.equal(gridsAlign(refl, cls), true);
  assert.equal(gridsAlign(refl, { ...cls, bucketDeg: 1 }), false);
  assert.equal(gridsAlign(refl, { ...cls, binKm: 1 }), false);
  assert.equal(gridsAlign(refl, { ...cls, firstBinKm: 2 }), false);
  assert.equal(gridsAlign(refl, { ...cls, numBuckets: 360 }), false);
});

test("the mask rule names the classes it claims to", () => {
  assert.deepEqual([...MASK_CLASSES].sort((a, b) => a - b), [BI, GC, UK]);
  assert.equal(BIG_DROPS_RAIN_MIN_DBZ, 30);
  assert.equal(CLASS_PRODUCT, "N0H");
});

test("N0H decodes with no shim, on the grid the mask assumes", () => {
  // Product 165 already exists in nexrad-level-3-data, unlike 153/154 —
  // the controller's shim loop must leave it alone. If a library upgrade
  // ever drops it, this fails here rather than on a kiosk at night.
  const def = PRODUCTS[CLASS_PRODUCT];
  assert.equal(def.code, 165);
  assert.equal(def.kind, "classification");

  const parsed = parseLevel3(fs.readFileSync(FIXTURE));
  const packet = parsed.radialPackets[0];
  assert.equal(parsed.productDescription.elevationAngle, 0.5);
  // 1 degree azimuthally against reflectivity's 0.5, and 300 km of range
  // against 460 — coarser and shorter, which is why the mask is applied
  // by coverage rather than by radial index, and why the outer ring of a
  // 460 km scan keeps its gates.
  assert.equal(packet.radialsRaw.length, 360);
  assert.equal(packet.numberBins, 1200);
  assert.equal(packet.radialsRaw[0].angleDelta, 1);

  // packRadials re-buckets those 1-degree radials into the same 0.5-degree
  // slots reflectivity uses — every slot covered, which is what lets the
  // mask index straight across.
  const packed = packRadials(packet.radialsRaw, packet.numberBins);
  assert.equal(packed.length, 720 * 1200);
  const codes = new Set(packed);
  // The bloom this fixture captured: biological everywhere, almost no rain.
  assert.ok(codes.has(BI), "expected biological gates in the fixture");
  const count = (c) => packed.reduce((n, v) => n + (v === c ? 1 : 0), 0);
  assert.ok(count(BI) > count(RA) * 10,
            `expected a biological bloom, got BI ${count(BI)} vs RA ${count(RA)}`);
});
