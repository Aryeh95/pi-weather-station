import { useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { useMap } from "react-leaflet";

import { hasVal } from "./geometry";

const COLLAPSE_INVALIDATE_LIVE_MS = 50;
const COLLAPSE_INVALIDATE_FINAL_MS = 250;
const MOBILE_INVALIDATE_FINAL_MS = 350;

/**
 * Invalidates the Leaflet map size when the surrounding layout shifts,
 * and (on LayoutMobile only) re-pans to the user's coordinates so the
 * marker stays geographically centred across the resize.
 *
 * Three layout shifts that need an invalidate:
 *
 * 1. LayoutPi radar focus toggle — `piRadarMaximized` flips on/off,
 *    rail hides/shows via grid-template-columns animating over 200 ms.
 *    Two `invalidateSize` calls bracket the transition (one at 50 ms
 *    for live feedback as the rail slides, one at 250 ms to latch the
 *    final size for pan math). Without the late call, Leaflet's
 *    internal `_size` cache keeps a mid-transition value and
 *    subsequent pans (e.g. the Reset Map button) land the marker
 *    off-centre. The Pi rail collapse path is driven by
 *    `piRadarMaximized`. v3.2 adds the MID↔MAX morph (the map
 *    shrinks to a ~190 px thumbnail and back): `piRadarMaximized` does
 *    NOT change across that (both MID and MAX read as "not focused"),
 *    so `piLayoutState` is also in the dep set to fire the invalidate
 *    on that geometry change.
 *
 * 2. LayoutDesktop radar focus toggle — `desktopRadarMaximized` flips
 *    on/off, HeroBand + rail hide/show. Reuses the same 50 + 250 ms
 *    bracket since the geometry change is comparable.
 *
 * 3. LayoutMobile mapCard maximize / minimize — `mobileRadarMaximized`
 *    flips false ↔ true. Leaflet keeps the same geographic centre
 *    across a container resize, so when the 220 px mini-card pops up
 *    to fill the scroll (and back), the marker drifted to the top
 *    edge of the new viewport on iOS. Brackets get the invalidate +
 *    a `setView` recenter back to the geometric centre.
 *
 * The mobileRadarMaximized effect is gated on `== null` (catches both
 * null and undefined): AppContext seeds the flag to `null`, LayoutMobile
 * flips it to true on mount and back to null on unmount. The
 * `=== undefined` check we used before v2.16.x didn't catch the `null`
 * sentinel, so on Pi/Desktop the effect fired on every lat/lng/zoom
 * change with a parasitic invalidate + setView during boot — the marker
 * ended up NE-offset on user-reported screens > 7".
 *
 * The same class of bug survived ON the phone until 2026-09-03: the
 * effect listed `latitude` / `longitude` / `zoom` as dependencies, and
 * on the phone layout the flag is never null, so every input change
 * re-ran the setView. A pinch-zoom is persisted as the default zoom
 * (AppContext, 2 s debounce) and comes back as the `zoom` prop, and a
 * tap that moves the pin changes the coordinates — either one snapped
 * the map back to the pin, so panning away from home was impossible
 * ("keeps bouncing back to my pin location"). The recentre is a
 * LAYOUT-CHANGE correction, so it now runs only when the flag itself
 * changes; the coordinates and zoom are read through a ref at that
 * moment, never subscribed to.
 *
 * @param {object} props
 * @param {boolean} props.mobileRadarMaximized null on non-mobile layouts
 * @param {boolean} props.desktopRadarMaximized Desktop focus-mode state
 * @param {boolean} props.piRadarMaximized LayoutPi focus-mode state (MIN ⇔ true; derived shim)
 * @param {string} props.piLayoutState LayoutPi v3.2 layout enum ("min"|"mid"|"max"|null) — re-triggers the invalidate on the mid↔max thumbnail morph
 * @param {number} props.latitude Current marker latitude
 * @param {number} props.longitude Current marker longitude
 * @param {number} props.zoom Current map zoom level
 * @returns {null} renders nothing
 */
const MapResizer = ({ mobileRadarMaximized, desktopRadarMaximized, piRadarMaximized, piLayoutState, latitude, longitude, zoom }) => {
  const map = useMap();
  useEffect(() => {
    const live = setTimeout(() => map.invalidateSize(), COLLAPSE_INVALIDATE_LIVE_MS);
    const final = setTimeout(() => map.invalidateSize(), COLLAPSE_INVALIDATE_FINAL_MS);
    return () => {
      clearTimeout(live);
      clearTimeout(final);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- desktopRadarMaximized + piRadarMaximized + piLayoutState purposely re-trigger the same handler
  }, [desktopRadarMaximized, piRadarMaximized, piLayoutState, map]);

  // Latest target for the layout-change recentre, read (not subscribed
  // to) by the effect below — see the doc block for why the coordinates
  // and zoom must NOT be dependencies.
  const targetRef = useRef({ latitude, longitude, zoom });
  targetRef.current = { latitude, longitude, zoom };

  useEffect(() => {
    if (mobileRadarMaximized == null) return undefined;
    const recenter = () => {
      map.invalidateSize();
      const { latitude: lat, longitude: lon, zoom: z } = targetRef.current;
      if (hasVal(lat) && hasVal(lon) && z) {
        map.setView([lat, lon], z, { animate: false });
      }
    };
    const live = setTimeout(recenter, COLLAPSE_INVALIDATE_LIVE_MS);
    const final = setTimeout(recenter, MOBILE_INVALIDATE_FINAL_MS);
    return () => {
      clearTimeout(live);
      clearTimeout(final);
    };
  }, [mobileRadarMaximized, map]);
  return null;
};

MapResizer.propTypes = {
  mobileRadarMaximized: PropTypes.bool,
  desktopRadarMaximized: PropTypes.bool,
  piRadarMaximized: PropTypes.bool,
  piLayoutState: PropTypes.string,
  latitude: PropTypes.number,
  longitude: PropTypes.number,
  zoom: PropTypes.number,
};

export default MapResizer;
