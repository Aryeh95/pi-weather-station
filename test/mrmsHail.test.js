// Tests for the MRMS MESH hail decoder (server/mrmsHailCtrl.js).
//
// The committed fixture is a live CONUS MESH file (2026-09-03 13:36:41 Z,
// gzipped GRIB2, 54 KB). Every number asserted below was cross-checked the
// same day against ECMWF's eccodes tools on the identical file:
//
//   grib_ls: grid_png, 16 bits, ref −30, bin 0, dec 1, 7000 × 3500,
//            first point 54.995 / 230.005, increments 0.01, scan mode 0
//   grib_get: minimum −3, maximum 59.1, 24 500 000 values
//   grib_get_data | awk: 5 570 points > 0, max 59.1 at 40.595 / 269.245
//
// If the pure-JS decoder ever drifts from that, these fail loudly.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const {
  parseGrib2,
  decodePng16,
  hailPoints,
  maxWithin,
  keyValidTime,
  MIN_REPORT_MM,
} = require("../server/mrmsHailCtrl");

const FIXTURE = path.join(__dirname, "fixtures", "MRMS_MESH_00.50_20260903-133641.grib2.gz");

let grib;
let samples;
function load() {
  if (!grib) {
    grib = parseGrib2(zlib.gunzipSync(fs.readFileSync(FIXTURE)));
    samples = decodePng16(grib.png, grib.ni, grib.nj);
  }
  return { grib, samples };
}

test("GRIB2 header parses to the documented MRMS CONUS grid", () => {
  const { grib: g } = load();
  assert.equal(g.ni, 7000);
  assert.equal(g.nj, 3500);
  assert.equal(g.lat0, 54.995);
  assert.equal(g.lon0, 230.005);
  assert.equal(g.dLat, 0.01);
  assert.equal(g.dLon, 0.01);
  assert.equal(g.scanMode, 0);
  // Packing: value_mm = (−30 + X) / 10.
  assert.equal(g.ref, -30);
  assert.equal(g.binScale, 0);
  assert.equal(g.decScale, 1);
  assert.equal(g.bits, 16);
});

test("PNG payload decodes to one 16-bit sample per grid point", () => {
  const { grib: g, samples: s } = load();
  assert.equal(s.length, g.ni * g.nj);
  let max = 0;
  let min = 65535;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] > max) max = s[i];
    if (s[i] < min) min = s[i];
  }
  // eccodes: minimum −3 mm, maximum 59.1 mm.
  assert.equal((g.ref + min) / 10, -3);
  assert.equal(Math.round(((g.ref + max) / 10) * 10) / 10, 59.1);
});

test("hail points match eccodes: 5570 above zero, maximum 59.1 mm at 40.595 N 90.755 W", () => {
  const { grib: g, samples: s } = load();
  const pts = hailPoints(g, s, 0.05);
  assert.equal(pts.length, 5570);
  const best = pts.reduce((a, b) => (b[2] > a[2] ? b : a));
  assert.deepEqual(best, [40.595, -90.755, 59.1]);
  // Longitudes are normalised to −180..180 for the client.
  assert.ok(pts.every(([, lon]) => lon >= -180 && lon <= 180));
});

test("default threshold drops graupel-sized noise", () => {
  const { grib: g, samples: s } = load();
  const pts = hailPoints(g, s);
  assert.ok(pts.every(([, , mm]) => mm >= MIN_REPORT_MM));
  assert.ok(pts.length > 0 && pts.length < 5570);
});

test("maxWithin samples the largest MESH inside the radius and null outside it", () => {
  const { grib: g, samples: s } = load();
  const pts = hailPoints(g, s);
  assert.equal(maxWithin(pts, 40.595, -90.755), 59.1);
  // ~9 km east of the maximum still sees it at the default 10 km radius…
  assert.equal(maxWithin(pts, 40.595, -90.755 + 9 / (111.32 * Math.cos((40.595 * Math.PI) / 180))), 59.1);
  // …a point in the hail-free Atlantic does not.
  assert.equal(maxWithin(pts, 30.0, -70.0), null);
  // A tight radius excludes it.
  assert.ok((maxWithin(pts, 40.595, -90.755 + 0.2, 5) || 0) < 59.1);
});

test("keyValidTime reads the UTC stamp out of a bucket key", () => {
  assert.equal(
    keyValidTime("CONUS/MESH_00.50/20260903/MRMS_MESH_00.50_20260903-132641.grib2.gz"),
    "2026-09-03T13:26:41.000Z",
  );
  assert.equal(keyValidTime("garbage"), null);
});

test("non-MRMS layouts are refused rather than misread", () => {
  assert.throws(() => parseGrib2(Buffer.from("not a grib file at all, really")), /not GRIB/);
  assert.throws(() => decodePng16(Buffer.alloc(16), 1, 1), /not PNG/);
});
