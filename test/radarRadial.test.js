// Tests for the raw-radial renderer's pure pieces.
//
// Two halves:
//
//   1. SERVER (real module, no copy): the product-153 shim + packRadials
//      against a COMMITTED FIXTURE — the actual DIX_N0B file the feature
//      was verified against on 2026-08-12 (160 KB, one volume scan).
//      Committing the binary keeps the whole decode path testable
//      offline; without it, the first regression in the shim would only
//      surface on a live kiosk during a storm.
//
//   2. CLIENT (verbatim copy): the colour ramp, level LUT and bounds
//      math from radialRender.js. `renderRadialImage` itself needs a DOM
//      canvas and is exercised in the browser, not here; the copied
//      helpers are the parts whose silent drift would mis-colour or
//      mis-place the whole image. Registered with verbatimSync.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { packRadials, NUM_BUCKETS, BIN_KM } = require("../server/radarRadialCtrl");
const parseLevel3 = require("nexrad-level-3-data");

const FIXTURE = path.join(__dirname, "fixtures", "DIX_N0B_2026_08_12_00_37_12.bin");

// ---------- start of verbatim copy from client/src/components/WeatherMap/radialRender.js ----------

const RADIAL_RADIUS_KM = 300;

const EARTH_R_KM = 6371;

const DBZ_STOPS = [
  [0, 90, 95, 115, 70],
  [5, 4, 233, 231, 190],
  [10, 1, 159, 244, 215],
  [15, 3, 0, 244, 230],
  [20, 2, 253, 2, 255],
  [25, 1, 197, 1, 255],
  [30, 0, 142, 0, 255],
  [35, 253, 248, 2, 255],
  [40, 229, 188, 0, 255],
  [45, 253, 149, 0, 255],
  [50, 253, 0, 0, 255],
  [55, 212, 0, 0, 255],
  [60, 188, 0, 0, 255],
  [65, 248, 0, 253, 255],
  [70, 152, 84, 198, 255],
  [75, 253, 253, 253, 255],
];

function colorForDbz(dbz) {
  if (dbz < DBZ_STOPS[0][0]) return [0, 0, 0, 0];
  const last = DBZ_STOPS[DBZ_STOPS.length - 1];
  if (dbz >= last[0]) return [last[1], last[2], last[3], last[4]];
  for (let i = 1; i < DBZ_STOPS.length; i += 1) {
    if (dbz < DBZ_STOPS[i][0]) {
      const lo = DBZ_STOPS[i - 1];
      const hi = DBZ_STOPS[i];
      const t = (dbz - lo[0]) / (hi[0] - lo[0]);
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

const NOISE_FILTER_MIN_DBZ = 15;

function buildLevelLut(scaling, minDbz = -Infinity) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let level = 2; level < 256; level += 1) {
    const dbz = scaling.min + level * scaling.increment;
    if (dbz < minDbz) continue;
    const [r, g, b, a] = colorForDbz(dbz);
    lut[level * 4] = r;
    lut[level * 4 + 1] = g;
    lut[level * 4 + 2] = b;
    lut[level * 4 + 3] = a;
  }
  return lut;
}

function radialBounds(lat, lon) {
  const lat0 = (lat * Math.PI) / 180;
  const xm0 = (lon * Math.PI) / 180;
  const ym0 = Math.asinh(Math.tan(lat0));
  // Mercator stretches ground distance by 1/cos(lat); a small margin
  // keeps the disc fully inside the square at the poleward edge.
  const halfMerc = ((RADIAL_RADIUS_KM / EARTH_R_KM) / Math.cos(lat0)) * 1.02;
  const north = (Math.atan(Math.sinh(ym0 + halfMerc)) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(ym0 - halfMerc)) * 180) / Math.PI;
  const east = ((xm0 + halfMerc) * 180) / Math.PI;
  const west = ((xm0 - halfMerc) * 180) / Math.PI;
  return { bounds: [[south, west], [north, east]], halfMerc, ym0, xm0 };
}

// ---------- end of verbatim copy ----------

test("shim: requiring radarRadialCtrl makes product 153 parseable", () => {
  // Without the shim the library throws "Unsupported product type: N0B".
  const parsed = parseLevel3(fs.readFileSync(FIXTURE));
  assert.equal(parsed.messageHeader.code, 153);
  assert.equal(parsed.textHeader.type, "N0B");
});

test("fixture decodes to the documented super-res geometry", () => {
  const parsed = parseLevel3(fs.readFileSync(FIXTURE));
  const pd = parsed.productDescription;
  assert.equal(pd.elevationAngle, 0.5);
  assert.equal(pd.plot.minimumDataValue, -32);
  assert.equal(pd.plot.dataIncrement, 0.5);
  const packet = parsed.radialPackets[0];
  assert.equal(packet.radialsRaw.length, 720);
  assert.equal(packet.numberBins, 1840);
  // 1840 bins x 0.25 km = 460 km — the documented super-res range.
  assert.equal(packet.numberBins * BIN_KM, 460);
});

test("scaling contract: raw level decodes to the parser's own scaled value", () => {
  // The client renders from RAW levels using dBZ = min + level x inc.
  // That must be the same table the parser builds internally — if the
  // library ever changes its mapping, the client would mis-colour
  // every gate, and this is the test that catches it.
  const parsed = parseLevel3(fs.readFileSync(FIXTURE));
  const pd = parsed.productDescription.plot;
  const packet = parsed.radialPackets[0];
  let checked = 0;
  for (let r = 0; r < packet.radialsRaw.length && checked < 500; r += 1) {
    const raw = packet.radialsRaw[r].bins;
    const scaled = packet.radials[r].bins;
    for (let i = 0; i < raw.length && checked < 500; i += 1) {
      if (raw[i] < 2) continue;
      assert.equal(scaled[i], pd.minimumDataValue + raw[i] * pd.dataIncrement);
      checked += 1;
    }
  }
  assert.ok(checked >= 100, `only ${checked} data bins checked — fixture too empty?`);
});

test("packRadials: coverage-based bucketing, off-boundary angles collide nowhere", () => {
  // Radials starting OFF the 0.5-degree boundaries — the real-sweep case
  // that broke the old floor() packing. Each bucket's centre must be
  // claimed by the radial whose sweep covers it.
  const radials = [
    { startAngle: 0.3, angleDelta: 0.5, bins: [10, 11] },   // covers centre 0.75 -> bucket 1
    { startAngle: 0.8, angleDelta: 0.5, bins: [20, 21] },   // covers centre 1.25 -> bucket 2
    { startAngle: 359.8, angleDelta: 0.5, bins: [30, 31] }, // wraps: covers centre 0.25 -> bucket 0
  ];
  const out = packRadials(radials, 2);
  assert.equal(out.length, NUM_BUCKETS * 2);
  assert.deepEqual([out[0], out[1]], [30, 31]);   // wraparound radial owns bucket 0
  assert.deepEqual([out[2], out[3]], [10, 11]);   // bucket 1
  assert.deepEqual([out[4], out[5]], [20, 21]);   // bucket 2
});

test("packRadials: short radials zero-pad, uncovered buckets fill from neighbours", () => {
  const radials = [
    { startAngle: 90.0, angleDelta: 0.5, bins: [20] },      // covers bucket 180, 1 bin short of 2
  ];
  const out = packRadials(radials, 2);
  const b = 180 * 2;
  // Short radial: the reported bucket zero-pads (radar said nothing there).
  assert.deepEqual([out[b], out[b + 1]], [20, 0]);
  // Adjacent uncovered buckets are filled from it — the anti-spoke rule —
  // out to the +/-4 search limit, and stay empty beyond it.
  assert.deepEqual([out[b + 2], out[b + 3]], [20, 0]);       // 1 bucket away: filled
  assert.deepEqual([out[b + 8], out[b + 9]], [20, 0]);       // 4 away: filled
  assert.deepEqual([out[b + 10], out[b + 11]], [0, 0]);      // 5 away: beyond the limit
});

test("packRadials: fixture has no spokes and loses nothing", () => {
  // The user-visible regression (kiosk report, 2026-08-11): the old
  // floor() packing left ~0.27% of buckets empty between two data-bearing
  // neighbours, each rendering as a dark ray across the storm. Coverage
  // packing must leave ZERO such buckets, and — because nothing collides
  // any more — must also carry every data bin through.
  const parsed = parseLevel3(fs.readFileSync(FIXTURE));
  const packet = parsed.radialPackets[0];
  const out = packRadials(packet.radialsRaw, packet.numberBins);
  const nb = packet.numberBins;
  const hasData = (b) => {
    const base = b * nb;
    for (let i = 0; i < nb; i += 1) if (out[base + i] > 1) return true;
    return false;
  };
  const flags = Array.from({ length: NUM_BUCKETS }, (_, b) => hasData(b));
  let spokes = 0;
  for (let b = 0; b < NUM_BUCKETS; b += 1) {
    const prev = flags[(b - 1 + NUM_BUCKETS) % NUM_BUCKETS];
    const next = flags[(b + 1) % NUM_BUCKETS];
    if (!flags[b] && prev && next) spokes += 1;
  }
  assert.equal(spokes, 0, `${spokes} empty bucket(s) between data — spokes on screen`);

  let inCount = 0;
  for (const r of packet.radialsRaw) {
    for (const v of r.bins) if (v > 1) inCount += 1;
  }
  let outCount = 0;
  for (const v of out) if (v > 1) outCount += 1;
  assert.equal(outCount, inCount, "coverage packing must not lose or invent data bins");
});

test("colorForDbz: transparent below the ramp, capped above it", () => {
  assert.deepEqual(colorForDbz(-10), [0, 0, 0, 0]);
  assert.deepEqual(colorForDbz(-0.01), [0, 0, 0, 0]);
  assert.deepEqual(colorForDbz(80), [253, 253, 253, 255]);
});

test("colorForDbz: hits the stops exactly and interpolates between", () => {
  assert.deepEqual(colorForDbz(50), [253, 0, 0, 255]);
  // Halfway 5 -> 10: each channel is the midpoint (rounded).
  assert.deepEqual(colorForDbz(7.5), [3, 196, 238, 203]);
});

test("buildLevelLut: reserved levels stay transparent, data levels match the ramp", () => {
  const lut = buildLevelLut({ min: -32, increment: 0.5 });
  assert.equal(lut[0 * 4 + 3], 0);
  assert.equal(lut[1 * 4 + 3], 0);
  // Level 175 = -32 + 175 x 0.5 = 55.5 dBZ — the max seen in the live file.
  const expect = colorForDbz(55.5);
  assert.deepEqual([lut[175 * 4], lut[175 * 4 + 1], lut[175 * 4 + 2], lut[175 * 4 + 3]], expect);
});

test("buildLevelLut: noise filter blanks sub-threshold levels, keeps the rest", () => {
  const scaling = { min: -32, increment: 0.5 };
  const lut = buildLevelLut(scaling, NOISE_FILTER_MIN_DBZ);
  // Level 93 = -32 + 93 x 0.5 = 14.5 dBZ — just under the floor: hidden.
  assert.equal(lut[93 * 4 + 3], 0);
  // Level 94 = 15 dBZ exactly — at the floor: shown, identical to unfiltered.
  assert.deepEqual(
    [lut[94 * 4], lut[94 * 4 + 1], lut[94 * 4 + 2], lut[94 * 4 + 3]],
    colorForDbz(15),
  );
  // A filtered LUT never differs from the unfiltered one above the floor.
  const plain = buildLevelLut(scaling);
  for (let level = 94; level < 256; level += 1) {
    for (let c = 0; c < 4; c += 1) {
      assert.equal(lut[level * 4 + c], plain[level * 4 + c]);
    }
  }
});

test("radialBounds: square contains the display disc, centred on the site", () => {
  const { bounds } = radialBounds(39.947, -74.411);
  const [[south, west], [north, east]] = bounds;
  assert.ok(south < 39.947 && north > 39.947);
  assert.ok(west < -74.411 && east > -74.411);
  // Width on the ground ≈ 2 x 300 km x 1.02 margin.
  const widthKm = (east - west) * 111.32 * Math.cos((39.947 * Math.PI) / 180);
  assert.ok(Math.abs(widthKm - 612) < 5, `width ${widthKm.toFixed(1)} km`);
  // The pixel loop and the corners must agree: equal mercator gaps
  // above and below the site, by construction.
  const ym0 = Math.asinh(Math.tan((39.947 * Math.PI) / 180));
  const ymN = Math.asinh(Math.tan((north * Math.PI) / 180));
  const ymS = Math.asinh(Math.tan((south * Math.PI) / 180));
  assert.ok(Math.abs((ymN - ym0) - (ym0 - ymS)) < 1e-9);
});
