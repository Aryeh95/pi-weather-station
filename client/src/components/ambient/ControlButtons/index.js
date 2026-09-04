import React, { useContext, useState, useRef, useEffect, useLayoutEffect } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";
import {
  AppActionsContext,
  SystemContext,
  UiPrefsContext,
  AlertsContext,
} from "~/AppContext";
import { priorityViewsEnabled } from "~/ui/piLayout";
import { warningClass, warningPaintRank } from "~/components/WeatherMap/geometry";
import PlacesPopover from "~/components/ambient/PlacesPopover";
import styles from "./styles.css";
import { InlineIcon } from "@iconify/react";

/* All icons unified to the IBM Carbon family (v2.14.71) — pre-v2.14.71
 * the dock mixed 5 different icon sets (carbon / ic / material-symbols
 * / map) with inconsistent stroke weights and corner radii. Carbon
 * gives a single 24×24 grid with a 2-px stroke across every glyph for
 * a coherent visual rhythm in the dock. */
import centerCircleIcon from "@iconify/icons-carbon/center-circle";
import locationFilledIcon from "@iconify/icons-carbon/location-filled";
import locationOutlineIcon from "@iconify/icons-carbon/location";
import timePlotIcon from "@iconify/icons-carbon/time-plot";
import legendIcon from "@iconify/icons-carbon/legend";
import warningAltIcon from "@iconify/icons-carbon/warning-alt";
import stormTracksIcon from "@iconify/icons-carbon/hurricane";
import lightningIcon from "@iconify/icons-carbon/lightning";
import noiseFilterIcon from "@iconify/icons-carbon/filter";
/* Velocity mode: opposed horizontal arrows read as "toward / away from
 * the radar" — the one thing a base-velocity field shows. */
import velocityIcon from "@iconify/icons-carbon/arrows-horizontal";
import contrastIcon from "@iconify/icons-carbon/contrast";
import automaticIcon from "@iconify/icons-carbon/automatic";
import moonIcon from "@iconify/icons-carbon/moon";
import settingsIcon from "@iconify/icons-carbon/settings";
import bugIcon from "@iconify/icons-carbon/debug";
import upgradeIcon from "@iconify/icons-carbon/upgrade";
/* Places (favorites) opener. `bookmark` rather than the semantically
 * closer `location-star`: that one draws a map pin, and `location` /
 * `location-filled` are already the marker-visibility toggle one button
 * away in this same group — two pin glyphs side by side would read as one
 * control with two states. */
import bookmarkIcon from "@iconify/icons-carbon/bookmark";
/* Per the v3.1 synthesis design (Claude Design), the AI summary
 * toggle uses the universal 4-point-sparkle "auto-awesome" glyph
 * — the de-facto AI icon across modern UIs (Gemini, Copilot, ChatGPT).
 * Carbon's family doesn't ship a clean 4-point star equivalent
 * (`asterisk` is 6-point, `magic-wand` is a wand + sparkles, `bot`
 * was a robot face that read as "automated chatbot" rather than
 * "Claude-generated summary"). Breaking the Carbon-only convention
 * for this single icon is the right trade — the visual semantics
 * matter more than the family purity. */
/* Forecast view-open (rail-affordance redesign 2026-06-24). A vertical
 * column-chart Carbon glyph — deliberately NOT a weather glyph and NOT a
 * generic expand/⤢ (that would re-introduce the maximize ambiguity the
 * redesign removed from NowcastLine). Visually distinct from `timePlotIcon`
 * (the timeline button), so no collision in the dock set. */
import renewIcon from "@iconify/icons-carbon/renew";

// Inline color for the moon icon — the "blood moon" / lunar-eclipse
// red that's also the nightRed palette's accent. Applied as a literal
// because we want the same red regardless of the active palette so
// the icon reads as a constant "this button is about the red palette"
// signal. See ControlButtons styles + state-rendering notes below.
const MOON_COLOR = "#c44040";

// Worst-warning colour for the nearby-alerts count badge, keyed by the
// warning FAMILY (RadarScope convention) so the badge always agrees
// with the polygon colours on the map — a Severe Thunderstorm Warning
// is CAP-severe, and the old tier-keyed badge painted it red while its
// polygon was yellow. Dark ink on the yellow family (too light for
// white text); white otherwise.
const NEARBY_WARNING_BADGE = {
  tornado: { bg: "#e60000", fg: "#fff" },
  thunderstorm: { bg: "#f0d000", fg: "#2a2008" },
  flood: { bg: "#00a839", fg: "#fff" },
  snowSquall: { bg: "#c71585", fg: "#fff" },
  other: { bg: "#ee7710", fg: "#fff" },
};

// Toast auto-dismiss window. 2500 ms is long enough to read a short
// localized phrase ("Mode auto activé") on a 7" kiosk without dragging
// past the user's next intended tap.
const TOAST_TIMEOUT = 2500;

/**
 * Buttons group component.
 *
 * Rendered by the v3 `BottomDock`: the buttons are split into
 * labelled categories — Map (radar view controls), Views (full-rail
 * content views), Display (palette / mode), System (app-level
 * actions) — with hairline separators between groups. Matches the
 * Phase 1 toolbar of the v3.1 synthesis design. Group labels are
 * CSS-hidden on the 7" Pi kiosk and on mobile to save horizontal
 * room.
 *
 * Every button is wrapped in its own `<div onClick>` so the toast
 * positioning logic (which measures the tapped button's bounding
 * rect via `e.currentTarget`) works uniformly.
 *
 * @returns {JSX.Element} Control buttons
 */
const ControlButtons = ({ labelled = false }) => {
  const { t } = useTranslation();
  const {
    setDarkMode,
    saveDarkModeAuto,
    saveAdvancedSleepFlag,
    resetMapPosition,
    toggleFollowLocation,
    toggleMarker,
    toggleRadarTimelineVisible,
    toggleWeatherAlerts,
    toggleStormTracks,
    toggleLightning,
    toggleRadarNoiseFilter,
    toggleRadarVelocity,
    saveHideRadarLegend,
    toggleSettingsMenuOpen,
    toggleDebugMenuOpen,
    setUpdateModalOpen,
    setPiLayoutState,
    setPiScrubberOpen,
  } = useContext(AppActionsContext);
  const {
    sleepNightMode,
    isLocal,
    debugEnabled,
    settingsMenuOpen,
    debugMenuOpen,
    updateAvailable,
    updateModalOpen,
    mobileRadarMaximized,
    piLayoutState,
    followLocation,
  } = useContext(SystemContext);
  const {
    darkMode,
    darkModeAuto,
    markerIsVisible,
    radarTimelineVisible,
    hideRadarLegend,
    mouseHide,
  } = useContext(UiPrefsContext);
  const {
    showWeatherAlerts,
    showStormTracks,
    showLightning,
    radarNoiseFilter,
    radarVelocity,
    nearbyAlerts,
  } = useContext(AlertsContext);

  // v3.3 priority-views dock context: true only inside LayoutPi (piLayoutState
  // is set) with the opt-in flag on. Drives the IA button (opens AiView) and
  // the radar-timeline button (maximizes to MIN so the scrubber gets the full
  // radar width instead of the cramped MID half-pane).
  const inPriorityDock = priorityViewsEnabled() && piLayoutState != null;

  // Places popover — local open state, anchored to its dock button. Kept
  // here rather than in AppContext: no other component needs to know
  // whether this popover is open (the "local state first" rule).
  const placesRef = useRef(null);
  const [placesOpen, setPlacesOpen] = useState(false);

  // When LayoutMobile is active and the radar card is in mini mode,
  // the timeline scrubber and the precipitation legend are CSS-hidden
  // (the 220 px mini card doesn't have readable room for either —
  // see `LayoutMobile/styles.css`). Tapping the timeline / legend dock
  // buttons in that state would flip state without any visible effect,
  // confusing the user. Grey both buttons out and surface a short
  // toast hint when tapped — same disabled-button pattern the
  // direction-arrows button uses when `radarAnalysisEnabled` is off.
  //
  // The check uses strict `=== false` because the tri-state value is
  // `null` on Pi / Desktop layouts (where the timeline + legend are
  // always visible over the full-bleed map) — we only want to disable
  // when actively on mobile mini.
  const radarOverlaysDisabled = mobileRadarMaximized === false;

  // Nearby-alerts count badge — number in the radius, coloured to the
  // highest-ranked warning family present (tornado > thunderstorm >
  // flood > other), matching the map polygons. Feeds the badge only;
  // never the trigger path.
  const nearbyAlertCount = Array.isArray(nearbyAlerts) ? nearbyAlerts.length : 0;
  const nearbyWorstClass = (Array.isArray(nearbyAlerts) ? nearbyAlerts : []).reduce(
    (best, a) => {
      const rank = warningPaintRank(a && a.eventType);
      return rank > best.rank ? { rank, cls: warningClass(a && a.eventType) } : best;
    },
    { rank: -1, cls: "none" },
  ).cls;
  const nearbyWorst = NEARBY_WARNING_BADGE[nearbyWorstClass] || { bg: "#888888", fg: "#fff" };

  // Toast state — short transient label shown just above the dock to
  // confirm "what just happened" when the user taps a toggle. Each
  // tap bumps `toastId` so a fresh CSS animation re-fires even if the
  // text content happens to be identical to the previous toast. The
  // timeout ref lets us cancel a pending dismissal when a new toast
  // supersedes the current one.
  const [toast, setToast] = useState({ id: 0, message: "", x: null, bottom: null, fullWidth: false });
  const toastTimeoutRef = useRef(null);
  const toastIdRef = useRef(0);
  const containerRef = useRef(null);
  const toastRef = useRef(null);

  useEffect(() => () => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
  }, []);

  // After the toast renders, clamp its horizontal position so the box
  // stays fully inside the viewport even when the tapped button is at
  // a screen edge. Without this, the leftmost button's toast bleeds
  // off the left edge and the rightmost button's toast bleeds off the
  // right edge — first / last characters get clipped. We measure the
  // rendered width here (vs. estimating from max-width) so short toasts
  // stay tightly anchored on the button while long ones get nudged
  // inward only as much as needed.
  //
  // Implementation: shift the toast's `translateX(-50%)` by an extra
  // delta via the `--toast-tx` custom property so the keyframes inherit
  // the same offset for free (their `translate(var(--toast-tx), …)`
  // pulls from the same variable). 12 px viewport margin matches the
  // `padding: 12px` on `.dock`.
  useLayoutEffect(() => {
    if (!toast.message || !toastRef.current || toast.x === null) return;
    // Runs in both modes — viewport-centred (`fullWidth`) and
    // button-anchored. In viewport-centred mode the clamp is a
    // safety net: `max-width: min(360px, calc(100vw - 24px))` keeps
    // the box inside the viewport so `shift` resolves to 0, but
    // leaving the check active defends against future content that
    // overflows via padding / border math.
    const el = toastRef.current;
    el.style.setProperty("--toast-tx", "-50%");
    const rect = el.getBoundingClientRect();
    const margin = 12;
    let shift = 0;
    if (rect.left < margin) shift = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) {
      shift = (window.innerWidth - margin) - rect.right;
    }
    if (shift !== 0) {
      el.style.setProperty("--toast-tx", `calc(-50% + ${shift}px)`);
    }
  }, [toast.id, toast.message, toast.x, toast.fullWidth]);

  // Notify is called from each toggle's onClick. The optional event lets
  // us anchor the toast horizontally above the actual button that was
  // tapped (rather than always centred on the dock) — important on the
  // 7" kiosk where the leftmost button's toast appearing in the middle
  // of the screen reads as "nothing happened, that button is broken".
  //
  // v2.14.75: coordinates are now viewport-relative (used with
  // `position: fixed` in CSS) because the LayoutPi root has
  // `overflow: hidden` on `.layout`, which clipped the previous
  // container-relative `position: absolute` toast — on the 7" screen
  // and on any browser window resized below ~1280 px, the toast bled
  // upward out of the dock cell into the clipped region and only a
  // tiny sliver of its border was visible. Switching to fixed makes
  // the toast escape every ancestor's overflow clip.
  //
  // `x` is the centre X of the tapped button in viewport coordinates;
  // `bottom` is the distance from the viewport bottom to the top of
  // the tapped button (plus an 8 px gap), so the toast sits just above
  // the button regardless of where the dock lives in the layout.
  // Falls back to centred when no event is provided.
  const notify = (key, e) => {
    let x = null;
    let bottom = null;
    let fullWidth = false;
    if (e && e.currentTarget) {
      const buttonRect = e.currentTarget.getBoundingClientRect();
      x = buttonRect.left + buttonRect.width / 2;
      bottom = window.innerHeight - buttonRect.top + 8;
      // On narrow viewports (≤ 600 px) the per-button anchoring
      // is dropped in favour of viewport centring. Two reasons,
      // resolved together by the same mode flip:
      //
      // (1) Per-button `left + transform: translateX(-50%)` lets
      //     the toast clip off-screen when the tapped button sits
      //     near the dock's right edge — the clamp `useLayoutEffect`
      //     shifts it back, but the rendered box is already
      //     narrow because the browser's shrink-to-fit width =
      //     `viewport - left` was tiny to start with. Symptom: a
      //     70-char French toast wrapping to 6+ lines that should
      //     fit on 2.
      //
      // (2) An earlier "fix" set both `left: 12px` and `right: 12px`
      //     to force the box wide enough to fit long toasts. That
      //     solved (1) but flipped to the opposite problem: short
      //     toasts ("Marqueur affiché", "Mode jour activé") stretched
      //     full-screen-width on phones with masses of empty
      //     horizontal space — read as "this is a bigger banner
      //     than it should be".
      //
      // Current mode: `left: 50%; --toast-tx: -50%` centres the
      // toast on the VIEWPORT (not the button). Width is intrinsic,
      // capped by the CSS `max-width: min(360px, calc(100vw - 24px))`
      // so long toasts get 360 px (~ 2 lines on Geist 13) and short
      // toasts stay as wide as their text. We lose the per-button
      // visual anchor on phones — accepted trade-off: on phones the
      // dock is small, the user's finger is right there, and
      // honest sizing wins over precise pointing.
      fullWidth = window.innerWidth <= 600;
    }
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToast({ id, message: t(key), x, bottom, fullWidth });
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => {
      setToast((prev) => (prev.id === id ? { ...prev, message: "" } : prev));
    }, TOAST_TIMEOUT);
  };

  // Each button JSX is built once and assigned to a named key, so
  // toast positioning (anchored on
  // `e.currentTarget.getBoundingClientRect()`) behaves identically
  // for every button.
  // Conditional buttons collapse to `null` when their gate is off,
  // and React skips rendering them without disturbing siblings.
  // In the app this button is a FOLLOW toggle, not a one-shot recentre.
  //
  // On the kiosk "recentre" means "put the map back on the configured home
  // position" — a stationary screen has nothing to follow. On a phone the
  // same gesture means "show me where I am", and the useful version of that
  // while driving is continuous: tapping once recentres AND holds the pin on
  // the device until tapped again (see hooks/useFollowLocation.js). Dragging
  // the map also releases it, the way every maps app behaves.
  const btnRecenter = __STANDALONE__ ? (
    <div
      key="recenter"
      onClick={(e) => {
        toggleFollowLocation();
        notify(followLocation ? "toasts.followStopped" : "toasts.followStarted", e);
      }}
      className={`${followLocation ? styles.buttonDown : ""}`}
      aria-pressed={followLocation}
      title={t(followLocation ? "controls.stopFollow" : "controls.startFollow")}
      aria-label={t(followLocation ? "controls.stopFollow" : "controls.startFollow")}
    >
      <InlineIcon icon={centerCircleIcon} />
    </div>
  ) : (
    <div
      key="recenter"
      onClick={(e) => { resetMapPosition(); notify("toasts.mapRecentered", e); }}
      title={t("controls.resetMapPosition")}
      aria-label={t("controls.resetMapPosition")}
    >
      <InlineIcon icon={centerCircleIcon} />
    </div>
  );
  // Favorite locations. Sits next to Recenter because it is the same
  // family — "where are we looking?" — rather than in the Views group,
  // which is Pi-only and means "open a full-rail content view".
  // Deliberately NOT flagged `data-dock-priority="secondary"`: it must stay
  // reachable on a narrow portrait phone, exactly like its Recenter sibling.
  const btnPlaces = (
    <div
      key="places"
      ref={placesRef}
      onClick={() => setPlacesOpen((prev) => !prev)}
      title={t(placesOpen ? "controls.closePlaces" : "controls.openPlaces")}
      aria-label={t(placesOpen ? "controls.closePlaces" : "controls.openPlaces")}
      aria-haspopup="dialog"
      aria-expanded={placesOpen}
    >
      <InlineIcon icon={bookmarkIcon} />
    </div>
  );
  // Location marker visibility toggle. State-based icon: filled
  // pin when the marker is visible, outline pin when hidden. The
  // filled-vs-outline pair reads as "this is the current state"
  // (rather than the older "show the action" convention, which
  // had a slash-through icon when the marker was ON — confusing
  // because the slash visually said "off" while the marker was
  // actually showing).
  const btnMarker = (
    <div
      key="marker"
      onClick={(e) => { toggleMarker(); notify(markerIsVisible ? "toasts.markerHidden" : "toasts.markerShown", e); }}
      title={t(markerIsVisible ? "controls.hideMarker" : "controls.showMarker")}
      aria-label={t(markerIsVisible ? "controls.hideMarker" : "controls.showMarker")}
    >
      <InlineIcon
        icon={markerIsVisible ? locationFilledIcon : locationOutlineIcon}
      />
    </div>
  );
  // Toggles visibility of the radar timeline overlay over the
  // map. The icon (time-plot) signals "this opens time / chrono
  // controls" — the previous play-triangle was misleading because
  // tapping doesn't start playback, it just shows the scrubber UI
  // which has its own play button inside.
  const btnTimeline = (
    <div
      key="timeline"
      /* `data-dock-priority="secondary"` flags this button for
       * the dock's narrow-portrait collapse rule (see
       * BottomDock/styles.css). On phones in portrait the dock
       * hides secondary buttons to keep room for the essentials
       * (recenter, marker, contrast, refresh, settings, health
       * dot); rotating to landscape brings them back.
       *
       * Phase 3 follow-up: when the MOBILE RADAR IS MAXIMIZED the
       * flag is dropped — the timeline/legend are exactly the
       * controls that matter in that mode, and portrait had no way
       * to reach them (maintainer-reported; the only workaround was
       * toggling from a wide window/landscape). Mini mode keeps the
       * lean dock. */
      data-dock-priority={mobileRadarMaximized === true ? undefined : "secondary"}
      onClick={(e) => {
        if (radarOverlaysDisabled) {
          // Mobile mini mode — scrubber is hidden, tapping the
          // button would have no visible effect. Surface a hint
          // pointing the user to the radar's maximize button.
          notify("toasts.radarOverlaysNeedMaximize", e);
          return;
        }
        if (inPriorityDock) {
          // v3.3 priority: the scrubber belongs on the fullscreen radar. Open it
          // on MIN via the EPHEMERAL piScrubberOpen flag — never the shared,
          // persisted radarTimelineVisible (a layout transition must not mutate
          // that v2/desktop/mobile pref). The dock is hidden in MIN, so this only
          // ever fires from the MID glance.
          setPiScrubberOpen(true);
          setPiLayoutState("min");
          notify("toasts.timelineShown", e);
        } else {
          toggleRadarTimelineVisible();
          notify(radarTimelineVisible ? "toasts.timelineHidden" : "toasts.timelineShown", e);
        }
      }}
      className={`${radarOverlaysDisabled ? styles.buttonDisabled : ""} ${!inPriorityDock && radarTimelineVisible && !radarOverlaysDisabled ? styles.buttonDown : ""}`}
      title={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(!inPriorityDock && radarTimelineVisible ? "controls.hideTimeline" : "controls.showTimeline")}
      aria-label={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(!inPriorityDock && radarTimelineVisible ? "controls.hideTimeline" : "controls.showTimeline")}
      aria-disabled={radarOverlaysDisabled || undefined}
    >
      <InlineIcon icon={timePlotIcon} />
    </div>
  );
  // Legend visibility toggle. v2.14.72: dropped the `mapTimestamps`
  // part of the gate — that state lives in WeatherMap, not in
  // AppContext, so the check was always falsy and the button
  // never rendered (latent bug since the original v2 wiring).
  // The button now shows whenever the radar source is RainViewer;
  // clicking it just flips `hideRadarLegend` regardless of whether
  // a legend is currently painted. When timestamps eventually
  // load, the legend follows the preference.
  const btnLegend = (
    <div
      key="legend"
      /* Same maximized-mobile promotion as the timeline button above. */
      data-dock-priority={mobileRadarMaximized === true ? undefined : "secondary"}
      onClick={(e) => {
        if (radarOverlaysDisabled) {
          notify("toasts.radarOverlaysNeedMaximize", e);
          return;
        }
        saveHideRadarLegend(!hideRadarLegend);
        notify(hideRadarLegend ? "toasts.legendShown" : "toasts.legendHidden", e);
      }}
      className={`${radarOverlaysDisabled ? styles.buttonDisabled : ""} ${!hideRadarLegend && !radarOverlaysDisabled ? styles.buttonDown : ""}`}
      title={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(hideRadarLegend ? "controls.showRadarLegend" : "controls.hideRadarLegend")}
      aria-label={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(hideRadarLegend ? "controls.showRadarLegend" : "controls.hideRadarLegend")}
      aria-disabled={radarOverlaysDisabled || undefined}
    >
      <InlineIcon icon={legendIcon} />
    </div>
  );
  // Nearby-alerts overlay toggle (Phase 3). Warning-triangle glyph; same
  // localStorage-instant idiom + radarOverlaysDisabled gate as the legend
  // button. When ON and alerts are in range, a count badge coloured to
  // the worst tier present sits on the corner. Display-only — toggling
  // never touches the banner / SenseHat / eligibility path.
  const btnWeatherAlerts = (
    <div
      key="weatherAlerts"
      data-dock-priority="secondary"
      onClick={(e) => {
        if (radarOverlaysDisabled) {
          notify("toasts.radarOverlaysNeedMaximize", e);
          return;
        }
        toggleWeatherAlerts();
        notify(showWeatherAlerts ? "toasts.nearbyAlertsOff" : "toasts.nearbyAlertsOn", e);
      }}
      className={`${styles.alertToggle} ${radarOverlaysDisabled ? styles.buttonDisabled : ""} ${showWeatherAlerts && !radarOverlaysDisabled ? styles.buttonDown : ""}`}
      title={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(showWeatherAlerts ? "controls.hideNearbyAlerts" : "controls.showNearbyAlerts")}
      aria-label={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(showWeatherAlerts ? "controls.hideNearbyAlerts" : "controls.showNearbyAlerts")}
      aria-disabled={radarOverlaysDisabled || undefined}
    >
      <InlineIcon icon={warningAltIcon} />
      {showWeatherAlerts && nearbyAlertCount > 0 ? (
        <span
          className={styles.alertCountBadge}
          style={{ backgroundColor: nearbyWorst.bg, color: nearbyWorst.fg }}
        >
          {nearbyAlertCount}
        </span>
      ) : null}
    </div>
  );
  // Storm tracks (NEXRAD Level III STI) — SCIT cell positions and their
  // forecast paths. Same overlay-gating and secondary dock priority as the
  // alerts toggle beside it. The hurricane glyph
  // reads as "rotating storm" and stays distinct from the alert triangle
  // at kiosk glance distance.
  const btnStormTracks = (
    <div
      key="stormTracks"
      data-dock-priority="secondary"
      onClick={(e) => {
        if (radarOverlaysDisabled) {
          notify("toasts.radarOverlaysNeedMaximize", e);
          return;
        }
        toggleStormTracks();
        notify(showStormTracks ? "toasts.stormTracksOff" : "toasts.stormTracksOn", e);
      }}
      className={`${radarOverlaysDisabled ? styles.buttonDisabled : ""} ${showStormTracks && !radarOverlaysDisabled ? styles.buttonDown : ""}`}
      title={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(showStormTracks ? "controls.hideStormTracks" : "controls.showStormTracks")}
      aria-label={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(showStormTracks ? "controls.hideStormTracks" : "controls.showStormTracks")}
      aria-disabled={radarOverlaysDisabled || undefined}
    >
      <InlineIcon icon={stormTracksIcon} />
    </div>
  );
  // GLM lightning toggle -- same overlay gating as its neighbours.
  const btnLightning = (
    <div
      key="lightning"
      data-dock-priority="secondary"
      onClick={(e) => {
        if (radarOverlaysDisabled) {
          notify("toasts.radarOverlaysNeedMaximize", e);
          return;
        }
        toggleLightning();
        notify(showLightning ? "toasts.lightningOff" : "toasts.lightningOn", e);
      }}
      className={`${radarOverlaysDisabled ? styles.buttonDisabled : ""} ${showLightning && !radarOverlaysDisabled ? styles.buttonDown : ""}`}
      title={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(showLightning ? "controls.hideLightning" : "controls.showLightning")}
      aria-label={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(showLightning ? "controls.hideLightning" : "controls.showLightning")}
      aria-disabled={radarOverlaysDisabled || undefined}
    >
      <InlineIcon icon={lightningIcon} />
    </div>
  );
  // Clear-air noise filter for the raw-radial layer — hides sub-15 dBZ
  // returns (bugs/birds/dust in clear-air mode) that otherwise paint the
  // whole disc on a dry day. Unlike its neighbours the pressed state means
  // "filter active", and it defaults ON.
  const btnNoiseFilter = (
    <div
      key="noiseFilter"
      data-dock-priority="secondary"
      onClick={(e) => {
        if (radarOverlaysDisabled) {
          notify("toasts.radarOverlaysNeedMaximize", e);
          return;
        }
        toggleRadarNoiseFilter();
        notify(radarNoiseFilter ? "toasts.noiseFilterOff" : "toasts.noiseFilterOn", e);
      }}
      className={`${radarOverlaysDisabled ? styles.buttonDisabled : ""} ${radarNoiseFilter && !radarOverlaysDisabled ? styles.buttonDown : ""}`}
      title={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(radarNoiseFilter ? "controls.noiseFilterDisable" : "controls.noiseFilterEnable")}
      aria-label={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(radarNoiseFilter ? "controls.noiseFilterDisable" : "controls.noiseFilterEnable")}
      aria-disabled={radarOverlaysDisabled || undefined}
    >
      <InlineIcon icon={noiseFilterIcon} />
    </div>
  );
  // Velocity mode — swaps the high-zoom single-site product from N0B
  // reflectivity to N0G base velocity (raw radials, same renderer). The
  // low-zoom mosaic has no velocity counterpart and stays reflectivity.
  const btnVelocity = (
    <div
      key="velocity"
      data-dock-priority="secondary"
      onClick={(e) => {
        if (radarOverlaysDisabled) {
          notify("toasts.radarOverlaysNeedMaximize", e);
          return;
        }
        toggleRadarVelocity();
        notify(radarVelocity ? "toasts.velocityOff" : "toasts.velocityOn", e);
      }}
      className={`${radarOverlaysDisabled ? styles.buttonDisabled : ""} ${radarVelocity && !radarOverlaysDisabled ? styles.buttonDown : ""}`}
      title={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(radarVelocity ? "controls.velocityOff" : "controls.velocityOn")}
      aria-label={radarOverlaysDisabled
        ? t("controls.radarOverlaysNeedMaximize")
        : t(radarVelocity ? "controls.velocityOff" : "controls.velocityOn")}
      aria-disabled={radarOverlaysDisabled || undefined}
    >
      <InlineIcon icon={velocityIcon} />
    </div>
  );
  const btnContrast = (
    <div
      key="contrast"
      onClick={(e) => { setDarkMode(!darkMode); notify(darkMode ? "toasts.lightModeOn" : "toasts.darkModeOn", e); }}
      title={t(darkMode ? "controls.lightMode" : "controls.darkMode")}
      aria-label={t(darkMode ? "controls.lightMode" : "controls.darkMode")}
    >
      <InlineIcon icon={contrastIcon} />
    </div>
  );
  // Auto dark/light toggle (v2.14.71). Flips darkMode at the
  // local sunrise / sunset times pulled from sunrise-sunset.org.
  // `.buttonDown` active state mirrors the timeline + legend
  // toggles: when ON, the button reads as "pressed in" via the
  // palette's accent-soft fill.
  const btnAuto = (
    <div
      key="auto"
      data-dock-priority="secondary"
      onClick={(e) => { saveDarkModeAuto(!darkModeAuto); notify(darkModeAuto ? "toasts.autoModeOff" : "toasts.autoModeOn", e); }}
      className={`${darkModeAuto ? styles.buttonDown : ""}`}
      title={t(darkModeAuto ? "controls.disableAutoMode" : "controls.enableAutoMode")}
      aria-label={t(darkModeAuto ? "controls.disableAutoMode" : "controls.enableAutoMode")}
    >
      <InlineIcon icon={automaticIcon} />
    </div>
  );
  // Night-red (sleep-stage-1) palette toggle (v2.14.71). The
  // moon icon is rendered in MOON_COLOR (#c44040 — same as the
  // nightRed accent and matches "blood moon" / lunar eclipse
  // iconography) regardless of palette. When the mode is OFF
  // (day / dusk / night palettes) the red moon on the standard
  // dock surface reads as "dormant, ready to activate". When ON
  // (nightRed palette) the `.buttonDown` accent-soft fill behind
  // the moon signals "currently active, tap to deactivate" —
  // same toggle affordance as the timeline button.
  const btnNightRed = (
    <div
      key="nightRed"
      data-dock-priority="secondary"
      onClick={(e) => { saveAdvancedSleepFlag("nightMode", !sleepNightMode); notify(sleepNightMode ? "toasts.nightRedOff" : "toasts.nightRedOn", e); }}
      className={`${sleepNightMode ? styles.buttonDown : ""}`}
      title={t(sleepNightMode ? "controls.disableNightRed" : "controls.enableNightRed")}
      aria-label={t(sleepNightMode ? "controls.disableNightRed" : "controls.enableNightRed")}
    >
      <InlineIcon icon={moonIcon} style={{ color: MOON_COLOR }} />
    </div>
  );
  // App refresh — primarily for PWA standalone mode on iOS/Android
  // where the browser's reload UI isn't reachable. Useful elsewhere
  // too (Pi kiosk has no keyboard for Cmd/Ctrl+R). Short toast then
  // a small delay so the user sees the confirmation before the page
  // tears down.
  const btnRefresh = (
    <div
      key="refresh"
      onClick={(e) => {
        notify("toasts.refreshing", e);
        setTimeout(() => window.location.reload(), 200);
      }}
      title={t("controls.refreshApp")}
      aria-label={t("controls.refreshApp")}
    >
      <InlineIcon icon={renewIcon} />
    </div>
  );
  const btnSettings = (
    <div
      key="settings"
      onClick={(e) => { toggleSettingsMenuOpen(); notify(settingsMenuOpen ? "toasts.settingsClosed" : "toasts.settingsOpened", e); }}
      className={`${settingsMenuOpen ? styles.buttonDown : ""}`}
      title={t(settingsMenuOpen ? "controls.closeSettings" : "controls.openSettings")}
      aria-label={t(settingsMenuOpen ? "controls.closeSettings" : "controls.openSettings")}
    >
      <InlineIcon icon={settingsIcon} />
    </div>
  );
  const btnDebug = isLocal && debugEnabled ? (
    <div
      key="debug"
      onClick={(e) => { toggleDebugMenuOpen(); notify(debugMenuOpen ? "toasts.debugClosed" : "toasts.debugOpened", e); }}
      className={`${debugMenuOpen ? styles.buttonDown : ""}`}
      title={t(debugMenuOpen ? "controls.closeDebug" : "controls.openDebug")}
      aria-label={t(debugMenuOpen ? "controls.closeDebug" : "controls.openDebug")}
    >
      <InlineIcon icon={bugIcon} />
    </div>
  ) : null;
  // The IA button and the Claude summary it opened were removed in the
  // radar rework.
  const btnBot = null;
  // The forecast view-open button went with ChartTabs.
  const btnForecast = null;
  const btnUpdateLocal = updateAvailable && isLocal ? (
    <div
      key="updateLocal"
      onClick={() => setUpdateModalOpen(!updateModalOpen)}
      className={`${styles.updateButton} ${updateModalOpen ? styles.buttonDown : ""}`}
      title={t(updateModalOpen ? "controls.closeUpdate" : "controls.openUpdate")}
      aria-label={t(updateModalOpen ? "controls.closeUpdate" : "controls.openUpdate")}
    >
      <InlineIcon icon={upgradeIcon} />
      <span className={styles.updateBadge} />
    </div>
  ) : null;
  const btnUpdateRemote = updateAvailable && !isLocal ? (
    <div
      key="updateRemote"
      className={`${styles.updateButton} ${styles.updateButtonRemote}`}
      title={t("controls.updateAvailableRemote")}
      aria-label={t("controls.updateAvailableRemote")}
      aria-disabled="true"
      role="button"
      onClick={(e) => notify("toasts.updateRemoteNotice", e)}
    >
      <InlineIcon icon={upgradeIcon} />
      <span className={styles.updateBadge} />
    </div>
  ) : null;

  // Transient toast — floats just above the dock to confirm
  // the effect of the last toggle. Rendered conditionally so the
  // CSS animation re-fires on each new tap; the `key` bound to
  // `toast.id` guarantees React unmounts the previous instance
  // even when consecutive toasts share the same message text.
  const toastNode = toast.message ? (
    <div
      key={toast.id}
      ref={toastRef}
      className={styles.toast}
      role="status"
      aria-live="polite"
      /* Three positioning modes:
       *   1. Button-anchored (wide viewport with `toast.x` set):
       *      inline `left` + `bottom` place the toast at the
       *      tapped button's centre in viewport coords; CSS
       *      `transform: translate(var(--toast-tx, -50%), …)`
       *      then centres it visually. `useLayoutEffect` clamps
       *      `--toast-tx` if the box overflows a viewport edge.
       *   2. Viewport-centred (narrow viewport ≤ 600 px,
       *      `toast.fullWidth` true): `left: 50%` + the same
       *      `--toast-tx: -50%` translate centres on the
       *      VIEWPORT — width is intrinsic to the content,
       *      capped by the CSS `max-width`. Drops the per-button
       *      anchor in exchange for honest sizing (short toasts
       *      no longer span the full screen, long toasts get up
       *      to 360 px instead of clipping at the dock edges).
       *   3. Default (no event provided): CSS handles it
       *      (left:50%, default bottom). */
      style={(() => {
        if (toast.x === null) return undefined;
        if (toast.fullWidth) {
          // `left: 50%` + the CSS default `--toast-tx: -50%`
          // centres on the viewport. Width is intrinsic to the
          // text content, capped by the CSS `max-width` so the
          // toast never overflows the screen edges.
          return { left: "50%", bottom: `${toast.bottom}px` };
        }
        return { left: `${toast.x}px`, bottom: `${toast.bottom}px` };
      })()}
    >
      {toast.message}
    </div>
  ) : null;

  const containerClass = `${styles.container} ${styles.grouped} ${
    darkMode ? styles.dark : styles.light
  } ${!mouseHide ? styles.showMouse : ""} ${labelled ? styles.labelled : ""}`;

  /**
   * In the drawer, render a button as an icon + its own name.
   *
   * The name is read from the button's `aria-label`, which every button
   * already carries and already keeps in sync with its state ("Show base
   * velocity" / "Show reflectivity"). Cloning here rather than threading a
   * label through fifteen button definitions keeps one source of truth for
   * what each control is called — and the phrasing is what the control DOES,
   * which is what a labelled drawer is for.
   *
   * @param {object} node one of the button elements built above, or null
   * @returns {object} the node, labelled when the drawer is rendering it
   */
  const withLabel = (node) => {
    if (!labelled || !node) return node;
    return React.cloneElement(node, {}, (
      <>
        {node.props.children}
        <span className={styles.buttonLabel}>{node.props["aria-label"]}</span>
      </>
    ));
  };

  // Labelled groups with hairline separators in CSS; group labels
  // CSS-hide on the 7" Pi kiosk and on mobile (see styles.css).
  // Map = view-affecting toggles; Display = palette / mode;
  // System = app-level actions.
  return (
    <div ref={containerRef} className={containerClass}>
      <div className={styles.group}>
        <span className={styles.groupLabel}>{t("controls.groupMap")}</span>
        {withLabel(btnRecenter)}
        {withLabel(btnPlaces)}
        {withLabel(btnMarker)}
        {withLabel(btnTimeline)}
        {withLabel(btnLegend)}
        {withLabel(btnWeatherAlerts)}
        {withLabel(btnStormTracks)}
        {withLabel(btnLightning)}
        {withLabel(btnNoiseFilter)}
        {withLabel(btnVelocity)}
      </div>
      {/* Views group (rail-affordance redesign 2026-06-24) — "change topic
        * to a full-rail content view", distinct from the Map group's
        * "manipulate the map in place". Holds the IA/sparkle view-open
        * (relocated out of the Map group) and the new forecast view-open.
        * Both buttons are Pi-dock-only (btnForecast on `inPiDock`, btnBot's
        * view-open on `inPriorityDock`); off the Pi they are both `null`. The
        * wrapper `.group` div + `.groupLabel` span are ALWAYS in the JSX, so
        * the group does NOT collapse on its own when empty — it would leave
        * an orphan "VIEWS" label (desktop) and a stray separator hairline.
        * Guard the whole wrapper on having at least one button so it
        * disappears entirely off the Pi. On the Pi this is never empty. */}
      {(btnBot || btnForecast) ? (
        <div className={styles.group}>
          <span className={styles.groupLabel}>{t("controls.groupViews")}</span>
          {withLabel(btnBot)}
          {withLabel(btnForecast)}
        </div>
      ) : null}
      <div className={styles.group}>
        <span className={styles.groupLabel}>{t("controls.groupDisplay")}</span>
        {withLabel(btnContrast)}
        {withLabel(btnAuto)}
        {withLabel(btnNightRed)}
      </div>
      <div className={styles.group}>
        <span className={styles.groupLabel}>{t("controls.groupSystem")}</span>
        {withLabel(btnRefresh)}
        {withLabel(btnSettings)}
        {withLabel(btnDebug)}
        {withLabel(btnUpdateLocal)}
        {withLabel(btnUpdateRemote)}
      </div>
      {toastNode}
      <PlacesPopover
        open={placesOpen}
        onClose={() => setPlacesOpen(false)}
        triggerRef={placesRef}
        onNotify={notify}
      />
    </div>
  );
};

ControlButtons.propTypes = {
  labelled: PropTypes.bool,
};

export default ControlButtons;
