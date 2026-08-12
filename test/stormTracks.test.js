// Tests for the storm-tracks controller's pure helpers
// (`server/stormTracksCtrl.js`).
//
// Like iemRadarCtrl.test.js, this requires the real CJS module — no
// verbatim copy needed, no drift possible.
//
// The one behaviour these tests exist to protect: THE TRACK MUST POINT
// WHERE THE STORM IS GOING. The product's MOVEMENT column is the
// direction a storm comes FROM (verified against live DIX data,
// 2026-08-12: every cell's forecast positions walk along MOVEMENT − 180°,
// deltas 0.6–3.9°). The controller therefore builds `track` from the
// forecast POSITIONS and never derives a heading from MOVEMENT. If
// someone later "simplifies" that to an arrow off movementFromDeg, the
// direction test below fails.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseCellRows,
  toGeoCell,
  offsetLatLon,
  parsePair,
} = require("../server/stormTracksCtrl");

// Real page-0 rows captured from DIX_NST_2026_08_12_00_22_49 — the same
// live file the feature was verified against. Header lines included so
// the parser's header rejection is exercised on authentic input.
const LIVE_PAGE = [
  "                            STORM POSITION/FORECAST                             ",
  "     RADAR ID 523  DATE/TIME 08:12:26/00:22:49   NUMBER OF STORM CELLS   4      ",
  "                                                                                ",
  "                   AVG SPEED 20 KTS    AVG DIRECTION 310 DEG                    ",
  "                                                                                ",
  " STORM    CURRENT POSITION              FORECAST POSITIONS               ERROR  ",
  "  ID     AZRAN     MOVEMENT    15 MIN    30 MIN    45 MIN    60 MIN    FCST/MEAN",
  "        (DEG/NM)  (DEG/KTS)   (DEG/NM)  (DEG/NM)  (DEG/NM)  (DEG/NM)     (NM)   ",
  "                                                                                ",
  "  T3      48/110   308/ 22      51/111    54/112    56/114    59/116    0.3/ 0.8",
  "  X3     339/ 76   320/ 19     340/ 72   341/ 67   343/ 63   345/ 58    0.2/ 1.2",
  "  E4      33/ 61     NEW       NO DATA   NO DATA   NO DATA   NO DATA    0.0/ 0.0",
  "  C4     347/ 77   302/ 19     349/ 74   352/ 71   355/ 68   359/ 65    0.1/ 0.3",
];

// DIX site coordinates from the same product's descriptor.
const DIX = { lat: 39.947, lon: -74.411 };

/**
 * Bearing between two geo points, degrees clockwise from north.
 * Test-local — the controller deliberately has no bearing helper to
 * borrow, since it never derives direction.
 */
function bearing(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const dLon = r(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat))
    - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

test("parsePair reads az/range tokens and rejects non-pairs", () => {
  assert.deepEqual(parsePair("48/110"), { azimuth: 48, rangeNm: 110 });
  assert.deepEqual(parsePair("0.3/0.8"), { azimuth: 0.3, rangeNm: 0.8 });
  for (const bad of ["NEW", "NODATA", "", null, undefined, "48/", "/110", "a/b"]) {
    assert.equal(parsePair(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("parseCellRows: live page yields exactly the four cells", () => {
  const rows = parseCellRows(LIVE_PAGE);
  assert.deepEqual(rows.map((r) => r.id), ["T3", "X3", "E4", "C4"]);
});

test("parseCellRows: header and blank lines never parse as cells", () => {
  // The header contains slashed tokens ("FCST/MEAN", "(DEG/NM)") that a
  // sloppier parser could mistake for data. Feed ONLY the non-data lines
  // and require zero rows.
  const headerOnly = LIVE_PAGE.filter((l) => !/^\s+[A-Z]\d\s/.test(l));
  assert.deepEqual(parseCellRows(headerOnly), []);
});

test("parseCellRows: a tracked cell carries movement and four forecasts", () => {
  const t3 = parseCellRows(LIVE_PAGE)[0];
  assert.deepEqual(t3.position, { azimuth: 48, rangeNm: 110 });
  assert.deepEqual(t3.movement, { azimuth: 308, rangeNm: 22 });
  assert.equal(t3.forecast.length, 4);
  assert.deepEqual(t3.forecast[0], { azimuth: 51, rangeNm: 111 });
  assert.deepEqual(t3.forecast[3], { azimuth: 59, rangeNm: 116 });
});

test("parseCellRows: a NEW cell has null movement and null forecasts", () => {
  const e4 = parseCellRows(LIVE_PAGE).find((r) => r.id === "E4");
  assert.equal(e4.movement, null);
  assert.deepEqual(e4.forecast, [null, null, null, null]);
});

test("toGeoCell: track points where the storm is GOING, not where it came from", () => {
  // The regression this file exists for. T3's MOVEMENT reads 308° — but
  // its forecast positions head ~128° (308 − 180). The rendered track
  // must follow the forecasts. If this fails, arrows point backwards on
  // a severe-weather display.
  const rows = parseCellRows(LIVE_PAGE);
  for (const row of rows) {
    const cell = toGeoCell(row, DIX.lat, DIX.lon);
    if (cell.track.length < 2 || cell.movementFromDeg == null) continue;
    const measured = bearing(cell.track[0], cell.track[cell.track.length - 1]);
    const heading = (cell.movementFromDeg + 180) % 360;
    let delta = Math.abs(measured - heading);
    if (delta > 180) delta = 360 - delta;
    assert.ok(
      delta < 20,
      `${cell.id}: track bearing ${measured.toFixed(1)}° should be ~${heading}° `
      + `(MOVEMENT ${cell.movementFromDeg}° is a FROM direction), off by ${delta.toFixed(1)}°`
    );
  }
});

test("toGeoCell: NEW cell is a single point — no invented direction", () => {
  const e4 = parseCellRows(LIVE_PAGE).find((r) => r.id === "E4");
  const cell = toGeoCell(e4, DIX.lat, DIX.lon);
  assert.equal(cell.isNew, true);
  assert.equal(cell.speedKt, null);
  assert.equal(cell.movementFromDeg, null);
  assert.equal(cell.track.length, 1);
  assert.deepEqual(cell.forecast, []);
});

test("toGeoCell: geometry matches the independent great-circle check", () => {
  // T3: az 48° range 110 nm from DIX → the coordinates computed during
  // the feasibility check with a separate Python implementation.
  const t3 = parseCellRows(LIVE_PAGE)[0];
  const cell = toGeoCell(t3, DIX.lat, DIX.lon);
  assert.ok(Math.abs(cell.lat - 41.159) < 0.005, `lat ${cell.lat}`);
  assert.ok(Math.abs(cell.lon - -72.6026) < 0.005, `lon ${cell.lon}`);
});

test("offsetLatLon: zero distance is the identity", () => {
  const p = offsetLatLon(40, -75, 123, 0);
  assert.ok(Math.abs(p.lat - 40) < 1e-9);
  assert.ok(Math.abs(p.lon - -75) < 1e-9);
});

test("offsetLatLon: cardinal sanity at radar scale", () => {
  const north = offsetLatLon(40, -75, 0, 111.2); // ~1° of latitude
  assert.ok(Math.abs(north.lat - 41) < 0.01);
  assert.ok(Math.abs(north.lon - -75) < 1e-6);
  const east = offsetLatLon(40, -75, 90, 100);
  assert.ok(Math.abs(east.lat - 40) < 0.05);
  assert.ok(east.lon > -75);
});
