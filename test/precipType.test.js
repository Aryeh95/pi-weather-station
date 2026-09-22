// Tests for precipitation-type mode: the shared class/tier encoding
// (server/precipType.js), the single-site merge of N0H + N0B
// (radarRadialCtrl.mergePrecipType) and the MRMS surface-type mosaic
// (mrmsPrecipTypeCtrl.buildCells).
//
// Fixtures:
//   LWX_N0H_2026_09_06_01_29_38.bin — the live classification the dual-pol
//     clean mode was built from (a nocturnal biological bloom);
//   MRMS_PrecipFlag_00.00_20260916-012600.grib2.gz — a live CONUS surface
//     type frame (180 KB). Its histogram matched the documented flag table
//     exactly and its only snow was in the high Canadian Rockies near
//     Banff, which is where September snow belongs — so it doubles as a
//     regression check on the grid geometry: if the snow ever lands
//     somewhere else, the lat/lon mapping broke.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const P = require("../server/precipType");
const {
  mergePrecipType, precipPayload, packRadials, PRODUCTS, PRECIP_PRODUCT, NUM_BUCKETS,
} = require("../server/radarRadialCtrl");
const { parseGrib2, decodePng16 } = require("../server/mrmsHailCtrl");
const { buildCells, GRID_STEP, RATE_UNKNOWN_TIER } = require("../server/mrmsPrecipTypeCtrl");
const parseLevel3 = require("nexrad-level-3-data");

const N0H_FIXTURE = path.join(__dirname, "fixtures", "LWX_N0H_2026_09_06_01_29_38.bin");
const FLAG_FIXTURE = path.join(__dirname, "fixtures", "MRMS_PrecipFlag_00.00_20260916-012600.grib2.gz");

// ── encoding ──────────────────────────────────────────────────────────

test("gate byte packs class in the high nibble and tier in the low", () => {
  const level = P.encodeGate(P.CLASS_DS, 7);
  assert.equal(P.gateClass(level), P.CLASS_DS);
  assert.equal(P.gateTier(level), 7);
  assert.equal(P.encodeGate(15, 15), 255);
  assert.equal(P.encodeGate(0, 0), 0);
});

test("N0H class codes map to code / 10; anything else is unknown", () => {
  assert.equal(P.hcaClassIndex(0), P.CLASS_ND);
  assert.equal(P.hcaClassIndex(10), P.CLASS_BI);
  assert.equal(P.hcaClassIndex(40), P.CLASS_DS);
  assert.equal(P.hcaClassIndex(60), P.CLASS_RA);
  assert.equal(P.hcaClassIndex(150), P.CLASS_RF);
  assert.equal(P.hcaClassIndex(7), P.CLASS_UK);
  assert.equal(P.hcaClassIndex(160), P.CLASS_UK);
});

test("only precipitation classes are drawn — the non-weather verdicts never are", () => {
  for (const c of [P.CLASS_ND, P.CLASS_BI, P.CLASS_GC, P.CLASS_UK, P.CLASS_RF, 13]) {
    assert.equal(P.isDrawnClass(c), false, `class ${c}`);
  }
  for (const c of [P.CLASS_IC, P.CLASS_DS, P.CLASS_WS, P.CLASS_RA, P.CLASS_HR, P.CLASS_BD, P.CLASS_GR, P.CLASS_HA, P.CLASS_LH, P.CLASS_GH]) {
    assert.equal(P.isDrawnClass(c), true, `class ${c}`);
  }
});

test("MRMS PrecipFlag values map onto the same class vocabulary", () => {
  assert.equal(P.mrmsFlagClassIndex(1), P.CLASS_RA);   // warm stratiform
  assert.equal(P.mrmsFlagClassIndex(10), P.CLASS_RA);  // cool stratiform
  assert.equal(P.mrmsFlagClassIndex(91), P.CLASS_RA);  // tropical stratiform
  assert.equal(P.mrmsFlagClassIndex(6), P.CLASS_HR);   // convective
  assert.equal(P.mrmsFlagClassIndex(96), P.CLASS_HR);  // tropical convective
  assert.equal(P.mrmsFlagClassIndex(3), P.CLASS_DS);   // snow
  assert.equal(P.mrmsFlagClassIndex(7), P.CLASS_HA);   // hail
  assert.equal(P.mrmsFlagClassIndex(0), P.CLASS_ND);
  assert.equal(P.mrmsFlagClassIndex(-3), P.CLASS_ND);  // no coverage
  assert.equal(P.mrmsFlagClassIndex(42), P.CLASS_ND);  // undocumented → nothing
});

test("tiers are 5 dBZ wide, clamped to 1..15, and the noise floor lands on a tier edge", () => {
  assert.equal(P.tierForDbz(-20), 1);
  assert.equal(P.tierForDbz(0), 1);
  assert.equal(P.tierForDbz(4.9), 1);
  assert.equal(P.tierForDbz(5), 2);
  assert.equal(P.tierForDbz(15), 4);
  assert.equal(P.tierForDbz(69.9), 14);
  assert.equal(P.tierForDbz(70), 15);
  assert.equal(P.tierForDbz(200), 15);
  // The 15 dBZ clear-air floor hides tiers 1-3 and keeps tier 4 exactly.
  assert.equal(P.minTierForDbz(15), 4);
  assert.equal(P.minTierForDbz(undefined), 1);
  assert.equal(P.minTierForDbz(-Infinity), 1);
});

test("rain rate tiers follow Marshall–Palmer: 1 mm/h ≈ 23 dBZ, 10 mm/h ≈ 39 dBZ", () => {
  assert.equal(Math.round(P.dbzForRate(1)), 23);
  assert.equal(Math.round(P.dbzForRate(10)), 39);
  assert.equal(Math.round(P.dbzForRate(50)), 50);
  assert.equal(P.tierForRate(1), 5);
  assert.equal(P.tierForRate(10), 8);
  // A non-positive rate is the faintest tier, never a crash.
  assert.equal(P.tierForRate(0), 1);
  assert.equal(P.tierForRate(-3), 1);
});

test("LUT: nothing drawn for level 0, non-weather classes or tiers under the floor", () => {
  const lut = P.buildPrecipLut(15);
  const alpha = (level) => lut[level * 4 + 3];
  assert.equal(alpha(0), 0);
  assert.equal(alpha(P.encodeGate(P.CLASS_BI, 8)), 0);
  assert.equal(alpha(P.encodeGate(P.CLASS_GC, 8)), 0);
  assert.equal(alpha(P.encodeGate(P.CLASS_RA, 3)), 0, "tier 3 (10-15 dBZ) is under a 15 dBZ floor");
  assert.notEqual(alpha(P.encodeGate(P.CLASS_RA, 4)), 0, "tier 4 (15-20 dBZ) survives it");
  // Without a floor, tier 1 rain draws.
  assert.notEqual(P.buildPrecipLut()[P.encodeGate(P.CLASS_RA, 1) * 4 + 3], 0);
});

test("LUT: rain is green-dominant and snow blue-dominant at every drawn tier", () => {
  const lut = P.buildPrecipLut();
  for (let tier = 1; tier <= 8; tier += 1) {
    const r = P.encodeGate(P.CLASS_RA, tier) * 4;
    assert.ok(lut[r + 1] > lut[r + 2], `rain tier ${tier} greener than blue`);
    const s = P.encodeGate(P.CLASS_DS, tier) * 4;
    assert.ok(lut[s + 2] > lut[s + 1] && lut[s + 2] > lut[s], `snow tier ${tier} blue-dominant`);
  }
  // Heavy rain warms to red — the intensity axis is visible within a class.
  const heavy = P.encodeGate(P.CLASS_RA, 12) * 4;
  assert.ok(lut[heavy] > lut[heavy + 1]);
  // Heavy rain and big drops share the rain ramp.
  const hr = P.encodeGate(P.CLASS_HR, 6) * 4;
  const ra = P.encodeGate(P.CLASS_RA, 6) * 4;
  assert.deepEqual([...lut.slice(hr, hr + 4)], [...lut.slice(ra, ra + 4)]);
});

test("run-length coding round-trips and caps runs at 255", () => {
  const field = new Uint8Array(1000);
  field.fill(0x64, 300, 320);
  field[999] = 7;
  const enc = P.rleEncode(field);
  // 300 zeros → 255 + 45, 20 of 0x64, 679 zeros → 255 + 255 + 169, one 7.
  assert.equal(enc.length, 2 * 7);
  assert.deepEqual([...P.rleDecode(enc, field.length)], [...field]);
  // A short encoding never over-runs the declared length.
  assert.equal(P.rleDecode(Uint8Array.from([5, 255]), 10).every((v) => v === 5), true);
});

// ── single-site merge ─────────────────────────────────────────────────

const SCALING = { min: -32, increment: 0.5 };
const levelFor = (dbz) => Math.round((dbz - SCALING.min) / SCALING.increment);

/**
 * One-radial synthetic pair on the same grid.
 *
 * @param {Array<[Number, Number]>} gates [dBZ, class code] per bin
 * @returns {{refl: Object, cls: Object}} payload-shaped inputs
 */
function pair(gates) {
  const common = { numBuckets: 1, bucketDeg: 0.5, binKm: 0.25, firstBinKm: 0 };
  return {
    refl: {
      ...common, numBins: gates.length, reservedLevels: 2, scaling: SCALING,
      bins: Buffer.from(gates.map(([dbz]) => (dbz === null ? 0 : levelFor(dbz)))).toString("base64"),
    },
    cls: {
      ...common, numBins: gates.length, reservedLevels: 1, scaling: { min: 0, increment: 1, levels: 16 },
      bins: Buffer.from(gates.map(([, code]) => code)).toString("base64"),
    },
  };
}

test("merge: class from N0H, tier from N0B; non-weather and echo-less gates stay empty", () => {
  const { refl, cls } = pair([
    [22, 60],    // rain at 22 dBZ → RA tier 5
    [22, 10],    // biological at the same dBZ → nothing
    [22, 20],    // clutter → nothing
    [45, 80],    // big drops in a core → BD tier 10
    [12, 40],    // dry snow, light → DS tier 3
    [null, 60],  // classified but no reflectivity → nothing
    [30, 0],     // echo with no verdict → nothing
    [50, 100],   // hail → HA tier 11
  ]);
  const { bins, drawn } = mergePrecipType(refl, cls);
  assert.deepEqual([...bins], [
    P.encodeGate(P.CLASS_RA, 5), 0, 0,
    P.encodeGate(P.CLASS_BD, 10),
    P.encodeGate(P.CLASS_DS, 3),
    0, 0,
    P.encodeGate(P.CLASS_HA, 11),
  ]);
  assert.equal(drawn, 4);
});

test("merge: the output is on the classification's (shorter) grid", () => {
  const { refl, cls } = pair([[30, 60], [30, 60], [30, 60]]);
  // Reflectivity reaches further than the classification (460 vs 300 km).
  refl.numBins = 5;
  refl.bins = Buffer.from([levelFor(30), levelFor(30), levelFor(30), levelFor(30), levelFor(30)]).toString("base64");
  const { bins } = mergePrecipType(refl, cls);
  assert.equal(bins.length, 3);
  assert.ok(bins.every((b) => b !== 0));
});

test("merge against the live LWX classification: the bloom is gone, the rain survives", () => {
  // Decode the real N0H exactly as the controller does, then pair it with
  // a synthetic reflectivity of uniform 20 dBZ — the bloom's own level.
  require("../server/radarRadialCtrl"); // registers the shims
  const parsed = parseLevel3(fs.readFileSync(N0H_FIXTURE));
  const packet = parsed.radialPackets[0];
  const numBins = packet.numberBins;
  const cbins = packRadials(packet.radialsRaw, numBins);
  const cls = {
    numBuckets: NUM_BUCKETS, bucketDeg: 0.5, binKm: 0.25, firstBinKm: 0, numBins,
    reservedLevels: 1, scaling: PRODUCTS.N0H.scaling, bins: cbins.toString("base64"),
  };
  const refl = {
    numBuckets: NUM_BUCKETS, bucketDeg: 0.5, binKm: 0.25, firstBinKm: 0, numBins,
    reservedLevels: 2, scaling: SCALING,
    bins: Buffer.alloc(NUM_BUCKETS * numBins, levelFor(20)).toString("base64"),
  };
  const { bins, drawn } = mergePrecipType(refl, cls);
  let classified = 0;
  let bio = 0;
  let rain = 0;
  for (const code of cbins) {
    if (code !== 0) classified += 1;
    if (code === 10) bio += 1;
    if (code === 60) rain += 1;
  }
  assert.ok(bio > classified * 0.5, "the fixture is a biological bloom");
  // Every drawn gate is a precipitation class; every RA gate is drawn as rain.
  let drawnRain = 0;
  for (let i = 0; i < bins.length; i += 1) {
    if (bins[i] === 0) continue;
    assert.ok(P.isDrawnClass(P.gateClass(bins[i])));
    assert.equal(P.gateTier(bins[i]), P.tierForDbz(20));
    if (P.gateClass(bins[i]) === P.CLASS_RA) drawnRain += 1;
  }
  assert.equal(drawnRain, rain);
  assert.ok(drawn < classified * 0.5, `drawn ${drawn} of ${classified} classified gates — most of the bloom removed`);
});

test("precipPayload keeps the radial payload contract with kind 'precip'", () => {
  const { refl, cls } = pair([[30, 60]]);
  Object.assign(cls, { key: "LWX_N0H_x", scanTime: "2026-09-16T01:15:38.000Z", radar: { lat: 39, lon: -77 }, elevationAngle: 0.5 });
  Object.assign(refl, { key: "LWX_N0B_x", scanTime: "2026-09-16T01:15:38.000Z" });
  const p = precipPayload("LWX", refl, cls);
  assert.equal(p.available, true);
  assert.equal(p.product, PRECIP_PRODUCT);
  assert.equal(p.kind, "precip");
  assert.equal(p.key, "LWX_N0H_x");
  assert.equal(p.scanTime, cls.scanTime);
  assert.equal(p.reservedLevels, 1);
  assert.equal(p.numBins, 1);
  assert.equal(p.precip.tierDbz, P.TIER_DBZ);
  assert.equal(p.precip.reflectivity.key, "LWX_N0B_x");
  assert.deepEqual([...Buffer.from(p.bins, "base64")], [P.encodeGate(P.CLASS_RA, 7)]);
});

// ── MRMS mosaic ───────────────────────────────────────────────────────

let flagGrid;
function loadFlag() {
  if (!flagGrid) {
    const g = parseGrib2(zlib.gunzipSync(fs.readFileSync(FLAG_FIXTURE)));
    flagGrid = { g, samples: decodePng16(g.png, g.ni, g.nj), validTime: "2026-09-16T01:26:00.000Z" };
  }
  return flagGrid;
}

test("PrecipFlag decodes through the hail GRIB2 path: 8-bit, ref −3, only documented flag values", () => {
  const { g, samples } = loadFlag();
  assert.equal(g.ni, 7000);
  assert.equal(g.nj, 3500);
  assert.equal(g.bits, 8);
  assert.equal(g.ref, -3);
  assert.equal(g.decScale, 0);
  const seen = new Set();
  for (let i = 0; i < samples.length; i += 1) seen.add(g.ref + samples[i]);
  const documented = new Set([-3, 0, 1, 3, 6, 7, 10, 91, 96]);
  for (const v of seen) assert.ok(documented.has(v), `undocumented PrecipFlag value ${v}`);
  assert.ok(seen.has(3), "the fixture carries snow");
});

test("buildCells: 2 km grid, most-intense-cell-wins, snow exactly where it fell (Canadian Rockies)", () => {
  const flag = loadFlag();
  const { grid, cells, drawn } = buildCells(flag, null);
  assert.equal(GRID_STEP, 2);
  assert.equal(grid.ni, 3500);
  assert.equal(grid.nj, 1750);
  assert.equal(grid.dLat, 0.02);
  assert.equal(grid.dLon, 0.02);
  // Output cell centres sit half a source cell inside the source corner.
  assert.equal(grid.lat0, 54.99);
  assert.equal(grid.lon0, -129.99);
  assert.ok(drawn > 0);
  let typed = 0;
  const snow = [];
  for (let k = 0; k < cells.length; k += 1) {
    const level = cells[k];
    if (!level) continue;
    typed += 1;
    // No rate grid → every drawn cell at the "unknown intensity" tier.
    assert.equal(P.gateTier(level), RATE_UNKNOWN_TIER);
    if (P.GROUP_OF_CLASS[P.gateClass(level)] === P.GROUP_SNOW) {
      snow.push([grid.lat0 - Math.floor(k / grid.ni) * grid.dLat, grid.lon0 + (k % grid.ni) * grid.dLon]);
    }
  }
  assert.equal(typed, drawn);
  assert.ok(snow.length > 0 && snow.length < 20, `a handful of snow cells, got ${snow.length}`);
  for (const [lat, lon] of snow) {
    assert.ok(lat > 50 && lat < 52 && lon > -116.5 && lon < -114.5, `snow at ${lat}, ${lon} is not in the Rockies near Banff`);
  }
});

test("buildCells: with a rate grid the tier follows the rate, and the strongest sub-cell wins", () => {
  // 4 × 4 source grid, step 2 → 2 × 2 output. Top-left block: rain at
  // 1 mm/h and 10 mm/h → tier 8 wins. Top-right: snow, rate 0 → tier 1.
  // Bottom-left: hail with no rate sample → tier 1 (rate present, ≤ 0).
  // Bottom-right: nothing.
  const g = { ni: 4, nj: 4, lat0: 40, lon0: -100, dLat: 0.01, dLon: 0.01, ref: -3, binScale: 0, decScale: 0 };
  const rg = { ...g, ref: -30, decScale: 1 };
  const flagVals = [
    1, 1, 3, 3,
    1, 1, 3, 3,
    7, 7, 0, 0,
    7, 7, 0, 0,
  ];
  const rateMmh = [
    1, 1, 0, 0,
    1, 10, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ];
  const flag = { g, samples: Uint16Array.from(flagVals.map((v) => v - g.ref)) };
  const rate = { g: rg, samples: Uint16Array.from(rateMmh.map((v) => v * 10 - rg.ref)) };
  const { grid, cells, drawn } = buildCells(flag, rate);
  assert.equal(grid.ni, 2);
  assert.equal(grid.nj, 2);
  assert.equal(grid.lat0, 39.995);
  assert.equal(grid.lon0, -99.995);
  assert.equal(drawn, 3);
  assert.equal(cells[0], P.encodeGate(P.CLASS_RA, P.tierForRate(10)));
  assert.equal(cells[1], P.encodeGate(P.CLASS_DS, 1));
  assert.equal(cells[2], P.encodeGate(P.CLASS_HA, 1));
  assert.equal(cells[3], 0);
});

test("buildCells refuses a rate grid on a different geometry", () => {
  const g = { ni: 2, nj: 2, lat0: 40, lon0: -100, dLat: 0.01, dLon: 0.01, ref: -3, binScale: 0, decScale: 0 };
  const flag = { g, samples: new Uint16Array(4) };
  const rate = { g: { ...g, ni: 3 }, samples: new Uint16Array(6) };
  assert.throws(() => buildCells(flag, rate), /does not match/);
});


// ── History (stamp lookup), 2026-09-22 ─────────────────────────────────

test("precip-mosaic stamp parsing: 12 UTC digits or nothing", () => {
  const { stampEpoch, STAMP_WINDOW_MS } = require("../server/mrmsPrecipTypeCtrl");
  assert.equal(stampEpoch("202609220614"), Date.UTC(2026, 8, 22, 6, 14));
  assert.ok(Number.isNaN(stampEpoch("2026092206")));
  assert.ok(Number.isNaN(stampEpoch("abc")));
  assert.ok(Number.isNaN(stampEpoch(undefined)));
  // MRMS writes every 2 min; the window must always reach the neighbour of
  // an on-time stamp and must not reach across an outage.
  assert.ok(STAMP_WINDOW_MS >= 2 * 60 * 1000 && STAMP_WINDOW_MS <= 5 * 60 * 1000);
});

test("precip-mosaic route rejects a malformed stamp before touching the bucket", async () => {
  const { getPrecipMosaic } = require("../server/mrmsPrecipTypeCtrl");
  const res = { status(s) { this.s = s; return this; }, json(b) { this.b = b; return this; }, end() { return this; } };
  await getPrecipMosaic({ query: { stamp: "2026-09-22" } }, res);
  assert.equal(res.s, 400);
});

test("MRMS key validity time parses for every product name shape", () => {
  const { keyValidTime } = require("../server/mrmsHailCtrl");
  assert.equal(keyValidTime("CONUS/PrecipFlag_00.00/20260922/MRMS_PrecipFlag_00.00_20260922-061400.grib2.gz"), "2026-09-22T06:14:00.000Z");
  assert.equal(keyValidTime("CONUS/MESH_00.50/20260903/MRMS_MESH_00.50_20260903-133641.grib2.gz"), "2026-09-03T13:36:41.000Z");
  assert.equal(keyValidTime("nonsense"), null);
});
