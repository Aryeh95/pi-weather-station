// Tests for `server/solar.js`, the local sunrise/sunset calculation that
// replaced the api.sunrise-sunset.org call.
//
// The reference values below are the US Naval Observatory's, fetched from
// `https://aa.usno.navy.mil/api/rstt/oneday?date=&coords=&tz=0` on
// 2026-09-04. USNO is the authority these APIs are themselves checked
// against, and it answers in UT at whole-minute resolution, which is why
// the tolerances here are in minutes.
//
// (api.sunrise-sunset.org itself was returning HTTP 521 while this was
// written, which is a fair illustration of why the calculation moved
// in-process.)
//
// Measured agreement across the 8 places x 5 dates that were compared:
// worst |delta| was 2.00 min below 62 deg N and 3.33 min at Utqiagvik
// (71.3 deg N). That split is expected, not slack in the port: the NOAA
// approximation anchors the sun's position at 00:00 UT and does not
// iterate, so the error grows with how slowly the sun crosses the
// horizon. The tolerances below are set just above the measured worst
// case for each band so a real regression fails while the known
// approximation error does not.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { sunTimesFor, nextDate, julianDayNumber } = require("../server/solar");

// [place, lat, lon, date, USNO sunrise (UT), USNO sunset (UT)]
// A sunset time earlier than its sunrise is the next UT day - every place
// here is west of Greenwich, so late sunsets cross 00:00 UT.
const USNO = [
  ["Philadelphia", 39.9526, -75.1652, "2026-01-15", "12:20", "22:00"],
  ["Philadelphia", 39.9526, -75.1652, "2026-03-20", "11:04", "23:13"],
  ["Philadelphia", 39.9526, -75.1652, "2026-06-21", "09:32", "00:33"],
  ["Philadelphia", 39.9526, -75.1652, "2026-09-04", "10:31", "23:27"],
  ["Philadelphia", 39.9526, -75.1652, "2026-12-21", "12:19", "21:39"],
  ["Sterling VA", 38.976, -77.4875, "2026-01-15", "12:27", "22:12"],
  ["Sterling VA", 38.976, -77.4875, "2026-06-21", "09:45", "00:39"],
  ["Sterling VA", 38.976, -77.4875, "2026-12-21", "12:25", "21:51"],
  ["Miami", 25.7617, -80.1918, "2026-01-15", "12:09", "22:52"],
  ["Miami", 25.7617, -80.1918, "2026-06-21", "10:30", "00:15"],
  ["Miami", 25.7617, -80.1918, "2026-12-21", "12:03", "22:35"],
  ["Seattle", 47.6062, -122.3321, "2026-01-15", "15:53", "00:44"],
  ["Seattle", 47.6062, -122.3321, "2026-06-21", "12:12", "04:11"],
  ["Seattle", 47.6062, -122.3321, "2026-12-21", "15:55", "00:20"],
  ["Denver", 39.7392, -104.9903, "2026-03-20", "13:03", "01:11"],
  ["Denver", 39.7392, -104.9903, "2026-09-04", "12:31", "01:28"],
  ["Honolulu", 21.3069, -157.8583, "2026-03-20", "16:35", "04:42"],
  ["Honolulu", 21.3069, -157.8583, "2026-09-04", "16:16", "04:45"],
  ["Anchorage", 61.2181, -149.9003, "2026-03-20", "16:00", "04:13"],
  ["Anchorage", 61.2181, -149.9003, "2026-06-21", "12:20", "07:42"],
  ["Anchorage", 61.2181, -149.9003, "2026-12-21", "19:14", "00:41"],
  ["Utqiagvik AK", 71.2906, -156.7886, "2026-03-20", "16:24", "04:43"],
  ["Utqiagvik AK", 71.2906, -156.7886, "2026-09-04", "14:50", "06:05"],
];

const TOLERANCE_MIN = 2.5;
const TOLERANCE_MIN_HIGH_LAT = 4;

/** Minutes past 00:00 UTC on `date` for an ISO instant from sunTimesFor. */
function minutesPastMidnight(iso, date) {
  const base = Date.parse(`${date}T00:00:00Z`);
  return (Date.parse(iso.replace("+00:00", "Z")) - base) / 60000;
}

/** Minutes past 00:00 UT for a USNO `HH:MM`. */
function usnoMinutes(hhmm) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Difference in minutes, tolerant of a crossing that lands the next UT day. */
function deltaMinutes(ours, reference) {
  const d = Math.abs(ours - reference);
  return Math.min(d, Math.abs(d - 1440));
}

test("sunrise and sunset match the US Naval Observatory", () => {
  for (const [place, lat, lon, date, refRise, refSet] of USNO) {
    const got = sunTimesFor(date, lat, lon);
    assert.ok(got, `${place} ${date}: expected a crossing`);

    const tolerance = Math.abs(lat) >= 62 ? TOLERANCE_MIN_HIGH_LAT : TOLERANCE_MIN;
    for (const [what, iso, ref] of [
      ["sunrise", got.sunrise, refRise],
      ["sunset", got.sunset, refSet],
    ]) {
      const delta = deltaMinutes(minutesPastMidnight(iso, date), usnoMinutes(ref));
      assert.ok(
        delta <= tolerance,
        `${place} ${date} ${what}: ${iso} vs USNO ${ref} UT — off by ${delta.toFixed(2)} min (tolerance ${tolerance})`
      );
    }
  }
});

test("polar night and polar day report no crossing", () => {
  // Utqiagvik, Alaska. USNO lists no sunrise and no sunset on any of these
  // dates; the caller needs a null, not a fabricated time, so that the
  // kiosk's auto dark-mode leaves the palette where it is.
  for (const date of ["2026-01-15", "2026-06-21", "2026-12-21"]) {
    assert.equal(sunTimesFor(date, 71.2906, -156.7886), null, date);
  }
});

test("the payload keeps the shape the client already reads", () => {
  const got = sunTimesFor("2026-09-04", 39.9526, -75.1652);
  assert.deepEqual(Object.keys(got).sort(), [
    "civil_twilight_begin",
    "civil_twilight_end",
    "day_length",
    "sunrise",
    "sunset",
  ]);

  // The client stores this payload as-is and parses the timestamps with
  // `new Date(...)`, so the offset suffix has to survive.
  for (const key of ["sunrise", "sunset", "civil_twilight_begin", "civil_twilight_end"]) {
    assert.match(got[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/, key);
  }

  assert.equal(
    got.day_length,
    Math.round((Date.parse(got.sunset) - Date.parse(got.sunrise)) / 1000)
  );
});

test("civil twilight brackets the day", () => {
  const got = sunTimesFor("2026-09-04", 39.9526, -75.1652);
  assert.ok(Date.parse(got.civil_twilight_begin) < Date.parse(got.sunrise));
  assert.ok(Date.parse(got.civil_twilight_end) > Date.parse(got.sunset));
  // Roughly half an hour of usable light either side at this latitude.
  const dawn = (Date.parse(got.sunrise) - Date.parse(got.civil_twilight_begin)) / 60000;
  assert.ok(dawn > 20 && dawn < 45, `dawn was ${dawn.toFixed(1)} min`);
});

test("the equinox is about twelve hours long everywhere", () => {
  // Refraction and the sun's apparent radius make the equinox slightly
  // longer than 12 h, by more the further from the equator.
  for (const [lat, lon] of [[0, 0], [25.76, -80.19], [39.95, -75.17], [47.61, -122.33]]) {
    const hours = sunTimesFor("2026-03-20", lat, lon).day_length / 3600;
    assert.ok(hours > 12 && hours < 12.35, `lat ${lat}: ${hours.toFixed(3)} h`);
  }
});

test("a malformed date is a null, not a NaN timestamp", () => {
  assert.equal(sunTimesFor("not-a-date", 39.9526, -75.1652), null);
  assert.equal(sunTimesFor("", 39.9526, -75.1652), null);
});

test("nextDate steps over month and year boundaries", () => {
  assert.equal(nextDate("2026-09-04"), "2026-09-05");
  assert.equal(nextDate("2026-09-30"), "2026-10-01");
  assert.equal(nextDate("2026-12-31"), "2027-01-01");
  // A leap year, and the day after the leap day.
  assert.equal(nextDate("2028-02-28"), "2028-02-29");
  assert.equal(nextDate("2028-02-29"), "2028-03-01");
  // Anchored at noon UTC so a local-time DST shift cannot move the day.
  assert.equal(nextDate("2026-03-08"), "2026-03-09");
});

test("julianDayNumber matches its published epochs", () => {
  assert.equal(julianDayNumber(2000, 1, 1), 2451545);
  assert.equal(julianDayNumber(1970, 1, 1), 2440588);
  assert.equal(julianDayNumber(2026, 9, 4), 2461288);
  // Consecutive days differ by exactly one, across a leap-year February.
  assert.equal(julianDayNumber(2028, 3, 1) - julianDayNumber(2028, 2, 29), 1);
});
