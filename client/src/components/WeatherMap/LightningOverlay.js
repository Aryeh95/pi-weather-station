import React, { useMemo, useState, useEffect } from "react";
import PropTypes from "prop-types";
import { CircleMarker } from "react-leaflet";

/**
 * GLM lightning overlay — age-faded flash markers.
 *
 * The design intent is a single glance-readable signal: an actively
 * electrified storm is a dense bright cluster; a decaying one visibly
 * fades out over the 15-minute window. Recency is encoded twice (colour
 * steps down AND opacity steps down) so the fade survives both palettes
 * and colour-vision differences.
 *
 * GLM's pixel is ~8-14 km, so markers are deliberately small dots, not
 * precise strike symbols — the honest rendering of flash-extent data.
 *
 * Ages arrive as seconds-at-fetch; a 30 s ticker adds the elapsed time
 * since, so markers keep aging between the one-minute polls instead of
 * jumping a minute at a time.
 */

// Render cap: an active outbreak puts thousands of flashes in radius
// (1,679 measured over Kentucky during a live severe evening). The
// NEWEST flashes win — they're the signal; a capped tail of old ones is
// invisible fade anyway. 800 SVG dots is comfortable on the kiosk.
const MAX_RENDERED = 800;

// Age tiers, seconds → visual. Bright white-hot for the freshest two
// minutes, then amber fading out to the window edge.
function tierFor(ageSec) {
  if (ageSec < 120) return { opacity: 1.0, fresh: true };
  if (ageSec < 300) return { opacity: 0.7, fresh: false };
  if (ageSec < 600) return { opacity: 0.4, fresh: false };
  return { opacity: 0.2, fresh: false };
}

/**
 * @param {object} props
 * @param {Array<Array<Number>>} props.flashes [lat, lon, ageSeconds] triples
 * @param {Number} [props.fetchedAt] epoch ms the flash list was fetched
 * @param {Boolean} [props.dark] dark palette active
 * @param {Boolean} [props.nightRed] night-vision palette active
 * @returns {JSX.Element|null} flash markers, or null when there are none
 */
const LightningOverlay = ({ flashes, fetchedAt, dark = false, nightRed = false }) => {
  // Re-render every 30 s so ages keep advancing between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  const freshColor = nightRed ? "#ff9090" : (dark ? "#ffffff" : "#8a6d00");
  const agedColor = nightRed ? "#e85858" : (dark ? "#ffe066" : "#b58900");

  const markers = useMemo(() => {
    const elapsed = fetchedAt ? Math.round((now - fetchedAt) / 1000) : 0;
    return (flashes || [])
      .map(([lat, lon, age]) => ({ lat, lon, ageSec: age + elapsed }))
      .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && f.ageSec < 15 * 60)
      .sort((a, b) => a.ageSec - b.ageSec)
      .slice(0, MAX_RENDERED);
  }, [flashes, fetchedAt, now]);

  if (!markers.length) return null;

  return (
    <>
      {markers.map((f, i) => {
        const t = tierFor(f.ageSec);
        const color = t.fresh ? freshColor : agedColor;
        return (
          <CircleMarker
            key={`fl-${i}`}
            center={[f.lat, f.lon]}
            radius={t.fresh ? 3 : 2}
            pathOptions={{
              color,
              fillColor: color,
              weight: 1,
              opacity: t.opacity,
              fillOpacity: t.opacity,
            }}
          />
        );
      })}
    </>
  );
};

LightningOverlay.propTypes = {
  // eslint-disable-next-line react/forbid-prop-types -- payload-shaped [lat, lon, ageSec] triples
  flashes: PropTypes.array,
  fetchedAt: PropTypes.number,
  dark: PropTypes.bool,
  nightRed: PropTypes.bool,
};

export default LightningOverlay;
