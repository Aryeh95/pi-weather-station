// Sunrise / sunset, computed locally.
//
// This replaces a call to api.sunrise-sunset.org. The result is deterministic
// astronomy — the same NOAA solar-position algorithm that upstream runs — so
// there was nothing to gain from a network round trip and three things to
// lose: a dependency that can rate-limit or go down, a failure mode where the
// kiosk's auto dark-mode simply stops flipping, and (in the Android app) a
// request that has to complete before the palette can settle.
//
// Ported from the sibling e-paper project's `platformio/src/sun.cpp`, which
// runs the same maths on an ESP32; keeping the two in step means a fix in
// either is a readable diff against the other.
//
// Accuracy: this is the standard NOAA approximation. Checked against the
// US Naval Observatory in `test/solar.test.js` — worst disagreement was
// 2.0 min across the lower 48, Alaska and Hawaii, and 3.3 min at 71 deg N,
// where the sun crosses the horizon slowly enough that a calculation
// anchored at 00:00 UT drifts.

const DEG = Math.PI / 180;

// Solar zenith angles, in degrees from vertical.
//   90.833° — the horizon, allowing for atmospheric refraction and the
//             apparent radius of the solar disc. This is "sunrise".
//   96°     — civil twilight, the conventional "usable daylight" bound.
const ZENITH_SUNRISE = 90.833;
const ZENITH_CIVIL = 96;

/**
 * Julian Day Number for a Gregorian calendar date.
 *
 * @param {number} y full year
 * @param {number} m month, 1-12
 * @param {number} d day of month
 * @returns {number} Julian Day Number
 */
function julianDayNumber(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return (
    d
    + Math.floor((153 * mm + 2) / 5)
    + 365 * yy
    + Math.floor(yy / 4)
    - Math.floor(yy / 100)
    + Math.floor(yy / 400)
    - 32045
  );
}

/**
 * Solar quantities for a date, shared by every zenith on that date.
 *
 * @param {number} jdn Julian Day Number
 * @returns {{decl: number, eqTime: number}} declination (radians) and the
 *   equation of time (minutes)
 */
function solarTerms(jdn) {
  // Julian centuries since J2000.0, taken at 00:00 UT on the given date.
  const JD = jdn - 0.5;
  const T = (JD - 2451545.0) / 36525.0;

  // Geometric mean longitude and mean anomaly of the sun (degrees).
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  // Eccentricity of Earth's orbit.
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  // Equation of the centre.
  const C = Math.sin(M * DEG) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * M * DEG) * 0.000289;

  // Apparent longitude, corrected for nutation and aberration.
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Obliquity of the ecliptic, corrected.
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * DEG);

  const decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG));

  // Equation of time, in minutes.
  const y = Math.tan((eps / 2) * DEG) ** 2;
  const eqTime = (4 / DEG) * (
    y * Math.sin(2 * L0 * DEG)
    - 2 * e * Math.sin(M * DEG)
    + 4 * e * y * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG)
    - 0.5 * y * y * Math.sin(4 * L0 * DEG)
    - 1.25 * e * e * Math.sin(2 * M * DEG)
  );

  return { decl, eqTime };
}

/**
 * The pair of times the sun crosses a given zenith on a date.
 *
 * @param {number} jdn Julian Day Number
 * @param {number} lat latitude in degrees
 * @param {number} lon longitude in degrees
 * @param {number} zenith solar zenith angle in degrees
 * @returns {{rise: Date, set: Date}|null} null when the sun never reaches
 *   that zenith on this date (polar day or polar night)
 */
function crossings(jdn, lat, lon, zenith) {
  const { decl, eqTime } = solarTerms(jdn);

  const cosHA = Math.cos(zenith * DEG) / (Math.cos(lat * DEG) * Math.cos(decl))
    - Math.tan(lat * DEG) * Math.tan(decl);
  if (cosHA > 1 || cosHA < -1) return null;
  const ha = Math.acos(cosHA) / DEG;

  // Minutes past 00:00 UTC.
  const solarNoon = 720 - 4 * lon - eqTime;
  const riseMinutes = solarNoon - 4 * ha;
  const setMinutes = solarNoon + 4 * ha;

  // Unix ms at 00:00 UTC on the given date. Either crossing may fall outside
  // that UTC day — a late sunset west of Greenwich lands after 00:00 UTC the
  // next day — which the minute offsets below carry naturally.
  const midnightUTC = (jdn - 2440588) * 86400 * 1000;
  return {
    rise: new Date(midnightUTC + Math.round(riseMinutes * 60 * 1000)),
    set: new Date(midnightUTC + Math.round(setMinutes * 60 * 1000)),
  };
}

/**
 * Sunrise / sunset for one date, in the shape the client already reads.
 *
 * Field names and the ISO-with-offset format match what
 * api.sunrise-sunset.org returned, because the client stores this payload
 * as-is and the kiosk has been reading those keys since long before the
 * calculation moved in-process.
 *
 * @param {string} date calendar date as `YYYY-MM-DD`
 * @param {number} lat latitude in degrees
 * @param {number} lon longitude in degrees
 * @returns {object|null} `{sunrise, sunset, civil_twilight_begin,
 *   civil_twilight_end, day_length}`, or null on a polar day/night
 */
function sunTimesFor(date, lat, lon) {
  const [y, m, d] = String(date).split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const jdn = julianDayNumber(y, m, d);

  const day = crossings(jdn, lat, lon, ZENITH_SUNRISE);
  if (!day) return null;
  const civil = crossings(jdn, lat, lon, ZENITH_CIVIL);

  return {
    sunrise: day.rise.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    sunset: day.set.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    civil_twilight_begin: civil ? civil.rise.toISOString().replace(/\.\d{3}Z$/, "+00:00") : null,
    civil_twilight_end: civil ? civil.set.toISOString().replace(/\.\d{3}Z$/, "+00:00") : null,
    day_length: Math.round((day.set.getTime() - day.rise.getTime()) / 1000),
  };
}

/**
 * The calendar date one day after `date`.
 *
 * @param {string} date `YYYY-MM-DD`
 * @returns {string} the next day, `YYYY-MM-DD`
 */
function nextDate(date) {
  const t = new Date(`${date}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

module.exports = { sunTimesFor, nextDate, julianDayNumber };
