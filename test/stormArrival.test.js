// Tests for the storm-arrival estimate (client/src/components/WeatherMap/
// stormArrival.js) — "when does this cell reach home?"
//
// The client module is ESM, so the pure helpers are copied verbatim below
// and guarded by test/verbatimSync.test.js.
//
// The behaviour these tests protect: the estimate must come from the
// cell's FORECAST MOTION (track direction), never from the MOVEMENT
// field, and it must answer null — not a number — for cells that are
// new, moving away, passing wide, or too far out to trust.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

// ---------- start of verbatim copy from client/src/components/WeatherMap/stormArrival.js ----------

const ARRIVAL_MAX_PASS_KM = 20;

const ARRIVAL_MAX_MINUTES = 180;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;
const KM_PER_NAUTICAL_MILE = 1.852;

function localOffsetKm(origin, point) {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (point.lon - origin.lon) * KM_PER_DEG_LON_EQUATOR * cosLat,
    y: (point.lat - origin.lat) * KM_PER_DEG_LAT,
  };
}

function estimateArrival(cell, home, opts = {}) {
  const maxPassKm = opts.maxPassKm ?? ARRIVAL_MAX_PASS_KM;
  const maxMinutes = opts.maxMinutes ?? ARRIVAL_MAX_MINUTES;
  if (!cell || !home || !Number.isFinite(cell.lat) || !Number.isFinite(cell.lon)) return null;
  if (!Number.isFinite(home.lat) || !Number.isFinite(home.lon)) return null;

  const track = Array.isArray(cell.track) ? cell.track : [];
  const last = track.length > 1 ? track[track.length - 1] : null;
  if (!last || !Number.isFinite(last.lat) || !Number.isFinite(last.lon)) return null;

  const origin = { lat: cell.lat, lon: cell.lon };
  const motion = localOffsetKm(origin, last);
  const spanKm = Math.hypot(motion.x, motion.y);
  if (spanKm < 0.1) return null;

  // Speed: km per minute. `speedKt` is the product's number; fall back to
  // the forecast span over its stated horizon.
  let kmPerMin = null;
  if (Number.isFinite(cell.speedKt) && cell.speedKt > 0) {
    kmPerMin = (cell.speedKt * KM_PER_NAUTICAL_MILE) / 60;
  } else {
    const forecast = Array.isArray(cell.forecast) ? cell.forecast : [];
    const horizon = forecast.length ? forecast[forecast.length - 1].minutes : null;
    if (Number.isFinite(horizon) && horizon > 0) kmPerMin = spanKm / horizon;
  }
  if (!kmPerMin || kmPerMin <= 0) return null;

  // Unit heading vector, then project home onto the ray from the cell.
  const ux = motion.x / spanKm;
  const uy = motion.y / spanKm;
  const toHome = localOffsetKm(origin, home);
  const along = toHome.x * ux + toHome.y * uy;
  if (along <= 0) return null; // already past, or moving away
  const passKm = Math.abs(toHome.x * uy - toHome.y * ux);
  if (passKm > maxPassKm) return null;

  const minutes = Math.round(along / kmPerMin);
  if (minutes > maxMinutes) return null;
  return { minutes, passKm: Math.round(passKm * 10) / 10 };
}

// ---------- end of verbatim copy ----------

// A cell 30 km due west of home, moving due east at 30 kt (55.6 km/h).
// Forecast track spans 60 min → ~55.6 km east.
const HOME = { lat: 40.0, lon: -75.0 };
const kmEastToLon = (km, lat) => km / (KM_PER_DEG_LON_EQUATOR * Math.cos((lat * Math.PI) / 180));
const westCell = (speedKt = 30) => {
  const lon0 = HOME.lon - kmEastToLon(30, HOME.lat);
  const lon60 = lon0 + kmEastToLon((speedKt * KM_PER_NAUTICAL_MILE) / 60 * 60, HOME.lat);
  return {
    id: "T1",
    lat: HOME.lat,
    lon: lon0,
    speedKt,
    forecast: [{ minutes: 60, lat: HOME.lat, lon: lon60 }],
    track: [{ lat: HOME.lat, lon: lon0 }, { lat: HOME.lat, lon: lon60 }],
  };
};

test("a cell heading straight for home arrives in distance / speed minutes", () => {
  const r = estimateArrival(westCell(), HOME);
  assert.ok(r, "expected an estimate");
  // 30 km at 30 kt (0.926 km/min) ≈ 32.4 min.
  assert.equal(r.minutes, 32);
  assert.ok(r.passKm < 0.5, `passes essentially over home, got ${r.passKm}`);
});

test("speed falls back to the forecast span when speedKt is missing", () => {
  const cell = { ...westCell(30), speedKt: null };
  const r = estimateArrival(cell, HOME);
  assert.ok(r);
  // Same geometry, same answer (±1 min of rounding).
  assert.ok(Math.abs(r.minutes - 32) <= 1, `got ${r.minutes}`);
});

test("a cell moving away from home yields null", () => {
  const cell = westCell();
  // Flip the track: forecast position further WEST.
  cell.track[1] = { lat: HOME.lat, lon: cell.lon - kmEastToLon(50, HOME.lat) };
  assert.equal(estimateArrival(cell, HOME), null);
});

test("a cell that passes wide of home yields null; the cutoff is configurable", () => {
  const cell = westCell();
  // Shift the whole track 30 km north of home.
  const dLat = 30 / KM_PER_DEG_LAT;
  cell.lat += dLat;
  cell.track = cell.track.map((p) => ({ lat: p.lat + dLat, lon: p.lon }));
  assert.equal(estimateArrival(cell, HOME), null);
  const wide = estimateArrival(cell, HOME, { maxPassKm: 40 });
  assert.ok(wide);
  assert.ok(Math.abs(wide.passKm - 30) < 1, `pass distance ${wide.passKm}`);
});

test("a NEW cell (single-point track) has no estimate", () => {
  const cell = { id: "N1", lat: 40, lon: -75.5, speedKt: null, isNew: true, track: [{ lat: 40, lon: -75.5 }] };
  assert.equal(estimateArrival(cell, HOME), null);
});

test("estimates beyond the horizon are dropped", () => {
  // 30 km away at a crawl: 3 kt ≈ 5.6 km/h → ~5 h.
  assert.equal(estimateArrival(westCell(3), HOME), null);
  assert.ok(estimateArrival(westCell(3), HOME, { maxMinutes: 600 }));
});

test("bad inputs never throw", () => {
  assert.equal(estimateArrival(null, HOME), null);
  assert.equal(estimateArrival(westCell(), null), null);
  assert.equal(estimateArrival({ lat: NaN, lon: 1, track: [] }, HOME), null);
  assert.equal(estimateArrival(westCell(), { lat: null, lon: null }), null);
});
