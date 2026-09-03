import React, { useMemo } from "react";
import PropTypes from "prop-types";
import { Polyline, CircleMarker, Marker, Tooltip } from "react-leaflet";
import L from "leaflet";
import { useTranslation } from "react-i18next";
import styles from "./styles.css";
import { estimateArrival } from "./stormArrival";

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
 *
 * MESOCYCLONE / TVS markers (NMD product, same payload) render as the
 * RadarScope-style cell attributes: a white disc with a ring ("⊙") for
 * a mesocyclone, and a tornado-funnel glyph when the circulation's TVS
 * flag is set. The dedicated TVS product stopped being archived in the
 * bucket after 2021, so the flag comes from the NMD table — see
 * server/stormTracksCtrl.js.
 *
 * ARRIVAL LABELS: when `home` is given, every cell whose forecast motion
 * carries it within ~20 km of that point gets a permanent "≈ N min"
 * label — the answer to the kiosk's actual question, "is that coming
 * here, and when". Geometry in stormArrival.js.
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
 * Build the shared meso / TVS divIcons for a palette. Two instances
 * total, reused by every marker.
 *
 * @param {Boolean} nightRed night-vision palette active
 * @returns {{meso: import("leaflet").DivIcon, tvs: import("leaflet").DivIcon}} icon pair
 */
function buildAttrIcons(nightRed) {
  const disc = nightRed ? "#2a0f0f" : "#ffffff";
  const glyph = nightRed ? "#e85858" : "#1a1a1a";
  const mesoHtml = `<svg width="18" height="18" viewBox="0 0 18 18">`
    + `<circle cx="9" cy="9" r="8" fill="${disc}" stroke="${glyph}" stroke-width="1.6"/>`
    + `<circle cx="9" cy="9" r="3" fill="none" stroke="${glyph}" stroke-width="1.6"/>`
    + `</svg>`;
  const tvsHtml = `<svg width="20" height="20" viewBox="0 0 20 20">`
    + `<circle cx="10" cy="10" r="9" fill="${disc}" stroke="${glyph}" stroke-width="1.6"/>`
    + `<path d="M5.5 5.5 H14.5 L11 11 L10.4 15 L9.6 11 Z" fill="${glyph}"/>`
    + `</svg>`;
  const mk = (html, size) => L.divIcon({
    className: styles.flashIcon,
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  return { meso: mk(mesoHtml, 18), tvs: mk(tvsHtml, 20) };
}

/**
 * @param {object} props
 * @param {Array<object>} props.cells storm cells from /api/storm-tracks
 * @param {Array<object>} [props.mesos] mesocyclone features from the same payload
 * @param {{lat: Number, lon: Number}} [props.home] point to estimate arrival times for
 * @param {Boolean} [props.dark] dark palette active
 * @param {Boolean} [props.nightRed] night-vision palette active
 * @returns {JSX.Element|null} overlay layers, or null when there are no cells
 */
const StormTracks = ({ cells, mesos, home = null, dark = false, nightRed = false }) => {
  const { t } = useTranslation();
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
      return { cell: c, path, ticks, arrival: estimateArrival(c, home) };
    }), [cells, home]);

  const attrIcons = useMemo(() => buildAttrIcons(nightRed), [nightRed]);
  const mesoMarkers = (mesos || [])
    .filter((m) => m && Number.isFinite(m.lat) && Number.isFinite(m.lon));

  if (!layers.length && !mesoMarkers.length) return null;

  return (
    <>
      {layers.map(({ cell, path, ticks, arrival }) => (
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
            {arrival ? (
              /* Permanent label: this cell is headed for home. Minutes
                 to closest approach, plus the miss distance on hover. */
              <Tooltip
                direction="right"
                offset={[8, 0]}
                opacity={0.95}
                permanent
                className={styles.arrivalLabel}
              >
                {cell.id}
                {" · "}
                {t("radar.stormArrival", { minutes: arrival.minutes })}
              </Tooltip>
            ) : (
              <Tooltip direction="top" offset={[0, -6]} opacity={0.95}>
                {cell.id}
                {cell.speedKt != null ? ` · ${cell.speedKt} kt` : " · new"}
              </Tooltip>
            )}
          </CircleMarker>
        </React.Fragment>
      ))}
      {/* Mesocyclone / TVS markers sit on the marker pane, above the
          track vectors — RadarScope stacks them the same way. Non-
          interactive except for the tooltip carrier: like the location
          pin, they must not eat a map tap, so the tooltip rides a
          transparent CircleMarker underneath instead. */}
      {mesoMarkers.map((m) => (
        <React.Fragment key={`meso-${m.id}-${m.lat.toFixed(3)}`}>
          <Marker
            position={[m.lat, m.lon]}
            icon={m.tvs ? attrIcons.tvs : attrIcons.meso}
            interactive={false}
            keyboard={false}
          />
          <CircleMarker
            center={[m.lat, m.lon]}
            radius={9}
            pathOptions={{ opacity: 0, fillOpacity: 0 }}
          >
            <Tooltip direction="top" offset={[0, -10]} opacity={0.95}>
              {m.tvs ? "TVS" : "MESO"}
              {m.stormId ? ` · ${m.stormId}` : ""}
              {m.strengthRank ? ` · SR ${m.strengthRank}` : ""}
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
  // eslint-disable-next-line react/forbid-prop-types -- payload-shaped, not statically typed
  mesos: PropTypes.array,
  home: PropTypes.shape({ lat: PropTypes.number, lon: PropTypes.number }),
  dark: PropTypes.bool,
  nightRed: PropTypes.bool,
};

export default StormTracks;
