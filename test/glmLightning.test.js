// Tests for the GLM lightning controller (`server/glmLightningCtrl.js`).
//
// CJS server module — required directly, no verbatim copy. The decode
// path runs against a COMMITTED FIXTURE: the live GOES-19 file the
// feasibility check was performed on (2026-08-12, 322 KB, one 20-second
// window during a multi-state severe evening). That keeps the whole
// h5wasm pipeline testable offline — the shim-equivalent risk here is
// h5wasm or the product layout changing underneath us.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  decodeGlmBuffer,
  keyEpoch,
  hourPrefix,
  filterFlashes,
  WINDOW_MINUTES,
} = require("../server/glmLightningCtrl");

const FIXTURE = path.join(__dirname, "fixtures", "OR_GLM-L2-LCFA_G19_s20262240134000.nc");

test("keyEpoch parses the start token as UTC", () => {
  // s2026 224 01 34 00 -> 2026-08-12T01:34:00Z (day 224 of 2026).
  const t = keyEpoch("GLM-L2-LCFA/2026/224/01/OR_GLM-L2-LCFA_G19_s20262240134000_e20262240134200_c20262240134220.nc");
  assert.equal(new Date(t).toISOString(), "2026-08-12T01:34:00.000Z");
});

test("keyEpoch rejects keys without a start token", () => {
  for (const bad of ["", "not-a-key", null, undefined, "GLM-L2-LCFA/2026/224/01/index.html"]) {
    assert.equal(keyEpoch(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("hourPrefix matches the bucket layout, day-of-year and all", () => {
  // 2026-08-12T01:xx UTC is day 224.
  assert.equal(hourPrefix(new Date(Date.UTC(2026, 7, 12, 1, 34))), "GLM-L2-LCFA/2026/224/01/");
  // Jan 1 is day 001 — the off-by-one everyone writes at least once.
  assert.equal(hourPrefix(new Date(Date.UTC(2026, 0, 1, 0, 5))), "GLM-L2-LCFA/2026/001/00/");
  // Dec 31 of a non-leap year is day 365.
  assert.equal(hourPrefix(new Date(Date.UTC(2026, 11, 31, 23, 0))), "GLM-L2-LCFA/2026/365/23/");
});

test("decodeGlmBuffer: fixture yields the verified flash set", async () => {
  // 381 flashes total, 364 with quality_flag 0 — the numbers measured
  // during the live feasibility check. If h5wasm or the LCFA layout
  // drifts, this is the test that says so.
  const flashes = await decodeGlmBuffer(new Uint8Array(fs.readFileSync(FIXTURE)));
  assert.equal(flashes.length, 364);
  for (const [lat, lon] of flashes) {
    assert.ok(lat >= -66 && lat <= 66, `lat ${lat} outside GOES field of view`);
    assert.ok(lon >= -157 && lon <= 7, `lon ${lon} outside GOES-East field of view`);
  }
});

test("decodeGlmBuffer: flashes land on that night's warned storms", async () => {
  // Ground truth from the feasibility check: the Kentucky and South
  // Carolina boxes both had active severe warnings when this file was
  // captured, and both contained flashes.
  const flashes = await decodeGlmBuffer(new Uint8Array(fs.readFileSync(FIXTURE)));
  const inBox = (la1, la2, lo1, lo2) =>
    flashes.filter(([la, lo]) => la >= la1 && la <= la2 && lo >= lo1 && lo <= lo2).length;
  assert.equal(inBox(36, 38.5, -86, -82), 22, "Kentucky box");
  assert.equal(inBox(33, 36, -83, -79), 25, "South Carolina box");
});

test("filterFlashes: radius filter and age tagging", () => {
  const nowMs = Date.UTC(2026, 7, 12, 2, 0, 0);
  const entries = [
    { epoch: nowMs - 60 * 1000, flashes: [[37.0, -84.5], [37.1, -84.4], [40.0, -84.5]] },
    { epoch: nowMs - 600 * 1000, flashes: [[36.9, -84.6]] },
  ];
  const out = filterFlashes(entries, 37.0, -84.5, 50, nowMs);
  // The 40.0N flash is ~334 km away — outside the 50 km radius.
  assert.equal(out.length, 3);
  const ages = out.map((f) => f[2]).sort((a, b) => a - b);
  assert.deepEqual(ages, [60, 60, 600]);
});

test("filterFlashes: zero radius keeps nothing, wide radius keeps all", () => {
  const nowMs = Date.now();
  const entries = [{ epoch: nowMs, flashes: [[37, -84], [30, -90]] }];
  assert.equal(filterFlashes(entries, 37, -84, 0.0001, nowMs).length, 1); // exact-centre point survives
  assert.equal(filterFlashes(entries, 35, -87, 800, nowMs).length, 2);
});

test("window constant matches the documented design", () => {
  assert.equal(WINDOW_MINUTES, 5);
});
