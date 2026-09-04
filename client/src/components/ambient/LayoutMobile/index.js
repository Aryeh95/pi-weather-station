import React, { useContext, useEffect, useState } from "react";
import { UiPrefsContext, AppActionsContext } from "~/AppContext";
import { useTranslation } from "react-i18next";
import { InlineIcon } from "@iconify/react";
import menuIcon from "@iconify/icons-carbon/menu";
import AppDrawer from "~/components/ambient/AppDrawer";
import LocateButton from "~/components/ambient/LocateButton";
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
 *   │ [≡] [place · clock]  [locate] │  ◀ RadarHeader `strip` variant,
 *   │                              │    app-shell buttons either side
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
  const { t } = useTranslation();
  const { darkMode, defaultMapZoom, mouseHide, railHidden } = useContext(UiPrefsContext);
  const { setMobileRadarMaximized } = useContext(AppActionsContext);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setMobileRadarMaximized(true);
    return () => setMobileRadarMaximized(null);
  }, [setMobileRadarMaximized]);

  return (
    <div
      className={`${styles.layout} ${railHidden ? styles.railHidden : ""}`}
    >
      <div className={styles.stage}>
        <div className={`${styles.mapArea} map-container ${darkMode ? "map-dark-mode" : ""} ${mouseHide ? "map-mouse-hide" : ""}`}>
          <WeatherMap zoom={defaultMapZoom} dark={darkMode} />
        </div>
        {/* No `data-ambient-hero` here: WeatherMap's useRailOffset would
          * shift the map centre down by the header height, which only
          * makes sense for the desktop's tall slab. The strip is 40 px. */}
        <div className={styles.headerSlot}>
          {/* Opens the labelled control drawer.
            *
            * This replaced a left-edge swipe, which could not work: under
            * gesture navigation Android owns both screen edges for the Back
            * gesture, and with the rail hidden the map runs to the edge, so
            * the swipe was swallowed before the WebView saw it. An app can
            * reserve a strip back with `setSystemGestureExclusionRects`, but
            * that is capped, invisible, and would take Back away from the
            * user — a button is the honest answer, and it is discoverable
            * with the rail hidden, which the gesture never was. */}
          {/* App shell only. In mobile WEB the dock stays along the bottom
            * where it is always visible, and `railHidden` has no styling
            * there — so the drawer's "Hide toolbar" row would be a control
            * that does nothing. */}
          {__STANDALONE__ && (
          <button
            type="button"
            className={styles.menuButton}
            onClick={() => setDrawerOpen(true)}
            aria-label={t("controls.drawerTitle", { defaultValue: "Controls" })}
            title={t("controls.drawerTitle", { defaultValue: "Controls" })}
          >
            <InlineIcon icon={menuIcon} />
          </button>
          )}
          <div className={styles.headerStrip}>
            <RadarHeader strip />
          </div>
          {/* App shell only, like the hamburger: mobile web keeps its
            * always-visible dock, whose recentre button is right there.
            * In the app the rail can be hidden and the drawer is closed by
            * default, so this is the one location control that is always on
            * screen. One fix, not a watch — the rail's button is the follow
            * toggle, and the two do not cancel each other. */}
          {__STANDALONE__ && <LocateButton />}
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
      {/* Before the dock, deliberately: `.layout > :last-child` carries the
        * dock's stacking-context and hidden-rail rules, and a drawer rendered
        * after it would inherit both — `position: relative; z-index: 1100`
        * would override the drawer's own fixed positioning and drop it below
        * the map's overlays. The drawer is `position: fixed`, so its DOM
        * order costs it nothing. */}
      {__STANDALONE__ && (
        <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      )}
      <BottomDock />
    </div>
  );
};

export default LayoutMobile;
