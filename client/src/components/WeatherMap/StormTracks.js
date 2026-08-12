import React, { useMemo } from "react";
import PropTypes from "prop-types";
import { Polyline, CircleMarker, Tooltip } from "react-leaflet";

/**
 * Storm-track overlay — SCIT cells drawn in the RadarScope convention:
 * a SOLID line from a filled dot at the current position, with short
 * PERPENDICULAR tick marks at each forecast interval (15/30/45/60 min)
 * and a longer tick capping the far end. The ticks are the time axis —
 * "storm reaches the second tick in 30 minutes" — and direction is
 * carried by the line extending away from the dot, so no arrowhead is
 * needed.
 *
 * DIRECTION COMES FROM THE PATH, NEVER FROM THE MOVEMENT FIELD. The
 * product's MOVEMENT column is the direction a storm comes FROM, so
 * deriving a heading from it points every track backwards (verified
 * against live product data — see server/stormTracksCtrl.js). Tick
 * orientation is computed from the segment each forecast point sits on.
 *
 * A newly detected cell reports `NEW` with no forecast positions. Its
 * track is a single point, so it draws as a hollow dot with no line —
 * the honest rendering, since SCIT genuinely doesn't know where it's
 * going yet.
 */

// Tick geometry in degrees of latitude: half-length of the regular
// interval ticks and of the longer end cap. Constant geographic size —
// at the zooms where tracks are readable this holds the RadarScope
// look without per-zoom recomputation.
const TICK_HALF_DEG = 0.028;
const ENDCAP_HALF_DEG = 0.048;

/**
 * Bearing from one lat/lon to another, degrees clockwise from north.
 *
 * @param {{lat: Number, lon: Number}} a start
 * @param {{lat: Number, lon: Number}} b end
 * @returns {Number} bearing in degrees
 */
function bearing(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const dLon = r(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(r(b.lat));
  const x = Math.cos(r(a.lat)) * Math.sin(r(b.lat))
    - Math.sin(r(a.lat)) * Math.cos(r(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Build one perpendicular tick segment centred on a point.
 *
 * Longitude is scaled by 1/cos(lat) so ticks stay visually symmetric on
 * a Web Mercator map instead of squashing as they move north.
 *
 * @param {{lat: Number, lon: Number}} at tick centre
 * @param {Number} travelBearing track direction at that point
 * @param {Number} halfDeg tick half-length in degrees of latitude
 * @returns {Array<Array<Number>>} two-point leaflet position array
 */
function tickSegment(at, travelBearing, halfDeg) {
  const cosLat = Math.max(0.2, Math.cos((at.lat * Math.PI) / 180));
  const perp = ((travelBearing + 90) * Math.PI) / 180;
  const dLat = halfDeg * Math.cos(perp);
  const dLon = (halfDeg * Math.sin(perp)) / cosLat;
  return [
    [at.lat + dLat, at.lon + dLon],
    [at.lat - dLat, at.lon - dLon],
  ];
}

/**
 * @param {object} props
 * @param {Array<object>} props.cells storm cells from /api/storm-tracks
 * @param {Boolean} [props.dark] dark palette active
 * @param {Boolean} [props.nightRed] night-vision palette active
 * @returns {JSX.Element|null} overlay layers, or null when there are no cells
 */
const StormTracks = ({ cells, dark = false, nightRed = false }) => {
  // RadarScope draws tracks in plain white on its dark basemap. White
  // needs a dark counterpart in light mode; nightRed collapses to the
  // red family like the rest of the map chrome.
  const color = nightRed ? "#e85858" : (dark ? "#ffffff" : "#1a1a1a");
  const stroke = { color, weight: 2, opacity: 0.95, lineCap: "round" };

  const layers = useMemo(() => (cells || [])
    .filter((c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => {
      const track = Array.isArray(c.track) ? c.track : [];
      const path = track.map((p) => [p.lat, p.lon]);
      // One tick per FORECAST point (track[0] is the current position —
      // the dot lives there, not a tick). Orientation follows the
      // segment arriving at each point; the final tick is the end cap.
      const ticks = [];
      for (let i = 1; i < track.length; i += 1) {
        const brg = bearing(track[i - 1], track[i]);
        const isLast = i === track.length - 1;
        ticks.push(tickSegment(track[i], brg, isLast ? ENDCAP_HALF_DEG : TICK_HALF_DEG));
      }
      return { cell: c, path, ticks };
    }), [cells]);

  if (!layers.length) return null;

  return (
    <>
      {layers.map(({ cell, path, ticks }) => (
        <React.Fragment key={`sti-${cell.id}-${cell.lat.toFixed(3)}`}>
          {path.length > 1 ? (
            <Polyline positions={path} pathOptions={stroke} />
          ) : null}
          {ticks.map((seg, i) => (
            <Polyline key={`tick-${i}`} positions={seg} pathOptions={stroke} />
          ))}
          <CircleMarker
            center={[cell.lat, cell.lon]}
            radius={5}
            pathOptions={{
              ...stroke,
              fillColor: color,
              weight: 2,
              // A NEW cell is hollow: SCIT has detected it but has no
              // motion for it yet, and a filled dot would imply the same
              // confidence as a tracked cell.
              fillOpacity: cell.isNew ? 0 : 1,
            }}
          >
            <Tooltip direction="top" offset={[0, -6]} opacity={0.95}>
              {cell.id}
              {cell.speedKt != null ? ` · ${cell.speedKt} kt` : " · new"}
            </Tooltip>
          </CircleMarker>
        </React.Fragment>
      ))}
    </>
  );
};

StormTracks.propTypes = {
  // eslint-disable-next-line react/forbid-prop-types -- payload-shaped, not statically typed
  cells: PropTypes.array,
  dark: PropTypes.bool,
  nightRed: PropTypes.bool,
};

export default StormTracks;
