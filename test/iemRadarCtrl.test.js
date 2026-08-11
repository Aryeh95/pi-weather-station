// Tests for the IEM radar controller's pure helpers
// (`server/iemRadarCtrl.js`).
//
// Unlike the client-side test files in this directory, this one
// `require()`s the real module — the server is CJS, so no verbatim copy
// is needed and no drift is possible.
//
// The transforms covered here are the ones where a silent error would
// be hard to spot on screen: a wrong timestamp format produces a 503
// from IEM (blank radar, no error surfaced to the user), and a wrong
// site id produces tiles for the wrong part of the country — which
// looks like plausible weather, just not yours.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { toTileStamp, toEpochMs, normalizeSiteId } = require("../server/iemRadarCtrl");

test("toTileStamp converts IEM scan times to the RIDGE URL segment", () => {
  // The exact form IEM's `operation=list` returns, and the exact form
  // the `ridge::XXX-N0B-<stamp>` tile path expects. Verified live
  // against both endpoints on 2026-08-11.
  assert.equal(toTileStamp("2026-08-11T21:51Z"), "202608112151");
  // Zero-padding must survive on every component.
  assert.equal(toTileStamp("2026-01-02T03:04Z"), "202601020304");
  // Midnight is the case a naive formatter most often breaks.
  assert.equal(toTileStamp("2026-12-31T00:00Z"), "202612310000");
});

test("toTileStamp rejects anything it cannot parse", () => {
  // A malformed value must NOT silently become a plausible-looking
  // stamp — a wrong-but-well-formed timestamp yields a 503 and blank
  // radar, whereas null lets the caller drop the frame.
  for (const bad of ["", "garbage", "2026-08-11", null, undefined, 42, {}]) {
    assert.equal(toTileStamp(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("toEpochMs parses IEM scan times as UTC", () => {
  // The trailing Z makes these unambiguous; the parsed value must not
  // drift with the machine's local timezone, or every displayed frame
  // age would be off by the UTC offset.
  assert.equal(toEpochMs("2026-08-11T21:51Z"), Date.UTC(2026, 7, 11, 21, 51, 0, 0));
  assert.equal(toEpochMs("2026-01-01T00:00Z"), Date.UTC(2026, 0, 1, 0, 0, 0, 0));
  assert.equal(toEpochMs("nonsense"), null);
  assert.equal(toEpochMs(null), null);
});

test("normalizeSiteId maps NWS 4-char station ids to IEM's 3-char form", () => {
  // api.weather.gov/points reports an ICAO-style id; IEM's RIDGE layers
  // use three letters. Dropping the leading region letter is correct
  // across all NEXRAD regions, not just CONUS.
  assert.equal(normalizeSiteId("KDIX"), "DIX");   // CONUS  (verified live)
  assert.equal(normalizeSiteId("PAHG"), "AHG");   // Alaska
  assert.equal(normalizeSiteId("TJUA"), "JUA");   // Puerto Rico
  assert.equal(normalizeSiteId("PHKI"), "HKI");   // Hawaii
});

test("normalizeSiteId passes through ids that are already 3 characters", () => {
  // IEM's own `operation=available` returns the short form, so the
  // fallback path must not strip a second letter off it.
  assert.equal(normalizeSiteId("DIX"), "DIX");
  assert.equal(normalizeSiteId("dix"), "DIX");
  assert.equal(normalizeSiteId("  dix  "), "DIX");
});

test("normalizeSiteId rejects implausible ids", () => {
  // Guards the query-parameter path on /api/radar/frames: `site` comes
  // straight from the client, and it is interpolated into an outbound
  // URL. Anything not [A-Z]{3,4} must be refused rather than passed on.
  for (const bad of ["", "X", "XX", "TOOLONG", "DI1", "D-X", "../x", null, undefined, 7]) {
    assert.equal(normalizeSiteId(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});
