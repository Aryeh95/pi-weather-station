import React, { useContext, useEffect } from "react";
import { UiPrefsContext, AppActionsContext } from "~/AppContext";
import WeatherMap from "~/components/WeatherMap";
import RadarHeader from "~/components/ambient/RadarHeader";
import AlertBanner from "~/components/ambient/AlertBanner";
import AlertDetailInline from "~/components/ambient/AlertDetailInline";
import AlertMiniCards from "~/components/ambient/AlertMiniCards";
import BottomDock from "~/components/ambient/BottomDock";
import styles from "./styles.css";

/**
 * Mobile layout (< 800 px wide): the radar, full-bleed, with the same
 * chrome the kiosk has — nothing else.
 *
 * Until 2026-09-03 this was the forecast-era "companion" column: a tall
 * clock card, a 220 px radar thumbnail with a maximize button, a footer
 * telling the user to open the app on the Pi, and a pull-to-refresh
 * gesture — with the map's own controls hidden until the thumbnail was
 * expanded and half the dock's toggles hidden in portrait. Once the
 * forecast panels went, that column was three quarters empty and the
 * radar was the one thing on the page you could not use.
 *
 * Structure now (everything overlays the map; nothing scrolls):
 *
 *   ┌──────────────────────────────┐
 *   │ [place · clock]        strip │  ◀ RadarHeader `strip` variant
 *   │ [LWX ● 3 min  Tracks ● …]    │  ◀ RadarFrameAge, laid out as a row
 *   │ AlertBanner / detail / cards │  ◀ overlay column, scrolls if long
 *   │                              │
 *   │            map               │
 *   │                              │
 *   │ [timeline]        [legend]   │  ◀ WeatherMap's own overlays
 *   ├──────────────────────────────┤
 *   │ BottomDock (wraps to 2 rows) │
 *   └──────────────────────────────┘
 *
 * - `mobileRadarMaximized` is held at `true` for the lifetime of the
 *   layout (and reset to `null` on unmount). ControlButtons and
 *   MapResizer key on that flag; `true` means "the radar overlays are
 *   visible, every dock toggle is live" — which is now always the case.
 * - Leaflet's +/− zoom stack is hidden here (pinch-zoom on a phone);
 *   see the mobile rules in WeatherMap/styles.css.
 * - The dock no longer hides its "secondary" toggles in portrait; it
 *   wraps onto a second row instead (BottomDock / ControlButtons CSS).
 * - Pull-to-refresh is gone: the map owns every touch gesture, and the
 *   dock's refresh button does the same job.
 *
 * @returns {JSX.Element} Mobile layout
 */
const LayoutMobile = () => {
  const { darkMode, defaultMapZoom, mouseHide } = useContext(UiPrefsContext);
  const { setMobileRadarMaximized } = useContext(AppActionsContext);

  useEffect(() => {
    setMobileRadarMaximized(true);
    return () => setMobileRadarMaximized(null);
  }, [setMobileRadarMaximized]);

  return (
    <div className={styles.layout}>
      <div className={styles.stage}>
        <div className={`${styles.mapArea} map-container ${darkMode ? "map-dark-mode" : ""} ${mouseHide ? "map-mouse-hide" : ""}`}>
          <WeatherMap zoom={defaultMapZoom} dark={darkMode} />
        </div>
        {/* No `data-ambient-hero` here: WeatherMap's useRailOffset would
          * shift the map centre down by the header height, which only
          * makes sense for the desktop's tall slab. The strip is 40 px. */}
        <div className={styles.headerSlot}>
          <RadarHeader strip />
        </div>
        {/* Alert stack overlays the map below the header and frame-age
          * strip. Every child returns null with no active alert, so on a
          * calm day this slot is an empty, click-through box. */}
        <div className={styles.alertSlot}>
          <AlertBanner />
          <AlertDetailInline />
          <AlertMiniCards />
        </div>
      </div>
      <BottomDock />
    </div>
  );
};

export default LayoutMobile;
