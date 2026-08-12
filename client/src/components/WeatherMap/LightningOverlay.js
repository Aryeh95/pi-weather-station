import React, { useMemo, useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Marker } from "react-leaflet";
import L from "leaflet";
import styles from "./styles.css";

/**
 * GLM lightning overlay — age-faded bolt markers.
 *
 * The design intent is a single glance-readable signal: an actively
 * electrified storm is a dense bright cluster of bolts; a decaying one
 * visibly fades out over the 5-minute window. Recency is encoded twice
 * (colour steps down AND opacity steps down) so the fade survives both
 * palettes and colour-vision differences.
 *
 * Markers are `divIcon`s carrying one small inline-SVG bolt. Only FOUR
 * icon instances exist per palette (one per age tier) and every marker
 * shares them — Leaflet clones the html per marker, but the objects and
 * their computed style stay identical, which keeps 800 markers cheap.
 * `interactive: false` keeps them out of the hit-test path so map taps
 * (alert popups, pan) behave exactly as before.
 *
 * GLM's pixel is ~8-14 km, so the glyphs stay small — this is "storm is
 * electrified", not a strike locator.
 *
 * Ages arrive as seconds-at-fetch; a 30 s ticker adds the elapsed time
 * since, so markers keep aging between the one-minute polls instead of
 * jumping a minute at a time.
 */

// Render cap: an active outbreak puts thousands of flashes in radius
// (1,679 measured over Kentucky during a live severe evening). The
// NEWEST flashes win — they're the signal; a capped tail of old ones is
// invisible fade anyway. 800 lightweight non-interactive divIcons is
// comfortable on the kiosk.
const MAX_RENDERED = 800;

// Classic bolt silhouette in a 12 × 16 box, anchored at its centre.
const BOLT_PATH = "M7.5 0 L1 9.5 H5 L3.5 16 L11 6 H6.5 L9.5 0 Z";

// Age tiers, seconds → visual, spanning the 5-minute window. Bright
// white-hot for the freshest minute, then amber fading out to the edge.
const TIERS = [
  { maxAge: 60, opacity: 1.0, size: 15, fresh: true },
  { maxAge: 150, opacity: 0.7, size: 12, fresh: false },
  { maxAge: 240, opacity: 0.4, size: 11, fresh: false },
  { maxAge: Infinity, opacity: 0.25, size: 10, fresh: false },
];

/**
 * Build the four shared per-tier divIcons for a palette.
 *
 * @param {Boolean} dark dark palette active
 * @param {Boolean} nightRed night-vision palette active
 * @returns {Array<import("leaflet").DivIcon>} one icon per TIERS entry
 */
function buildTierIcons(dark, nightRed) {
  const freshColor = nightRed ? "#ff9090" : (dark ? "#ffffff" : "#8a6d00");
  const agedColor = nightRed ? "#e85858" : (dark ? "#ffe066" : "#b58900");
  return TIERS.map((t) => {
    const w = Math.round((t.size * 12) / 16);
    const color = t.fresh ? freshColor : agedColor;
    return L.divIcon({
      // Clears Leaflet's default .leaflet-div-icon chrome (white box +
      // border) — see the flashIcon rule in styles.css.
      className: styles.flashIcon,
      // Thin dark outline, RadarScope-style — it is what keeps a yellow
      // bolt legible when it lands on yellow-orange reflectivity.
      html: `<svg width="${w}" height="${t.size}" viewBox="-1 -1 14 18">`
        + `<path d="${BOLT_PATH}" fill="${color}" fill-opacity="${t.opacity}"`
        + ` stroke="#1a1a1a" stroke-opacity="${Math.min(1, t.opacity + 0.1)}" stroke-width="0.9"/></svg>`,
      iconSize: [w, t.size],
      iconAnchor: [w / 2, t.size / 2],
    });
  });
}

/**
 * @param {object} props
 * @param {Array<Array<Number>>} props.flashes [lat, lon, ageSeconds] triples
 * @param {Number} [props.fetchedAt] epoch ms the flash list was fetched
 * @param {Boolean} [props.dark] dark palette active
 * @param {Boolean} [props.nightRed] night-vision palette active
 * @returns {JSX.Element|null} bolt markers, or null when there are none
 */
const LightningOverlay = ({ flashes, fetchedAt, dark = false, nightRed = false }) => {
  // Re-render every 30 s so ages keep advancing between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  const icons = useMemo(() => buildTierIcons(dark, nightRed), [dark, nightRed]);

  const markers = useMemo(() => {
    const elapsed = fetchedAt ? Math.round((now - fetchedAt) / 1000) : 0;
    return (flashes || [])
      .map(([lat, lon, age]) => ({ lat, lon, ageSec: age + elapsed }))
      .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && f.ageSec < 5 * 60)
      .sort((a, b) => a.ageSec - b.ageSec)
      .slice(0, MAX_RENDERED)
      .map((f) => ({ ...f, tier: TIERS.findIndex((t) => f.ageSec < t.maxAge) }));
  }, [flashes, fetchedAt, now]);

  if (!markers.length) return null;

  return (
    <>
      {markers.map((f, i) => (
        <Marker
          key={`fl-${i}`}
          position={[f.lat, f.lon]}
          icon={icons[f.tier === -1 ? TIERS.length - 1 : f.tier]}
          interactive={false}
          keyboard={false}
        />
      ))}
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
