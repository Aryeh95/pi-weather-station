// Storm arrival estimate — "when does this cell reach home?"
//
// SCIT gives each cell a current position and forecast positions 15/30/
// 45/60 min out. Those forecast positions ARE the motion (the product's
// MOVEMENT column is a FROM-direction and is never used for heading —
// see server/stormTracksCtrl.js). This module projects the home point
// onto that motion and answers two things: how many minutes until the
// cell's closest approach, and how far off it passes.
//
// Pure geometry, no React — copied verbatim into test/stormArrival.test.js
// and guarded by test/verbatimSync.test.js.

// Only cells that will pass within this distance of home get an arrival
// label. 20 km is roughly one SCIT cell diameter plus positional noise:
// a cell that passes farther out is "nearby", not "arriving".
export const ARRIVAL_MAX_PASS_KM = 20;

// Beyond this the extrapolation is guesswork — SCIT itself only forecasts
// an hour, and storms turn. Three hours: a line 200 km out at 40 kt is
// exactly the "is that coming here tonight" case the kiosk exists for
// (measured live 2026-09-03: a cell 195 km WNW of home, passing 7 km off,
// 147 min out — invisible under the earlier 120-min cap).
export const ARRIVAL_MAX_MINUTES = 180;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;
const KM_PER_NAUTICAL_MILE = 1.852;

/**
 * Local flat-earth offset from `origin` to `point`, in km east/north.
 *
 * Equirectangular is plenty here: the projection spans at most a few
 * hundred km and the answer is displayed to the minute.
 *
 * @param {{lat: Number, lon: Number}} origin
 * @param {{lat: Number, lon: Number}} point
 * @returns {{x: Number, y: Number}} km east (x) and north (y) of origin
 */
export function localOffsetKm(origin, point) {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    x: (point.lon - origin.lon) * KM_PER_DEG_LON_EQUATOR * cosLat,
    y: (point.lat - origin.lat) * KM_PER_DEG_LAT,
  };
}

/**
 * Estimate when a storm cell reaches (its closest approach to) a point.
 *
 * Motion comes from the cell's track — current position to its LAST
 * forecast position — so the heading is the one SCIT actually forecast.
 * Speed prefers the product's own `speedKt`; when absent it is derived
 * from the forecast span (the last forecast point's `minutes` field).
 *
 * Returns null when the cell has no motion yet (`NEW`), is moving away,
 * will pass farther than `maxPassKm` from the point, or would take longer
 * than `maxMinutes` to get there.
 *
 * @param {object} cell storm cell from /api/storm-tracks (`lat`, `lon`, `speedKt`, `track`, `forecast`)
 * @param {{lat: Number, lon: Number}|null} home the point of interest
 * @param {object} [opts]
 * @param {Number} [opts.maxPassKm] closest-approach cutoff
 * @param {Number} [opts.maxMinutes] horizon cutoff
 * @returns {{minutes: Number, passKm: Number}|null} minutes to closest approach and the miss distance
 */
export function estimateArrival(cell, home, opts = {}) {
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
