// Rainfall accumulation: the shared depth vocabulary, the three Level III
// products' scaling and window metadata (pinned against committed live
// files), and the MRMS QPE mosaic's cell reduction.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const parseLevel3 = require("nexrad-level-3-data");

const accumulation = require("../server/accumulation");
const {
  PRODUCTS, ACCUMULATION_PRODUCTS, accumulationScaling, accumulationMeta,
} = require("../server/radarRadialCtrl");
const qpe = require("../server/mrmsQpeCtrl");
const { rleDecode, rleEncode } = require("../server/precipType");

const FIX = path.join(__dirname, "fixtures");

test("tier ladder round-trips depths from a trace to 20 in and clamps beyond", () => {
  const { tierForDepth, depthForTier, MIN_DEPTH_IN, TOP_DEPTH_IN, TIER_MAX } = accumulation;
  assert.equal(tierForDepth(0), 0);
  assert.equal(tierForDepth(0.005), 0, "below the trace floor is nothing");
  assert.equal(tierForDepth(MIN_DEPTH_IN), 1);
  assert.equal(tierForDepth(TOP_DEPTH_IN), TIER_MAX);
  assert.equal(tierForDepth(99), TIER_MAX);
  for (const d of [0.02, 0.1, 0.25, 0.5, 1, 2.5, 6]) {
    const back = depthForTier(tierForDepth(d));
    assert.ok(Math.abs(back - d) / d < 0.02, `${d} in → tier → ${back}`);
  }
});

test("colour ramp: transparent below a trace, opaque and monotone through the stops, white at the top", () => {
  const { colorForDepthIn, ACCUM_STOPS } = accumulation;
  assert.deepEqual(colorForDepthIn(0.001), [0, 0, 0, 0]);
  assert.equal(colorForDepthIn(0.3)[3], 255);
  assert.deepEqual(colorForDepthIn(10), [255, 255, 255, 255]);
  for (const [d, r, g, b, a] of ACCUM_STOPS) {
    assert.deepEqual(colorForDepthIn(d), [r, g, b, a], `stop ${d} in reproduces exactly`);
  }
  const lut = accumulation.buildAccumLut();
  assert.equal(lut[3], 0);
  assert.equal(lut.length, 1024);
});

test("formatDepth follows the length unit", () => {
  assert.equal(accumulation.formatDepth(0.42, "in"), "0.42 in");
  assert.equal(accumulation.formatDepth(1.5, "in"), "1.5 in");
  assert.equal(accumulation.formatDepth(0.42, "mm"), "11 mm");
  assert.equal(accumulation.formatDepth(0.02, "mm"), "0.5 mm");
  assert.equal(accumulation.formatDepth(NaN, "in"), "—");
});

test("the three accumulation products are registered and decode inches from their headers", () => {
  assert.deepEqual(ACCUMULATION_PRODUCTS, ["DAA", "DU3", "DTA"]);
  for (const key of ACCUMULATION_PRODUCTS) {
    assert.equal(PRODUCTS[key].kind, "accumulation");
    assert.equal(PRODUCTS[key].units, "in");
    assert.equal(PRODUCTS[key].reservedLevels, 1);
  }
  // Committed live files, LWX 2026-09-27 21:06–21:10 Z.
  const cases = {
    DAA: {
      file: "LWX_DAA_2026_09_27_21_10_43.bin", maxLevelIn: 0.123, headerMaxIn: 0.1, periodMin: 60, start: "2026-09-27T20:14:00.000Z", end: "2026-09-27T21:14:00.000Z",
    },
    DTA: {
      file: "LWX_DTA_2026_09_27_21_10_43.bin", maxLevelIn: 2.55, headerMaxIn: 0.7, periodMin: 602, start: "2026-09-27T11:12:00.000Z", end: "2026-09-27T21:14:00.000Z",
    },
    DU3: {
      file: "LWX_DU3_2026_09_27_21_06_15.bin", maxLevelIn: 0.177, headerMaxIn: 0.2, periodMin: 180, start: "2026-09-27T18:00:00.000Z", end: "2026-09-27T21:00:00.000Z",
    },
  };
  for (const [key, c] of Object.entries(cases)) {
    const parsed = parseLevel3(fs.readFileSync(path.join(FIX, c.file)));
    assert.equal(parsed.messageHeader.code, PRODUCTS[key].code, `${key} product code`);
    const pd = parsed.productDescription;
    const sc = accumulationScaling(pd);
    assert.ok(Math.abs(sc.min + 255 * sc.increment - c.maxLevelIn) < 0.002, `${key}: level 255 = ${c.maxLevelIn} in`);
    const meta = accumulationMeta(PRODUCTS[key], pd);
    assert.equal(meta.periodMin, c.periodMin);
    assert.equal(meta.startTime, c.start);
    assert.equal(meta.endTime, c.end);
    assert.equal(meta.maxIn, c.headerMaxIn);
    assert.equal(meta.nullProduct, null);
    const pk = parsed.radialPackets[0];
    assert.equal(pk.radialsRaw.length, 360, `${key}: 1° radials`);
    assert.equal(pk.numberBins, 920, `${key}: 230 km of 0.25 km bins`);
  }
});

test("QPE mosaic cells: 2 km max-reduction, mm → inch tiers, missing values skipped", () => {
  // A 6 × 4 source grid at 0.01°: 16-bit PNG packing ref −30, dec 1 →
  // mm = (X − 30) / 10. One wet 2 × 2 block (2.54 mm = 0.1 in max), one
  // block with a missing sample (X = 0 → −3 mm) and a trace.
  const ni = 6;
  const nj = 4;
  const samples = new Uint16Array(ni * nj).fill(30); // 0 mm everywhere
  samples[0 * ni + 0] = 30 + 12; // 1.2 mm
  samples[1 * ni + 1] = 30 + 25; // 2.5 mm → the block max
  samples[2 * ni + 2] = 0; // missing
  samples[3 * ni + 3] = 30 + 1; // 0.1 mm = 0.004 in → below the trace floor
  samples[0 * ni + 4] = 30 + 254; // 25.4 mm = 1 in
  const g = {
    ni, nj, lat0: 40, lon0: 285, dLat: 0.01, dLon: 0.01, ref: -30, binScale: 0, decScale: 1,
  };
  const out = qpe.buildCells({ g, samples }, 2);
  assert.equal(out.grid.ni, 3);
  assert.equal(out.grid.nj, 2);
  assert.equal(out.grid.dLat, 0.02);
  assert.equal(out.grid.lon0, -74.995, "lon wraps to −180..180 and moves to the cell centre");
  assert.equal(out.drawn, 2);
  assert.equal(out.maxIn, 1);
  assert.equal(accumulation.depthForTier(out.cells[0]).toFixed(2), (2.5 / 25.4).toFixed(2));
  assert.equal(out.cells[1], 0, "missing + trace block is nothing");
  assert.equal(out.cells[2], accumulation.tierForDepth(1));
  const rt = rleDecode(rleEncode(out.cells), out.cells.length);
  assert.deepEqual([...rt], [...out.cells]);
});

test("QPE controller validates its query", async () => {
  const res = () => {
    const r = { code: null, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  };
  let r = res();
  await qpe.getQpeMosaic({ query: { period: "90" } }, r);
  assert.equal(r.code, 400);
  r = res();
  await qpe.getQpeMosaic({ query: { period: "60", stamp: "nope" } }, r);
  assert.equal(r.code, 400);
  assert.equal(qpe.PRODUCTS[60], "CONUS/RadarOnly_QPE_01H_00.00");
  assert.equal(qpe.PRODUCTS[180], "CONUS/RadarOnly_QPE_03H_00.00");
});
