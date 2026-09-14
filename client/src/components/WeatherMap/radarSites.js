// NEXRAD site geometry helpers over the static WSR-88D list.
//
// `nexradSites.json` is the NWS `/radar/stations` list filtered to
// `stationType === "WSR-88D"`, minus the four overseas DoD radars (Guam,
// Korea, Okinawa) that IEM and the Level III bucket do not carry — 155
// sites, generated 2026-09-14. It is
// shipped statically rather than fetched: the network of radars changes
// on the order of years, the picker needs every site at once (not the
// "near a point" subset IEM serves), and the Android app has no server
// to ask. Regenerate with the one-liner in CLAUDE.md if a site is added.

import sites from "./nexradSites.json";

export const NEXRAD_SITES = sites;

// A radar's single-site product keeps the HOME radar while the map view
// stays within this distance of it. N0B coverage runs to 230 km and the
// radial disc is drawn to 300 km, so inside 200 km the home radar still
// has a better (lower, closer) view than whichever site happens to be
// nearest the view centre — the case that put Pikesville on KDOX when
// the kiosk's view centre sat over the Chesapeake Bay.
export const SITE_STICKY_KM = 200;

const EARTH_R_KM = 6371;

/**
 * Great-circle distance between two points.
 *
 * @param {{lat: Number, lon: Number}} a
 * @param {{lat: Number, lon: Number}} b
 * @returns {Number} km
 */
export function distanceKm(a, b) {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return EARTH_R_KM * Math.acos(Math.max(-1, Math.min(1, x)));
}

/**
 * The WSR-88D nearest a point.
 *
 * @param {Number} lat
 * @param {Number} lon
 * @returns {{id: String, name: String, lat: Number, lon: Number}|null}
 */
export function nearestSite(lat, lon) {
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

/**
 * Whether the home radar (nearest the pin) should keep serving a map
 * view centred at `view`: true while the view is inside SITE_STICKY_KM
 * of it, so panning around one radar's coverage never flips sites.
 *
 * @param {{lat: Number, lon: Number}|null} pin home location
 * @param {{lat: Number, lon: Number}|null} view map view centre
 * @returns {Boolean}
 */
export function homeSiteCoversView(pin, view) {
  if (!pin || !view) return false;
  const home = nearestSite(pin.lat, pin.lon);
  if (!home) return false;
  return distanceKm(view, home) <= SITE_STICKY_KM;
}

/**
 * Site id in the 3-letter IEM form (`KLWX` → `LWX`, `LWX` → `LWX`).
 *
 * @param {String} id
 * @returns {String}
 */
export function iemSiteId(id) {
  const s = String(id || "").toUpperCase();
  return s.length === 4 ? s.slice(1) : s;
}
