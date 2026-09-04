import React, { useContext, useEffect, useRef, useState } from "react";
import { UiPrefsContext, AppActionsContext } from "~/AppContext";
import AppDrawer from "~/components/ambient/AppDrawer";
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
  const { darkMode, defaultMapZoom, mouseHide, railHidden } = useContext(UiPrefsContext);
  const { setMobileRadarMaximized } = useContext(AppActionsContext);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setMobileRadarMaximized(true);
    return () => setMobileRadarMaximized(null);
  }, [setMobileRadarMaximized]);

  // Left-edge swipe opens the labelled drawer.
  //
  // Bound on the layout rather than on a dedicated edge strip: a strip wide
  // enough to catch a thumb would also sit over the rail's buttons and eat
  // their taps. Starting inside EDGE_PX of the left edge is the whole gate —
  // that region is the rail when it is showing and the map when it is not,
  // and neither reads a horizontal drag from the very edge as its own
  // gesture. Listeners are passive: this never cancels the map's panning,
  // it only notices.
  const swipeRef = useRef({ x: 0, y: 0, armed: false });
  // Set when a swipe has just opened the drawer, so the click the browser
  // synthesises afterwards can be swallowed. Without it the gesture ALSO
  // presses whatever rail button it started on — the edge region is the rail
  // when the rail is showing, and a swipe that began over Refresh reloaded
  // the app instead of opening the drawer.
  const swipeConsumedRef = useRef(false);
  const EDGE_PX = 28;
  const OPEN_PX = 70;

  const onTouchStart = (e) => {
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY, armed: t.clientX <= EDGE_PX };
  };
  const onTouchEnd = (e) => {
    const st = swipeRef.current;
    swipeRef.current = { x: 0, y: 0, armed: false };
    if (!st.armed || drawerOpen) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - st.x;
    const dy = t.clientY - st.y;
    // Rightward and mostly horizontal, so a vertical scrub down the rail or a
    // diagonal map pan does not spring the drawer open.
    if (dx > OPEN_PX && Math.abs(dx) > Math.abs(dy)) {
      swipeConsumedRef.current = true;
      setDrawerOpen(true);
    }
  };
  // Capture phase, so the click is stopped before it reaches the button.
  const onClickCapture = (e) => {
    if (!swipeConsumedRef.current) return;
    swipeConsumedRef.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div
      className={`${styles.layout} ${railHidden ? styles.railHidden : ""}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onClickCapture={onClickCapture}
    >
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
      {/* Before the dock, deliberately: `.layout > :last-child` carries the
        * dock's stacking-context and hidden-rail rules, and a drawer rendered
        * after it would inherit both — `position: relative; z-index: 1100`
        * would override the drawer's own fixed positioning and drop it below
        * the map's overlays. The drawer is `position: fixed`, so its DOM
        * order costs it nothing. */}
      <AppDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <BottomDock />
    </div>
  );
};

export default LayoutMobile;
