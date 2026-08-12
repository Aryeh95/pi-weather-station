import React, { useMemo } from "react";
import PropTypes from "prop-types";
import { Polyline, CircleMarker, Tooltip } from "react-leaflet";

/**
 * Storm-track overlay — SCIT cells with their forecast paths.
 *
 * Each cell renders as:
 *   · a filled dot at the current position
 *   · a dashed polyline through the 15/30/45/60-minute forecast positions
 *   · an arrowhead at the far end
 *   · a label with the cell id and speed
 *
 * DIRECTION COMES FROM THE PATH, NEVER FROM THE MOVEMENT FIELD. The
 * product's MOVEMENT column is the direction a storm comes FROM, so
 * deriving a heading from it points every arrow backwards (verified
 * against live product data — see server/stormTracksCtrl.js). The
 * forecast positions are plain coordinates with no such ambiguity, so the
 * arrowhead is computed from the last two points of the track itself.
 *
 * A newly detected cell reports `NEW` with no forecast positions. Its
 * track is a single point, so it draws as a dot with no line and no
 * arrow — the honest rendering, since SCIT genuinely doesn't know where
 * it's going yet.
 */

// Arrowhead geometry, in degrees of latitude at the head. Small enough to
// read as a glyph rather than as part of the track.
const ARROW_LEN_DEG = 0.055;
const ARROW_SPREAD_DEG = 32;

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
 * Build the two short segments forming an arrowhead at `head`, opening
 * back along `brg`.
 *
 * Longitude is scaled by 1/cos(lat) so the glyph stays symmetric on a Web
 * Mercator map instead of squashing as it moves north.
 *
 * @param {{lat: Number, lon: Number}} head arrow tip
 * @param {Number} brg travel bearing at the tip
 * @returns {Array<Array<Array<Number>>>} two leaflet position arrays
 */
function arrowHead(head, brg) {
  const cosLat = Math.max(0.2, Math.cos((head.lat * Math.PI) / 180));
  const leg = (offsetDeg) => {
    const a = ((brg + 180 + offsetDeg) * Math.PI) / 180;
    return [
      head.lat + ARROW_LEN_DEG * Math.cos(a),
      head.lon + (ARROW_LEN_DEG * Math.sin(a)) / cosLat,
    ];
  };
  const tip = [head.lat, head.lon];
  return [[tip, leg(-ARROW_SPREAD_DEG)], [tip, leg(ARROW_SPREAD_DEG)]];
}

/**
 * @param {object} props
 * @param {Array<object>} props.cells storm cells from /api/storm-tracks
 * @param {Boolean} [props.dark] dark palette active
 * @param {Boolean} [props.nightRed] night-vision palette active
 * @returns {JSX.Element|null} overlay layers, or null when there are no cells
 */
const StormTracks = ({ cells, dark = false, nightRed = false }) => {
  // A cool, high-contrast line that reads against reflectivity without
  // colliding with the alert tiers (red / orange / yellow) or the radar
  // palette. nightRed collapses to the red family like the rest of the
  // map chrome.
  const color = nightRed ? "#e85858" : (dark ? "#7fd4ff" : "#0b5f8a");

  const layers = useMemo(() => (cells || [])
    .filter((c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => {
      const track = Array.isArray(c.track) ? c.track : [];
      const path = track.map((p) => [p.lat, p.lon]);
      const head = track.length > 1 ? track[track.length - 1] : null;
      const brg = head ? bearing(track[track.length - 2], head) : null;
      return { cell: c, path, head, brg };
    }), [cells]);

  if (!layers.length) return null;

  return (
    <>
      {layers.map(({ cell, path, head, brg }) => (
        <React.Fragment key={`sti-${cell.id}-${cell.lat.toFixed(3)}`}>
          {path.length > 1 ? (
            <Polyline
              positions={path}
              pathOptions={{
                color,
                weight: 2,
                opacity: 0.9,
                dashArray: "6 4",
                lineCap: "round",
              }}
            />
          ) : null}
          {head && brg != null
            ? arrowHead(head, brg).map((seg, i) => (
              <Polyline
                key={`head-${i}`}
                positions={seg}
                pathOptions={{ color, weight: 2, opacity: 0.9, lineCap: "round" }}
              />
            ))
            : null}
          <CircleMarker
            center={[cell.lat, cell.lon]}
            radius={5}
            pathOptions={{
              color,
              fillColor: color,
              weight: 2,
              opacity: 1,
              // A NEW cell is hollow: SCIT has detected it but has no
              // motion for it yet, and a filled dot would imply the same
              // confidence as a tracked cell.
              fillOpacity: cell.isNew ? 0 : 0.85,
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
