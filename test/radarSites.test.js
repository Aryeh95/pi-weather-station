// Radar site picker + sticky home radar: the static WSR-88D list and the
// pure geometry over it.
//
// The list is data (155 sites from NWS /radar/stations, WSR-88D only,
// overseas DoD radars excluded), so
// the tests pin its shape and the two sites the motivating report was
// about. The helpers are a verbatim copy of client/src/components/
// WeatherMap/radarSites.js (ESM, Node's CJS runner cannot import it),
// registered with verbatimSync.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

const sites = require("../client/src/components/WeatherMap/nexradSites.json");

// ---------- start of verbatim copy from client/src/components/WeatherMap/radarSites.js ----------

const SITE_STICKY_KM = 200;

const EARTH_R_KM = 6371;

function distanceKm(a, b) {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return EARTH_R_KM * Math.acos(Math.max(-1, Math.min(1, x)));
}

function nearestSite(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const here = { lat, lon };
  let best = null;
  let bestKm = Infinity;
  for (const s of sites) {
    const km = distanceKm(here, s);
    if (km < bestKm) {
      best = s;
      bestKm = km;
    }
  }
  return best;
}

function homeSiteCoversView(pin, view) {
  if (!pin || !view) return false;
  const home = nearestSite(pin.lat, pin.lon);
  if (!home) return false;
  return distanceKm(view, home) <= SITE_STICKY_KM;
}

function iemSiteId(id) {
  const s = String(id || "").toUpperCase();
  return s.length === 4 ? s.slice(1) : s;
}

// ---------- end of verbatim copy ----------

const PIKESVILLE = { lat: 39.37, lon: -76.72 };
const CHESAPEAKE_BAY_VIEW = { lat: 39.25, lon: -76.20 }; // the kiosk view centre in the report

test("site list: every entry is a 4-letter WSR-88D id with CONUS/AK/HI/PR coordinates", () => {
  assert.ok(sites.length >= 150 && sites.length <= 170, `unexpected count ${sites.length}`);
  const ids = new Set();
  for (const s of sites) {
    assert.match(s.id, /^[KPT][A-Z]{3}$/);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    assert.ok(s.lat > 13 && s.lat < 72 && s.lon > -178 && s.lon < -64, `${s.id} at ${s.lat},${s.lon}`);
    assert.equal(typeof s.name, "string");
  }
  assert.ok(ids.has("KLWX") && ids.has("KDOX"), "the two sites from the motivating report");
});

test("nearestSite: Pikesville is KLWX, and the Bay view centre alone would be KDOX", () => {
  assert.equal(nearestSite(PIKESVILLE.lat, PIKESVILLE.lon).id, "KLWX");
  assert.equal(nearestSite(CHESAPEAKE_BAY_VIEW.lat, CHESAPEAKE_BAY_VIEW.lon).id, "KDOX");
  assert.equal(nearestSite(NaN, -76), null);
});

test("homeSiteCoversView: the Bay view stays on the Pikesville home radar; Philadelphia does not", () => {
  // ~110 km from KLWX — inside the sticky radius, so the pin decides.
  assert.equal(homeSiteCoversView(PIKESVILLE, CHESAPEAKE_BAY_VIEW), true);
  // Philadelphia is ~215 km from KLWX — beyond it, the view centre takes over.
  assert.equal(homeSiteCoversView(PIKESVILLE, { lat: 39.95, lon: -75.17 }), false);
  assert.equal(homeSiteCoversView(null, CHESAPEAKE_BAY_VIEW), false);
  assert.equal(homeSiteCoversView(PIKESVILLE, null), false);
});

test("iemSiteId: strips the ICAO region letter, leaves 3-letter ids alone", () => {
  assert.equal(iemSiteId("KLWX"), "LWX");
  assert.equal(iemSiteId("lwx"), "LWX");
  assert.equal(iemSiteId("TJUA"), "JUA");
  assert.equal(iemSiteId(""), "");
});
