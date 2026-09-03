// Tests for the committed IEM N0Q colour table
// (client/src/components/WeatherMap/iemN0qPalette.json), the basis of
// the tile-side clear-air noise filter.
//
// The table was captured from IEM's own raster documentation
// (mesonet.agron.iastate.edu/GIS/rasters.php?rid=2, "composite_n0q") on
// 2026-09-03. Two properties make the filter exact rather than
// heuristic, and both are asserted here so a re-capture that breaks
// either fails loudly:
//
//   1. every colour is unique, so RGB → dBZ is a function;
//   2. dBZ is linear in the colour index (index / 2 − 32.5), which is
//      how IEM's 8-bit N0Q rasters are defined.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

const palette = require("../client/src/components/WeatherMap/iemN0qPalette.json");

test("palette carries the 255 colour indices of an 8-bit N0Q raster", () => {
  assert.equal(palette.length, 255);
  for (const row of palette) {
    assert.equal(row.length, 4);
    const [dbz, r, g, b] = row;
    assert.ok(Number.isFinite(dbz));
    for (const c of [r, g, b]) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255);
  }
});

test("dBZ is linear in colour index: index / 2 - 32.5", () => {
  palette.forEach(([dbz], i) => {
    const index = i + 1; // index 0 is the transparent "no data" slot
    assert.equal(dbz, index / 2 - 32.5, `row ${i}`);
  });
  assert.equal(palette[0][0], -32);
  assert.equal(palette[palette.length - 1][0], 95);
});

test("every colour is unique, so colour -> dBZ is a function", () => {
  const seen = new Set();
  for (const [, r, g, b] of palette) {
    const key = (r << 16) | (g << 8) | b;
    assert.ok(!seen.has(key), `duplicate colour rgb(${r}, ${g}, ${b})`);
    seen.add(key);
  }
});

test("the 15 dBZ noise-filter threshold splits the table where expected", () => {
  // Below 15 dBZ: the purples/greys/blues of clear-air return. From 15 up:
  // the cyan → green ramp where drizzle starts. 94 rows sit below 15.
  const below = palette.filter(([dbz]) => dbz < 15);
  assert.equal(below.length, 94);
  const [dbz15] = palette[94];
  assert.equal(dbz15, 15);
});
