// Tests for the IEM two-layer radar model in
// `client/src/components/WeatherMap/iemRadar.js`.
//
// Same constraint as the other client-side test files here: the source
// is ESM and Node's CJS test runner can't `require()` it, so the
// declarations under test are copied verbatim below between the marker
// comments. `test/verbatimSync.test.js` mechanically compares the copy
// against the source, so drift fails loudly rather than silently.
//
// What's locked here:
//
//   1. The zoom crossfade band. This is the subtle one. A band one
//      level wide (mosaic < 8, site > 7) is satisfied by no INTEGER
//      zoom at all, making the "crossfade" a hard cutover. The map now
//      runs with `zoomSnap: 0` so a pinch can rest between levels, but
//      whole levels are still where it lands from the +/- buttons,
//      double-click, and any programmatic `setZoom` — so the band must
//      stay at least two levels wide. Mount gating must also agree with
//      opacity at every step, or a layer is either mounted invisibly
//      (wasted tile fetches) or missing while the fade still wants to
//      draw it (a gap in the radar).
//
//   2. Frame-age classification, which is the whole point of the
//      freshness work — the thresholds encode NEXRAD's irreducible
//      latency floor and must not drift into flagging normal data.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

// ---------- start of verbatim copy from client/src/components/WeatherMap/iemRadar.js ----------

const MOSAIC_OFFSET_MINUTES = [50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];

function mosaicLayerName(minutesAgo) {
  if (!minutesAgo) return "nexrad-n0q-900913";
  return `nexrad-n0q-900913-m${String(minutesAgo).padStart(2, "0")}m`;
}

const BAND_LOW_ZOOM = 7;
const BAND_HIGH_ZOOM = 9;

function layerOpacities(zoom, baseOpacity = 1) {
  if (!Number.isFinite(zoom)) return { mosaic: baseOpacity, site: 0 };
  if (zoom <= BAND_LOW_ZOOM) return { mosaic: baseOpacity, site: 0 };
  if (zoom >= BAND_HIGH_ZOOM) return { mosaic: 0, site: baseOpacity };
  const t = (zoom - BAND_LOW_ZOOM) / (BAND_HIGH_ZOOM - BAND_LOW_ZOOM);
  return { mosaic: baseOpacity * (1 - t), site: baseOpacity * t };
}

function layerVisibility(zoom) {
  if (!Number.isFinite(zoom)) return { mosaic: true, site: false };
  return {
    mosaic: zoom < BAND_HIGH_ZOOM,
    site: zoom > BAND_LOW_ZOOM,
  };
}

const FRAME_FRESH_MS = 6 * 60 * 1000;
const FRAME_STALE_MS = 12 * 60 * 1000;

function frameAge(epoch, now = Date.now()) {
  if (!Number.isFinite(epoch)) {
    return { ageMs: null, ageMinutes: null, level: "unknown" };
  }
  const ageMs = Math.max(0, now - epoch);
  const ageMinutes = Math.floor(ageMs / 60000);
  let level = "fresh";
  if (ageMs >= FRAME_STALE_MS) level = "stale";
  else if (ageMs >= FRAME_FRESH_MS) level = "aging";
  return { ageMs, ageMinutes, level };
}

// ---------- end of verbatim copy ----------

test("mosaic layer names match IEM's fixed 5-minute offset scheme", () => {
  // Current frame is the bare layer name; older frames carry a
  // zero-padded -mNNm suffix. All four forms verified live against
  // IEM on 2026-08-11.
  assert.equal(mosaicLayerName(0), "nexrad-n0q-900913");
  assert.equal(mosaicLayerName(5), "nexrad-n0q-900913-m05m");
  assert.equal(mosaicLayerName(15), "nexrad-n0q-900913-m15m");
  assert.equal(mosaicLayerName(50), "nexrad-n0q-900913-m50m");
});

test("every mosaic offset produces a distinct layer name", () => {
  // A collision would silently animate two frames as one.
  const names = MOSAIC_OFFSET_MINUTES.map(mosaicLayerName);
  assert.equal(new Set(names).size, MOSAIC_OFFSET_MINUTES.length);
});

test("the crossfade band spans at least two integer zoom levels", () => {
  // The regression this file exists for. A band narrower than two levels
  // contains no integer zoom at which both layers are drawn, and integer
  // zooms are where every button, double-click and programmatic setZoom
  // puts the map — so the crossfade silently degrades to the hard
  // cutover it was written to avoid, for everyone not pinching.
  const bothDrawn = [];
  for (let z = 0; z <= 18; z++) {
    const { mosaic, site } = layerOpacities(z);
    if (mosaic > 0 && site > 0) bothDrawn.push(z);
  }
  assert.ok(
    bothDrawn.length >= 1,
    "no integer zoom draws both layers — the crossfade is a hard cutover"
  );
});

test("mount gating agrees with opacity at every integer zoom", () => {
  // A layer must be mounted exactly when its opacity is non-zero.
  // Mounted-at-zero wastes tile requests on a kiosk; unmounted-but-
  // wanted leaves a hole in the radar mid-fade.
  for (let z = 0; z <= 18; z++) {
    const op = layerOpacities(z);
    const vis = layerVisibility(z);
    assert.equal(op.mosaic > 0, vis.mosaic, `mosaic mismatch at z=${z}`);
    assert.equal(op.site > 0, vis.site, `site mismatch at z=${z}`);
  }
});

test("total radar opacity never drops through the band", () => {
  // The two layers ramp in opposite directions, so their sum must stay
  // at the user's chosen opacity — otherwise the radar visibly dims as
  // the user zooms across the handover.
  for (let z = 0; z <= 18; z++) {
    const { mosaic, site } = layerOpacities(z, 0.8);
    assert.ok(
      Math.abs((mosaic + site) - 0.8) < 1e-9,
      `total ink ${mosaic + site} at z=${z}, expected 0.8`
    );
  }
});

test("layer opacity respects the user's radar-opacity preference", () => {
  // The crossfade scales the preference, never overrides it.
  assert.deepEqual(layerOpacities(3, 0.5), { mosaic: 0.5, site: 0 });
  assert.deepEqual(layerOpacities(14, 0.5), { mosaic: 0, site: 0.5 });
  const mid = layerOpacities(8, 0.5);
  assert.ok(mid.mosaic > 0 && mid.site > 0);
  assert.ok(Math.abs(mid.mosaic + mid.site - 0.5) < 1e-9);
});

test("layer helpers tolerate a missing zoom", () => {
  // currentMapZoom can be undefined for the first frame after mount,
  // before MapZoomTracker reports. Falling back to the wide-area layer
  // is the safe default — never a blank map.
  assert.deepEqual(layerOpacities(undefined, 1), { mosaic: 1, site: 0 });
  assert.deepEqual(layerVisibility(undefined), { mosaic: true, site: false });
});

test("frame age classifies against NEXRAD's real latency floor", () => {
  const now = Date.UTC(2026, 7, 11, 22, 0, 0);
  const minsAgo = (m) => now - m * 60 * 1000;

  // A volume scan takes 4-6 min to complete before any product exists,
  // so a 4-minute-old frame is as current as this data physically gets
  // and must NOT be flagged. (4.1 min was the measured live age.)
  assert.equal(frameAge(minsAgo(0), now).level, "fresh");
  assert.equal(frameAge(minsAgo(4), now).level, "fresh");
  assert.equal(frameAge(minsAgo(5), now).level, "fresh");

  // Past a normal scan interval — worth noticing.
  assert.equal(frameAge(minsAgo(6), now).level, "aging");
  assert.equal(frameAge(minsAgo(11), now).level, "aging");

  // The original complaint was data appearing ~15 min behind; that must
  // read as unambiguously stale.
  assert.equal(frameAge(minsAgo(12), now).level, "stale");
  assert.equal(frameAge(minsAgo(15), now).level, "stale");
  assert.equal(frameAge(minsAgo(60), now).level, "stale");
});

test("frame age reports whole elapsed minutes", () => {
  const now = Date.UTC(2026, 7, 11, 22, 0, 0);
  assert.equal(frameAge(now, now).ageMinutes, 0);
  assert.equal(frameAge(now - 90 * 1000, now).ageMinutes, 1);   // 1.5 min floors to 1
  assert.equal(frameAge(now - 7 * 60 * 1000, now).ageMinutes, 7);
});

test("frame age handles a clock skew without going negative", () => {
  // A frame timestamped slightly in the future (server/client clock
  // drift) must read as "now", not as a negative age.
  const now = Date.UTC(2026, 7, 11, 22, 0, 0);
  const future = frameAge(now + 90 * 1000, now);
  assert.equal(future.ageMs, 0);
  assert.equal(future.ageMinutes, 0);
  assert.equal(future.level, "fresh");
});

test("frame age reports unknown rather than guessing", () => {
  // No frame means no claim about freshness — the chip hides entirely
  // rather than implying the radar is current.
  for (const bad of [null, undefined, NaN, "202608112158"]) {
    assert.equal(frameAge(bad).level, "unknown");
  }
});
