import React, {
  useEffect,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  MapContainer,
  TileLayer,
  ImageOverlay,
  Pane,
  AttributionControl,
  ZoomControl,
  Marker,
  Circle,
  GeoJSON,
  Popup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
// Bundle Leaflet's stylesheet via webpack instead of the CDN <link>
// that index.html used to carry. The CDN <link> + <script> were
// failing SRI checks after unpkg shipped a re-encoded build whose
// SHA-256 no longer matched the pinned hash; the <script> was also
// dead weight since react-leaflet pulls its Leaflet JS from the npm
// package above. Importing the CSS here ties stylesheet loading to
// the component that actually needs it.
import "leaflet/dist/leaflet.css";
// Default marker icons — bundle them via webpack and re-point
// L.Icon.Default so `<Marker>` without an explicit `icon` prop
// renders correctly. Leaflet's defaults assume the images live
// next to leaflet.js at runtime, which isn't the case when
// react-leaflet pulls leaflet from the npm bundle. Without this
// remap the marker fetches resolve to the site root and 404.
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
});
import PropTypes from "prop-types";
import {
  AppActionsContext,
  SystemContext,
  LocationContext,
  UiPrefsContext,
  AlertsContext,
  RadarStateContext,
} from "~/AppContext";
import useEligibleGovAlerts from "~/hooks/useEligibleGovAlerts";
import SourceBadge from "~/components/ambient/SourceBadge";
import SeverityChip from "~/components/ambient/SeverityChip";
import { useTimeOfDay } from "~/ui/hybrid";
import { isPiMaxView, priorityViewsEnabled } from "~/ui/piLayout";
import { useTranslation } from "react-i18next";
import debounce from "debounce";
import styles from "./styles.css";
import RadarLegend from "./RadarLegend";
import RadarTimeline from "./RadarTimeline";
import RadarFrameAge from "./RadarFrameAge";
import useIemRadarFrames from "./useIemRadarFrames";
import useStormTracks from "./useStormTracks";
import useLightning from "./useLightning";
import LightningOverlay from "./LightningOverlay";
import useRadarRadial from "./useRadarRadial";
import StormTracks from "./StormTracks";
import {
  IEM_ATTRIBUTION,
  buildMosaicFrames,
  siteTileUrl,
  layerOpacities,
  layerVisibility,
  MOSAIC_MAX_NATIVE_ZOOM,
  SITE_MAX_NATIVE_ZOOM,
  SITE_MIN_ZOOM,
  MOSAIC_MAX_ZOOM,
} from "./iemRadar";
import MapResizer from "./MapResizer";
import RadarFocusControl from "./RadarFocusControl";
import {
  hasVal,
  panWithRailOffset,
  buildAlertPolygonLayers,
  warningPaintRank,
  buildRadiusRingOptions,
  pointInGeometry,
} from "./geometry";


/* Shared empty-list default for the alert overlay components below.
 * Module-scope so an omitted prop keeps ONE stable reference across
 * renders — a bare `= []` signature default would allocate a fresh
 * array per render and bust AlertGeometryOverlay's `[govAlerts, …]`
 * memo chain (the same reference-stability contract as the layer-prop
 * memos in the main component). Frozen so nothing can mutate the
 * shared default. */
const NO_ALERTS = Object.freeze([]);

/* Zoom threshold above which the nearby-alerts radius ring stops
 * rendering. (It also gated the radar analysis circles and sampling
 * dots, which were removed with the RainViewer sampler.) At z=13 the inner 50 km
 * circle has a pixel radius of ~3700 px (≈ 2.7× the iPad viewport
 * width) so most of it is already off-screen; by z=14 it's ~7460 px
 * (entirely off-screen). Beyond that the SVG element is dead
 * weight in the DOM — invisible but still maintained by the
 * renderer, contributing to the pan-jank observed on macOS Firefox
 * and Safari iPad at high zoom. Hiding them frees the SVG layer
 * and restores smooth panning. */
const RING_HIDE_ZOOM = 13;

/* Base interval between animation frames, in ms; divided by the user's
 * radarSpeed (1× / 2× / 4×) to get the actual tick. Module scope because
 * BOTH the RainViewer loop and the IEM loop read it, and the IEM effect
 * is declared above where the component's other timing constants sit —
 * a component-scoped const would work (effect callbacks run after the
 * body) but only by accident of timing. */
const MAP_CYCLE_RATE = 1000; //ms

// Paint order for overlapping warning polygons comes from
// `warningPaintRank` (geometry.js): Leaflet paints later-inserted vector
// layers ON TOP, and a Tornado Warning nested inside a Severe
// Thunderstorm Warning must paint last so it is never buried. (This
// replaced the old tier-based ordering when the polygons switched to
// RadarScope-style per-event colours.)

/**
 * Build the custom DivIcon used for the user's location marker. v2.14.64
 * replaces Leaflet's default blue teardrop pin — that bright blue
 * stood out against every palette (especially nightRed where it
 * looked alien) and was hard to see on the 7" kiosk at glance
 * distance. The target-style marker (outer ring + filled centre dot)
 * picks up `--c-accent` from the active palette via CSS variables, so
 * it auto-tints with day / dusk / night / nightRed without per-palette
 * overrides. Sized at 22 × 22 with the anchor centred so the dot sits
 * exactly on the selected coordinates.
 *
 * @returns {import("leaflet").DivIcon} Leaflet DivIcon ready for `<Marker icon={…}>`
 */
function buildLocationMarkerIcon() {
  return L.divIcon({
    className: "weather-station-target",
    html:
      '<div class="weather-station-target__ring">' +
      '<div class="weather-station-target__dot"></div>' +
      '</div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}
const LOCATION_MARKER_ICON = buildLocationMarkerIcon();




// Mapbox basemaps served via the server proxy (keeps the API key off the client).
const MAPBOX_ATTRIBUTION = '© <a href="https://www.mapbox.com/feedback/">Mapbox</a>';


/**
 * Handles map click events from inside the MapContainer context
 *
 * @param {object} props
 * @param {Function} props.onClick click handler
 * @returns {null} renders nothing
 */
const MapClickHandler = ({ onClick }) => {
  useMapEvents({ click: onClick });
  return null;
};

MapClickHandler.propTypes = {
  onClick: PropTypes.func.isRequired,
};


/**
 * Pans the map when panToCoords changes
 *
 * @param {object} props
 * @param {object} props.panToCoords target coordinates
 * @param {Function} props.setPanToCoords resets panToCoords to null
 * @returns {null} renders nothing
 */

/**
 * Read the visible rail's pixel width once on mount + whenever the
 * radar focus-mode flags toggle. Queries the DOM directly
 * because the value lives in CSS variables on `.ambientRoot` and on
 * the rail's actual rendered bounding rect (the `--c-rail-width`
 * value differs between LayoutDesktop and LayoutPi, and is bumped
 * to 360 px on wide displays via a media query). Returns 0 when
 * there's no rail overlaying the map (radar focus mode, a layout
 * where the rail sits in its own grid column, no ambientRoot).
 *
 * The 1-frame timeout is load-bearing for the initial measurement:
 * WeatherMap mounts inside the rail-bearing layout, so the rail's
 * geometry isn't yet laid out when this effect's first synchronous
 * pass runs. Deferring by a frame lets the browser commit the
 * stylesheet before we measure.
 *
 * @returns {Number} rail width in pixels (0 if no offset needed)
 */
function useRailOffset() {
  const { desktopRadarMaximized, piRadarMaximized } = useContext(SystemContext);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    // Focus mode hides HeroBand + rail via display:none. Bail with
    // a zero offset so the marker pans to the geometric centre of
    // the now-empty viewport. The flag is also in the dep array so
    // toggling focus re-runs this effect (without it the offset
    // stayed at the last-measured value and the marker stayed
    // shifted as if the rail were still visible).
    if (desktopRadarMaximized || piRadarMaximized) {
      setOffset({ x: 0, y: 0 });
      return undefined;
    }
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const rail = document.querySelector(".ambientRoot aside");
      const hero = document.querySelector(".ambientRoot [data-ambient-hero]");
      // `data-ambient-hero` is only set in LayoutDesktop, where the map
      // is full-bleed and BOTH the HeroBand (top) and the rail (right
      // edge) OVERLAY the map. On LayoutPi the map sits in its own
      // grid column with the rail in a separate column, so the visible
      // map area is already the full map — no shift needed at all.
      // Pre-v2.14.68 the horizontal offset was applied on every
      // layout, which pushed the marker to the far left on LayoutPi
      // (rail offset shifted the map centre right when the marker was
      // already in the clear). Gating BOTH axes on `hero` keeps the
      // overlay correction limited to LayoutDesktop where it belongs.
      const railOverlaysMap = !!hero;
      const x = (rail && railOverlaysMap) ? Math.round(rail.getBoundingClientRect().width) : 0;
      const y = hero ? Math.round(hero.getBoundingClientRect().height) : 0;
      setOffset({ x, y });
    };
    const handle = requestAnimationFrame(measure);
    // Re-measure on viewport size changes — LayoutDesktop bumps rail
    // width from 320 → 360 px above 1900 px wide via a media query,
    // and the HeroBand's height can shift if its content reflows.
    window.addEventListener("resize", measure);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
      window.removeEventListener("resize", measure);
    };
  }, [desktopRadarMaximized, piRadarMaximized]);
  return offset;
}

const PanHandler = ({ panToCoords, setPanToCoords, railOffset }) => {
  const map = useMap();
  useEffect(() => {
    if (panToCoords) {
      panWithRailOffset(map, [panToCoords.latitude, panToCoords.longitude], railOffset);
      setPanToCoords(null);
    }
  }, [panToCoords, map, setPanToCoords, railOffset]);
  return null;
};

PanHandler.propTypes = {
  panToCoords: PropTypes.object,
  setPanToCoords: PropTypes.func.isRequired,
  railOffset: PropTypes.shape({ x: PropTypes.number, y: PropTypes.number }),
};

/**
 * Re-centres the map whenever `railOffset` changes — collapsing or
 * expanding the rail, or switching layouts, would otherwise leave
 * the marker in the wrong visual position. Pulls the current marker
 * latLng from context and re-applies the offset trick. Skipped when
 * `markerPosition` isn't yet set (initial load before mapGeo lands).
 */
const RailOffsetTracker = ({ railOffset, markerPosition }) => {
  const map = useMap();
  const lastOffsetRef = useRef(railOffset);
  useEffect(() => {
    // useRailOffset returns a fresh object every render even when
    // values haven't changed, so compare by x/y rather than identity.
    // Skip the first run so the initial mount doesn't double-pan —
    // InitialOffsetCentering handles the boot case explicitly.
    const prev = lastOffsetRef.current;
    if (prev && prev.x === railOffset.x && prev.y === railOffset.y) return;
    lastOffsetRef.current = railOffset;
    if (!markerPosition) return;
    panWithRailOffset(map, markerPosition, railOffset, { animate: true });
  }, [railOffset, markerPosition, map]);
  return null;
};

RailOffsetTracker.propTypes = {
  railOffset: PropTypes.shape({ x: PropTypes.number, y: PropTypes.number }),
  markerPosition: PropTypes.array,
};

/**
 * Applies the rail offset on initial mount — MapContainer's `center`
 * prop is read once and never re-applied, so without this effect the
 * marker would stay at viewport-centre (behind the rail) until the
 * user clicks somewhere. Runs once when both map and marker are ready.
 */
const InitialOffsetCentering = ({ railOffset, markerPosition }) => {
  const map = useMap();
  const appliedRef = useRef(false);
  useEffect(() => {
    if (appliedRef.current) return;
    if (!markerPosition || !railOffset) return;
    if (!railOffset.x && !railOffset.y) return;
    appliedRef.current = true;
    panWithRailOffset(map, markerPosition, railOffset, { animate: false });
  }, [map, markerPosition, railOffset]);
  return null;
};

InitialOffsetCentering.propTypes = {
  railOffset: PropTypes.shape({ x: PropTypes.number, y: PropTypes.number }),
  markerPosition: PropTypes.array,
};

/**
 * Pushes the current Leaflet zoom up to AppContext on every zoomend event,
 * plus once on mount so the Debug panel doesn't read a stale fallback. The
 * Debug panel reads currentMapZoom from context instead of poking into the
 * Leaflet instance.
 *
 * @param {object} props
 * @param {Function} props.onZoomChange called with the new zoom on every change
 * @returns {null} renders nothing
 */
const MapZoomTracker = ({ onZoomChange }) => {
  const map = useMapEvents({
    zoomend: () => onZoomChange(map.getZoom()),
  });
  useEffect(() => {
    onZoomChange(map.getZoom());
  }, [map, onZoomChange]);
  return null;
};

MapZoomTracker.propTypes = {
  onZoomChange: PropTypes.func.isRequired,
};

/**
 * Live preview for the Settings → Default Map Zoom slider. When the user
 * moves the slider, AppContext sets zoomToLevel; this handler picks it up
 * and calls map.setZoom, then resets zoomToLevel to null. Without this,
 * the slider would only take effect on next page load — confusing UX.
 *
 * @param {object} props
 * @param {Number|null} props.zoomToLevel target zoom level, or null when idle
 * @param {Function} props.setZoomToLevel resets zoomToLevel to null
 * @returns {null} renders nothing
 */
const ZoomLevelHandler = ({ zoomToLevel, setZoomToLevel }) => {
  const map = useMap();
  useEffect(() => {
    if (zoomToLevel !== null && zoomToLevel !== undefined) {
      map.setZoom(zoomToLevel);
      setZoomToLevel(null);
    }
  }, [zoomToLevel, map, setZoomToLevel]);
  return null;
};

ZoomLevelHandler.propTypes = {
  zoomToLevel: PropTypes.number,
  setZoomToLevel: PropTypes.func.isRequired,
};

/**
 * Anchors the +/- zoom buttons (and keyboard zoom) on the visual centre
 * of the NON-RAIL map area instead of Leaflet's default true-viewport
 * centre — so the location marker no longer drifts when zooming.
 *
 * On LayoutDesktop the rail (right) + HeroBand (top) OVERLAY the map, so
 * `panWithRailOffset` deliberately pushes the map's true centre to the
 * north-east of the marker to keep the marker at the visual centre of the
 * uncovered area. Leaflet's stock `zoomIn`/`zoomOut` zoom around that true
 * centre, which sits up-and-right of the marker — so each zoom step slid
 * the marker toward the lower-left (zoom in) or upper-right (zoom out).
 *
 * Fix: override `zoomIn`/`zoomOut` on the map instance to `setZoomAround`
 * the non-rail visual centre — the exact inverse of the panWithRailOffset
 * placement `(W/2 - offsetX/2, H/2 + offsetY/2)`, the container point where
 * a centred marker sits — so that point stays pinned across zoom steps.
 * The original methods are restored on unmount.
 *
 * No-op when `railOffset` is zero (LayoutPi / LayoutMobile / focus
 * mode): the override falls straight through to Leaflet's centre-anchored
 * default, so center-anchored zoom is preserved everywhere the rail does
 * not overlay the map. Scroll-wheel / double-click / box zoom are
 * untouched — they already anchor on the cursor via their own handlers.
 *
 * @param {object} props
 * @param {{x: Number, y: Number}} props.railOffset pixels covered by rail / HeroBand
 * @returns {null} renders nothing
 */
const ZoomAnchorOffset = ({ railOffset }) => {
  const map = useMap();
  // Latest offset without re-running the patch effect on every change —
  // useRailOffset returns a fresh object each render.
  const offsetRef = useRef(railOffset);
  offsetRef.current = railOffset;
  useEffect(() => {
    const origZoomIn = map.zoomIn;
    const origZoomOut = map.zoomOut;
    const zoomAroundNonRailCentre = (delta) => {
      const offset = offsetRef.current;
      const offsetX = (offset && offset.x) || 0;
      const offsetY = (offset && offset.y) || 0;
      const size = map.getSize();
      const anchor = L.point(size.x / 2 - offsetX / 2, size.y / 2 + offsetY / 2);
      map.setZoomAround(map.containerPointToLatLng(anchor), map.getZoom() + delta);
    };
    // ZoomControl always passes an explicit delta; default to zoomDelta
    // for any caller that omits it (mirrors Leaflet's own fallback).
    const resolveDelta = (delta) => (delta == null ? map.options.zoomDelta : delta);
    map.zoomIn = function patchedZoomIn(delta, options) {
      const offset = offsetRef.current;
      if (!offset || (!offset.x && !offset.y)) return origZoomIn.call(map, delta, options);
      zoomAroundNonRailCentre(resolveDelta(delta));
      return map;
    };
    map.zoomOut = function patchedZoomOut(delta, options) {
      const offset = offsetRef.current;
      if (!offset || (!offset.x && !offset.y)) return origZoomOut.call(map, delta, options);
      zoomAroundNonRailCentre(-resolveDelta(delta));
      return map;
    };
    return () => {
      map.zoomIn = origZoomIn;
      map.zoomOut = origZoomOut;
    };
  }, [map]);
  return null;
};

ZoomAnchorOffset.propTypes = {
  railOffset: PropTypes.shape({ x: PropTypes.number, y: PropTypes.number }),
};

/**
 * Phase 4d (2026-05-28): GeoJSON overlay for the alert zone the user
 * picked via the AlertBanner's "Voir sur la carte" button. Renders a
 * tier-coloured polygon (red / orange / yellow) and zoom-to-fits when
 * `highlightedAlertId` changes. Clears entirely when the id is null
 * or when no matching alert with geometry is found.
 *
 * The fitBounds runs INSIDE the `MapContainer` context — that's why
 * this is a child component using `useMap` rather than a prop on
 * the parent. The `key` on the `<GeoJSON>` element is the alert id so
 * Leaflet re-creates the layer when the user switches between alerts
 * (Leaflet's internal cache wouldn't re-render the path on a plain
 * data prop change).
 *
 * @param {object} props
 * @param {?string} props.highlightedAlertId — id of the alert whose
 *   polygon is currently shown; null = no overlay
 * @param {Array} props.govAlerts — list of active alerts
 * @param {boolean} props.nightRed — night-vision palette active (alert
 *   chrome collapses to the red family, Phase 3 rule A1)
 * @param {boolean} props.dark — dark-mode flag (light mode adds the dark
 *   casing beneath the coloured stroke; dark/nightRed skip it)
 * @returns {JSX.Element|null}
 */
const AlertGeometryOverlay = ({ highlightedAlertId = null, govAlerts = NO_ALERTS, nightRed, dark = false }) => {
  const map = useMap();
  // Find the matching alert. Memo because govAlerts changes on every
  // poll cycle but we only care about the active highlight.
  const alert = useMemo(() => {
    if (!highlightedAlertId || !Array.isArray(govAlerts)) return null;
    return govAlerts.find((a) => a && a.id === highlightedAlertId && a.geometry) || null;
  }, [govAlerts, highlightedAlertId]);
  // Tier → stacked path layers via the shared builder (geometry.js) so the
  // overlay and the nearby-alerts polygons agree — including the nightRed
  // collapse-to-red rule (Phase 3, A1) and the light-mode dark casing that
  // lifts the warm hues off the light basemap (2 px solid border + 15 %
  // fill on top, distinct from the dashed radar circles).
  const layers = useMemo(
    () => (alert ? buildAlertPolygonLayers(alert.eventType, nightRed, dark) : null),
    [alert, nightRed, dark]
  );
  // fitBounds when the alert (or its geometry) changes. Generous
  // padding via `padding: [40, 40]` so the polygon doesn't sit
  // edge-to-edge against the map viewport — gives the user context
  // (surrounding towns, radar tiles outside the zone). `maxZoom: 11`
  // prevents an over-zoom on tiny polygons (a single-county polygon
  // would otherwise pin to z 13-14, losing the radar context).
  useEffect(() => {
    if (!alert || !alert.geometry || !map) return;
    try {
      const tmp = L.geoJSON(alert.geometry);
      const bounds = tmp.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
      }
    } catch {
      // GeoJSON parsing failed — silently skip the fitBounds. The
      // <GeoJSON> render below will also bail out gracefully if
      // Leaflet can't parse the geometry.
    }
  }, [alert, map]);
  if (!alert || !layers) return null;
  // One <GeoJSON> per layer (casing under, coloured over) — mirrors how
  // RiskRing stacks buildRingLayers. Keyed per layer so the alert change
  // re-mounts both.
  return (
    <>
      {layers.map((ly, i) => (
        <GeoJSON key={`${alert.id}-${i}`} data={alert.geometry} style={() => ly} />
      ))}
    </>
  );
};

AlertGeometryOverlay.propTypes = {
  highlightedAlertId: PropTypes.string,
  // eslint-disable-next-line react/forbid-prop-types -- alert objects are payload-shaped, not statically typed
  govAlerts: PropTypes.array,
  nightRed: PropTypes.bool,
  dark: PropTypes.bool,
};

/**
 * Display-only overlay painting every active alert within the user's
 * radius (the "Nearby alerts" survey) as a tier-coloured GeoJSON
 * polygon. Unlike `AlertGeometryOverlay` — which renders the single
 * alert the user picked and auto-fitBounds-zooms to it — this renders N
 * polygons and never moves the map: it surveys what is already around
 * the user. Phase 2 of the nearby-alerts feature; the tap popup + count
 * badge land in Phase 3. Renders nothing when the list is empty (e.g.
 * the layer toggle is off or no alert falls in the radius).
 *
 * @param {object} props
 * @param {Array<object>} props.alerts nearby alerts (each carries `geometry`)
 * @param {boolean} props.nightRed night-vision palette active (tiers collapse to the red family)
 * @param {boolean} props.dark dark-mode flag (light mode adds the dark casing; dark/nightRed skip it)
 * @returns {JSX.Element|null} the polygon layers, or null when the list is empty
 */
const NearbyAlertsOverlay = ({ alerts = NO_ALERTS, nightRed, dark = false }) => {
  if (!Array.isArray(alerts) || alerts.length === 0) return null;
  // Sort ascending by warning paint rank so the most important polygon is
  // inserted last and Leaflet paints it on top of anything it overlaps --
  // a Tornado Warning inside a Severe Thunderstorm Warning paints over
  // it, never under. Stable sort keeps the server's order within a rank.
  // Copy first -- never mutate the prop.
  const painted = [...alerts]
    .filter((a) => a && a.geometry && a.id)
    .sort((a, b) => warningPaintRank(a.eventType) - warningPaintRank(b.eventType));
  return (
    <>
      {painted.map((a) => {
        // Same stacked layers as the single-alert overlay (light-mode dark
        // casing under, coloured stroke + 15 % fill over) so radar reads
        // through and the solid border stays distinct from the dashed
        // radar/risk circles. Ascending-severity sort keeps the worst
        // alert's coloured stroke painting last.
        const layers = buildAlertPolygonLayers(a.eventType, nightRed, dark);
        return layers.map((ly, i) => (
          <GeoJSON key={`${a.id}-${i}`} data={a.geometry} style={() => ly} />
        ));
      })}
    </>
  );
};

NearbyAlertsOverlay.propTypes = {
  alerts: PropTypes.array,
  nightRed: PropTypes.bool,
  dark: PropTypes.bool,
};

/**
 * Content of the nearby-alerts tap popup (Phase 3b). Shows the subject of
 * each alert the tap landed in — source badge + severity chip + title —
 * and a single "Re-center here" action. Overlapping alerts are listed
 * worst-first (already server-sorted) under a count header. Deliberately
 * lightweight: the full description comes from re-centring, which moves
 * the location to the tapped point and re-activates the point-based
 * banner + GovAlertDetail.
 *
 * @param {object} props
 * @param {Array<object>} props.alerts the alerts under the tapped point
 * @param {() => void} props.onRecenter called when "Re-center here" is tapped
 * @returns {JSX.Element} popup content
 */
const SurveyAlertContent = ({ alerts = NO_ALERTS, onRecenter }) => {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || "en").slice(0, 2);
  return (
    <div className={styles.surveyPopup}>
      {alerts.length > 1 ? (
        <div className={styles.surveyHead}>{t("radar.nearbyHere", { count: alerts.length })}</div>
      ) : null}
      <div className={styles.surveyList}>
        {alerts.map((a) => (
          <div key={a.id} className={styles.surveyRow}>
            <SourceBadge source={a.source} />
            <SeverityChip severity={a.severity} />
            <span className={styles.surveyTitle}>{(lang === "fr" ? a.title_fr : a.title_en) || a.eventType}</span>
          </div>
        ))}
      </div>
      <button type="button" className={styles.surveyRecenter} onClick={onRecenter}>
        {t("controls.recenterHere")}
      </button>
    </div>
  );
};

SurveyAlertContent.propTypes = {
  alerts: PropTypes.array,
  onRecenter: PropTypes.func.isRequired,
};

/**
 * Weather map
 *
 * @param {object} props
 * @param {Number} props.zoom zoom level
 * @param {Boolean} [props.dark] dark mode
 * @returns {JSX.Element} Weather map
 */
const WeatherMap = ({ zoom, dark }) => {
  const MAP_CLICK_DEBOUNCE_TIME = 200; //ms
  // `nightRed` is the long-wavelength sleep-stage-1 mode. Used here
  // to red-tint the dashed radar circles so they match the rest of
  // the UI when the night-red palette is active. WeatherMap is mounted
  // by all three ambient layouts, so reading from useTimeOfDay keeps
  // the logic palette-aware without coupling to any one layout.
  const nightRed = useTimeOfDay() === "nightRed";
  // `i18n` feeds the ZoomControl remount key: react-leaflet only
  // forwards `position` updates to an existing control, so the +/-
  // titles would otherwise stay frozen in the mount-time language.
  const { t, i18n } = useTranslation();
  // Pixel width of the v3 right rail when visible. Drives the
  // off-centre projection trick that keeps the marker at the visual
  // centre of the non-rail area; see panWithRailOffset for the math.
  // Returns 0 when the rail doesn't overlay the map (LayoutPi /
  // LayoutMobile) or in full-screen radar focus mode.
  const railOffset = useRailOffset();
  const {
    setMapPosition,
    setPanToCoords,
    getMapApiKey,
    setCurrentMapZoom,
    setZoomToLevel,
    setRadarFrameTs,
    setDesktopRadarMaximized,
    setPiRadarMaximized,
    setHighlightedAlertId,
  } = useContext(AppActionsContext);
  const {
    mapApiKey,
    mobileRadarMaximized,
    desktopRadarMaximized,
    piRadarMaximized,
    piLayoutState,
    piScrubberOpen,
  } = useContext(SystemContext);
  const {
    browserGeo,
    mapGeo,
    mapTimezone,
    panToCoords,
  } = useContext(LocationContext);
  const {
    markerIsVisible,
    animateWeatherMap,
    radarSpeed,
    radarTimelineVisible,
    hideRadarLegend,
    lightModeStyle,
    darkModeStyle,
    radarOpacityLight,
    radarOpacityDark,
  } = useContext(UiPrefsContext);
  const {
    // Phase 4d (2026-05-28): id of the alert whose `geometry` is
    // overlaid on the map + the full govAlerts list for the lookup.
    // Consumed by the `<AlertGeometryOverlay>` child inside the
    // MapContainer below.
    highlightedAlertId,
    govAlerts,
    // Nearby-alerts overlay (Phase 2): the radius survey layer + its
    // user-set radius. Display-only — gated on showWeatherAlerts, OFF by
    // default until the Phase 3 dock toggle wires it up.
    showWeatherAlerts,
    showStormTracks,
    showLightning,
    radarNoiseFilter,
    showAlertRing,
    nearbyAlerts,
    alertRadiusKm,
  } = useContext(AlertsContext);
  const {
    currentMapZoom,
    zoomToLevel,
  } = useContext(RadarStateContext);

  // Clear the map-zone highlight when the alert it points at is no
  // longer displayable — turned off via the "Show advisory alerts"
  // opt-in, dismissed, or expired off the feed. Without this the
  // polygon strands on the map with no way to remove it: the only
  // "Hide zone" control lives in the alert detail, which is gone once
  // the alert stops showing. AlertDetailInline's own clear-on-collapse/
  // unmount cleanup (commit 8bf5cc6) misses this case because the
  // detail renders null internally instead of unmounting. Matching the
  // *eligible* set (not raw govAlerts) also covers dismissal + expiry
  // in one place.
  const { eligibleGovAlerts } = useEligibleGovAlerts();
  useEffect(() => {
    if (highlightedAlertId && !eligibleGovAlerts.some((a) => a.id === highlightedAlertId)) {
      setHighlightedAlertId(null);
    }
  }, [highlightedAlertId, eligibleGovAlerts, setHighlightedAlertId]);

  // Drawn radius for the nearby-alerts survey ring. This used to be
  // nudged outward when it coincided with one of the radar analysis
  // rings; those rings went with the RainViewer sampler, so the ring is
  // now simply drawn at its true radius.
  const alertRingMeters = alertRadiusKm * 1000;

  // Nearby-alerts tap popup (Phase 3b): { latlng: [lat, lon], alerts: [...] }
  // when the user tapped inside one or more survey polygons; null otherwise.
  const [surveyPopup, setSurveyPopup] = useState(null);
  // Holds the deferred-close timer id for the survey popup, so the
  // "Re-center here" close can be cancelled if the map unmounts first
  // (see handleSurveyRecenter for why the close is deferred).
  const recenterCloseTimerRef = useRef(null);

  const handleMapClick = useCallback((e) => {
    const { lat: latitude, lng: longitude } = e.latlng;
    // Nearby-alerts survey: if the layer is on and the tap landed inside
    // one or more alert polygons, open the survey popup there instead of
    // moving the location marker. nearbyAlerts is server-sorted worst-first.
    if (showWeatherAlerts && Array.isArray(nearbyAlerts) && nearbyAlerts.length) {
      const hit = nearbyAlerts.filter(
        (a) => a && a.geometry && pointInGeometry(latitude, longitude, a.geometry),
      );
      if (hit.length) {
        setSurveyPopup({ latlng: [latitude, longitude], alerts: hit });
        return;
      }
    }
    setSurveyPopup(null);
    setMapPosition({ latitude, longitude });
  }, [showWeatherAlerts, nearbyAlerts, setMapPosition]);

  // "Re-center here" — move the location to the tapped point (guaranteed
  // inside the tapped polygon(s)) so the existing point-based banner +
  // GovAlertDetail surface the full alert(s); then close the popup.
  //
  // The close is deferred to the next tick on purpose. Clearing the
  // popup synchronously here removes it from the DOM in the middle of
  // the originating click's propagation. Leaflet suppresses clicks that
  // land on a popup via a `_leaflet_disable_click` flag on the popup
  // container; once that container is gone, the same click reaches the
  // map, Leaflet fires a map `click`, and the debounced `handleMapClick`
  // re-opens a survey popup at the click point — so the popup appears to
  // "stick" after re-centering. Keeping it mounted until the click has
  // finished propagating lets Leaflet's own guard swallow the click
  // (this is exactly what Leaflet's built-in popup close button does via
  // DomEvent.stop). See incident_survey_popup_recenter_click_leak.md.
  const handleSurveyRecenter = useCallback(() => {
    if (surveyPopup) {
      setMapPosition({ latitude: surveyPopup.latlng[0], longitude: surveyPopup.latlng[1] });
      recenterCloseTimerRef.current = setTimeout(() => setSurveyPopup(null), 0);
    }
  }, [surveyPopup, setMapPosition]);

  // Cancel a pending deferred close if the map unmounts before it fires.
  useEffect(() => () => clearTimeout(recenterCloseTimerRef.current), []);

  const mapClickHandler = useMemo(
    () => debounce(handleMapClick, MAP_CLICK_DEBOUNCE_TIME),
    [handleMapClick]
  );


  // Small-screen detection used to auto-hide the radar legend while
  // the radar timeline is open. On the 7" Pi kiosk (height ≤ 520 px,
  // panel deployed) the timeline's right edge ends up sliding under
  // the legend's bottom-right block — the legend has higher z-index
  // (1000 vs 500) so it visually masks the rightmost portion of the
  // scrubber. Both elements are pinned to `bottom: 24px`, so there's
  // no clean way to keep them side by side at this width. Same media
  // query (max-height: 520px) used by the ambient SettingsPanel /
  // DebugPanel for their compact modes. NOTE: `ui/piLayout.js` gates
  // the Pi 3-state rail on (max-height: 540px) — a deliberately
  // separate threshold; don't unify the two.
  const SMALL_SCREEN_MQ = "(max-height: 520px)";
  const [isSmallScreen, setIsSmallScreen] = useState(
    () => typeof window !== "undefined" && window.matchMedia(SMALL_SCREEN_MQ).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(SMALL_SCREEN_MQ);
    const handler = (e) => setIsSmallScreen(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Narrow (phone-width) detection — mirrors AmbientLayers' mobile
  // breakpoint (< 800 px). Drives the timeline's compact copy (short
  // chips / frame counts): the height-based query above doesn't match
  // portrait phones, which are short on WIDTH instead.
  const NARROW_SCREEN_MQ = "(max-width: 799px)";
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_SCREEN_MQ).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_SCREEN_MQ);
    const handler = (e) => setIsNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // ── IEM two-layer radar ───────────────────────────────────────────
  // Active only when the user has selected the "iem" source. Two layers
  // answering two different questions:
  //
  //   mosaic     — national N0Q composite, wide-area situational
  //                awareness at low zoom. Frames come from IEM's fixed
  //                5-minute generation schedule, so they're computed
  //                locally with no discovery needed.
  //   single-site — super-res base reflectivity (N0B) from the covering
  //                NEXRAD, for detail near home at high zoom. Its scan
  //                times are irregular (4-6 min, VCP-dependent) and must
  //                be polled from the server.
  //
  // Both stay mounted across an overlap band and crossfade by zoom
  // rather than hard-swapping — the two products look different enough
  // that an instant cutover reads as a rendering glitch.
  const {
    site: iemSite,
    frames: iemSiteFrames,
    stale: iemStale,
    available: iemSiteAvailable,
  } = useIemRadarFrames({
    latitude: mapGeo ? mapGeo.latitude : null,
    longitude: mapGeo ? mapGeo.longitude : null,
    enabled: true,
  });

  // Mosaic frame list, recomputed whenever the single-site list
  // refreshes so both age displays advance together. The dependency on
  // `iemSiteFrames` is deliberate: it's the app's existing 60 s
  // heartbeat, and the mosaic offsets are cheap to rebuild.
  const iemMosaicFrames = useMemo(
    () => buildMosaicFrames(),
    [iemSiteFrames]  // eslint-disable-line react-hooks/exhaustive-deps -- iemSiteFrames is the intentional 60s recompute heartbeat
  );

  // Playhead for the IEM layers, kept separate from the RainViewer
  // `radarFrameIdx` above: the two sources have different frame counts
  // and cadences, so sharing one index would land on a wrong or
  // out-of-range frame when switching between them. -1 = latest.
  const [iemFrameIdx, setIemFrameIdx] = useState(-1);

  // Resolve the playhead against each layer independently. The two
  // lists are different lengths (11 mosaic offsets vs ~12 scans), so
  // the index is applied as a position from the END — "3 frames back"
  // means the same thing on both even when the counts differ, which
  // keeps the layers in step through the crossfade band.
  const iemFromEnd = iemFrameIdx < 0 ? 0 : Math.max(0, iemFrameIdx);
  const pickFromEnd = (list, back) => {
    if (!list || !list.length) return null;
    return list[Math.max(0, list.length - 1 - back)];
  };
  const currentMosaicFrame = pickFromEnd(iemMosaicFrames, iemFromEnd);
  const currentSiteFrame = pickFromEnd(iemSiteFrames, iemFromEnd);

  // Per-layer opacity for the zoom crossfade, scaled by the user's
  // radar-opacity preference so the fade never overrides their setting.
  const iemBaseOpacity = dark ? radarOpacityDark : radarOpacityLight;
  const iemOpacity = layerOpacities(currentMapZoom, iemBaseOpacity);

  // Mount gating comes from the same module as the opacity ramp, so a
  // layer is never mounted at opacity 0 (wasted tile fetches) nor
  // unmounted while the crossfade still wants to draw it (a gap in the
  // band). The single-site layer additionally needs a resolved site and
  // at least one discovered frame before it has anything to show.
  const iemVisible = layerVisibility(currentMapZoom);

  // Raw-radial layer (RadarScope-parity path). Enabled whenever the
  // single-site band is in view; the expensive render only happens when
  // a new volume scan actually arrives. Keyed on the same resolved site
  // as the tiles and storm tracks.
  const radial = useRadarRadial({
    site: iemSite,
    enabled: iemVisible.site && iemSiteAvailable && Boolean(iemSite),
    noiseFilter: radarNoiseFilter,
  });
  // The radial image replaces the site TILES only when it exists AND the
  // playhead is on the newest frame — the radial feed is latest-only, so
  // scrubbing back through history falls back to the timestamped tiles,
  // which is the honest picture for a historical frame.
  const radialShown = Boolean(radial.url) && iemFromEnd === 0 && iemVisible.site;

  const showIemSite = iemVisible.site
    && iemSiteAvailable
    && Boolean(iemSite)
    && Boolean(currentSiteFrame)
    && !radialShown;
  const showIemMosaic = iemVisible.mosaic
    && Boolean(currentMosaicFrame);

  // Which frames actually get a mounted TileLayer. With the timeline
  // open (scrubbing or playing), EVERY frame stays mounted and playback
  // just flips opacity between them — swapping one layer's URL (or
  // remounting it per frame, as this used to do) forces Leaflet to
  // refetch tiles on every step, which blanked the map between frames
  // and made storms pop in and out instead of moving. With all frames
  // mounted, each frame's tiles load once (first loop pass), then every
  // subsequent pass is an instant opacity flip. Hidden frames sit at
  // opacity 0 but still fetch on pan — that cost is confined to while
  // the timeline is open; closed, only the current frame is mounted,
  // exactly as before.
  //
  // The site stack deliberately ignores `radialShown`: when the playhead
  // crosses "latest" mid-loop the radial overlay takes over the PAINT
  // (the current tile frame drops to opacity 0 below), but the stack
  // must stay mounted or every pass through latest would unmount and
  // refetch all ~12 site layers — a guaranteed once-per-loop flicker.
  const mountedMosaicFrames = showIemMosaic
    ? (radarTimelineVisible ? iemMosaicFrames : [currentMosaicFrame])
    : [];
  const mountedSiteFrames = (iemVisible.site && iemSiteAvailable && Boolean(iemSite) && Boolean(currentSiteFrame))
    ? (radarTimelineVisible ? iemSiteFrames : (radialShown ? [] : [currentSiteFrame]))
    : [];

  // Which frame the age chip describes: whichever layer is currently
  // dominant. The single-site product (tiles OR the raw-radial image —
  // same volume scans, same timestamps) carries real scan-derived times;
  // the mosaic's schedule-derived time is marked approximate.
  const siteLayerDominant = (radialShown || showIemSite) && iemOpacity.site >= iemOpacity.mosaic;
  const iemAgeFrame = siteLayerDominant ? currentSiteFrame : currentMosaicFrame;
  const iemAgeIsApproximate = !siteLayerDominant;

  // Storm tracks reuse the NEXRAD site the frame poller already resolved,
  // so enabling the overlay costs no extra site lookup.
  const { cells: stormCells, mesos: stormMesos } = useStormTracks({
    site: iemSite,
    enabled: showStormTracks && Boolean(iemSite),
  });

  // GLM lightning, centred on the map position like the alert survey.
  const lightning = useLightning({
    latitude: mapGeo ? mapGeo.latitude : null,
    longitude: mapGeo ? mapGeo.longitude : null,
    enabled: showLightning && Boolean(mapGeo),
  });

  // Timeline-shaped view of the mosaic frames. RadarTimeline was built
  // against RainViewer's frame objects (`time` in UNIX *seconds*, plus a
  // past/nowcast `kind`), so adapting here reuses the whole scrubber —
  // labels, playhead, speed control — instead of duplicating it.
  //
  // The MOSAIC list is what the scrubber always drives, even at high
  // zoom where the single-site layer is the visible one: it's a stable
  // 11-frame fixed 5-minute grid that exists regardless of location,
  // whereas the scan list changes length as volume scans complete. A
  // scrubber whose track silently re-scaled under the user would be
  // worse than one that stays put; the single-site layer follows along
  // through the shared "frames from the end" offset.
  //
  // Every IEM frame is `kind: "past"` — NEXRAD products are observations,
  // and unlike RainViewer there is no nowcast to scrub forward into.
  const iemTimelineFrames = useMemo(
    () => iemMosaicFrames.map((f) => ({ time: Math.round(f.epoch / 1000), kind: "past" })),
    [iemMosaicFrames]
  );

  // The timeline hands back an absolute index into the list it was
  // given; the layers consume a from-the-end offset so the two
  // differently-sized frame lists stay aligned. One conversion point.
  const handleIemScrub = useCallback((idx) => {
    setIemFrameIdx(Math.max(0, iemMosaicFrames.length - 1 - idx));
  }, [iemMosaicFrames.length]);

  // Animation for the IEM layers, mirroring the RainViewer loop above:
  // walk the playhead from oldest to newest, then wrap. Frozen in the
  // Pi MAX view for the same reason — there the map is a ~190 px
  // decorative thumbnail and cycling tiles just burns the GPU.
  useEffect(() => {
    if (!animateWeatherMap || isPiMaxView(piLayoutState)) return undefined;
    if (!iemMosaicFrames.length) return undefined;
    const id = setInterval(() => {
      // Counts DOWN because the index is an offset from the newest
      // frame: the oldest frame is the largest offset, so stepping
      // toward 0 plays forward in time. Wraps back to the oldest.
      setIemFrameIdx((prev) => {
        const cur = prev < 0 ? 0 : prev;
        return cur <= 0 ? iemMosaicFrames.length - 1 : cur - 1;
      });
    }, MAP_CYCLE_RATE / radarSpeed);
    return () => clearInterval(id);
  }, [animateWeatherMap, radarSpeed, iemMosaicFrames.length, piLayoutState]);

  // Snap back to the newest frame whenever the scrubber is dismissed or
  // the source changes, so the user is never left parked on an old
  // frame with no visible control explaining why.
  useEffect(() => {
    if (!radarTimelineVisible) setIemFrameIdx(-1);
  }, [radarTimelineVisible]);

  // Publish the newest available frame time to RadarStateContext, which
  // is the app-wide radar-freshness signal (NowcastLine gates its
  // radar-anchored calm copy on it). Without this the value stays null
  // under the IEM source and NowcastLine reports "radar unavailable"
  // even though radar is displaying normally.
  //
  // Always the NEWEST frame, never the scrubbed one — this reports how
  // current the DATA is, which scrubbing back through history does not
  // change. The single-site list is preferred when present because its
  // timestamps are real scan times; the mosaic's are schedule-derived.
  useEffect(() => {
    const [newest] = (iemSiteFrames.length ? iemSiteFrames : iemMosaicFrames).slice(-1);
    setRadarFrameTs(newest ? newest.epoch : null);
  }, [iemSiteFrames, iemMosaicFrames, setRadarFrameTs]);

  // Risk levels for the dashed circles live in AppContext (see InfoPanel's
  // AlertBanner, which reads the same state to surface the alert text). We
  // only keep the polling logic here because it's gated by the same
  // conditions as the circles themselves.
  // Per-point intensities for colouring sampling-point dots stay local —
  // only the renderer below cares about them. Map keyed by `${dir}:${dist}`
  // so the dot lookup is O(1) regardless of how many points are visible.


  const getMapApiKeyCallback = useCallback(() => getMapApiKey(), [
    getMapApiKey,
  ]);

  useEffect(() => {
    getMapApiKeyCallback().catch((err) => {
      console.log("err!", err);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- initialization, runs once on mount

  // Browser geolocation seeds MapContainer's initial centre; mapGeo (the
  // user-selected point) drives everything after that.
  const { latitude, longitude } = browserGeo || {};

  // ── Referentially-stable props for the react-leaflet layers ─────────
  // react-leaflet v4 compares props by reference: a fresh array/object
  // every render triggers setLatLng/setStyle on the underlying Leaflet
  // layers even when the values are identical — at 1-4 Hz during radar
  // animation that's constant no-op SVG work on Pi hardware. These memos
  // pin the identities to the actual inputs. (Declared before the
  // early-return below — hooks must run unconditionally.)
  // Keyed on the coordinates, not the mapGeo object identity — pollers
  // may hand back fresh-but-equal objects.
  const markerLat = mapGeo ? mapGeo.latitude : null;
  const markerLon = mapGeo ? mapGeo.longitude : null;
  const markerPosition = useMemo(
    () => (markerLat != null && markerLon != null ? [markerLat, markerLon] : null),
    [markerLat, markerLon]
  );
  const radiusRingOptions = useMemo(
    () => buildRadiusRingOptions(dark, nightRed),
    [dark, nightRed]
  );
  if (!hasVal(latitude) || !hasVal(longitude) || !zoom || !mapApiKey) {
    return (
      <div className={`${styles.noMap} ${dark ? styles.dark : styles.light}`}>
        <div>Cannot retrieve map data.</div>
        <div>Did you enter an API key?</div>
      </div>
    );
  }

  // `withTimeline` re-anchors the legend/chip and the attribution strip
  // above the full-width timeline bar; without the bar they drop back
  // to the bottom edge (legend-without-timeline state). `withLegend`
  // does the mirror job for the MOBILE timeline: the design pins it at
  // 78px to clear the compact legend strip below, but with the legend
  // toggled off the strip isn't rendered and the bar must drop to the
  // bottom edge instead of floating over a hole (maintainer-reported;
  // the mock always showed the strip, so this combo wasn't specced).
  // v3.3 priority: the scrubber is a fullscreen-radar (MIN) tool, opened via the
  // ephemeral `piScrubberOpen` flag (the dock timeline button sets it + maximizes
  // to MIN) — never the shared persisted `radarTimelineVisible` pref, and never on
  // the cramped MID half-pane. Outside the priority model (desktop / mobile —
  // piLayoutState null or flag off) it falls back to the persisted pref exactly as
  // before. ONE boolean drives BOTH the wrapper padding AND the actual render
  // below, so they can't desync (no half-pane flash on a MIN→MID exit).
  const priorityActive = priorityViewsEnabled() && piLayoutState != null;
  const timelineShown = iemTimelineFrames.length > 0
    && (priorityActive
      ? (piLayoutState === "min" && piScrubberOpen)
      : (radarTimelineVisible && !isPiMaxView(piLayoutState)));
  // The legend's precipitation scale is QUALITATIVE — six segments
  // labelled only "Light" → "Extreme", with no numeric key. Its swatches
  // came from RainViewer's palette, but as a coarse low-to-high ramp it
  // reads correctly against the NEXRAD reflectivity colouring too (both
  // run cool → green → yellow → orange → red → magenta). If the legend
  // ever gains numeric dBZ labels, re-derive the swatches from the N0Q
  // colour table instead of inheriting them.
  const legendShown = !hideRadarLegend;

  return (
    <div className={`${styles.mapWrapper} ${timelineShown ? styles.withTimeline : ""} ${legendShown ? styles.withLegend : ""}`}>
      <MapContainer
        center={[latitude, longitude]}
        zoom={zoom}
        /* Raised 16 → 18 (2026-06) after the AppContext slice split:
         * the May-2026 step-function degradation (slowdown at z=11,
         * 1 s at z=13, 5-7 s at z=15, frozen white-screen at z=17 on
         * an M4 iPad Pro) turned out to be largely REACT-RENDER churn
         * — every zoom step re-rendered the whole app through the
         * monolithic context — which the split fixed (zoom now only
         * re-renders radar-slice consumers; field-confirmed smooth at
         * max zoom on the kiosk). The OTHER half of that incident was
         * Safari's tile-cache memory pressure, which is mitigated by
         * `keepBuffer: 2` + `updateWhenIdle` below (kept) — but NOT
         * eliminated: re-test a sustained z=9→18 zoom/pan on the
         * original iPad before any further raise toward 20. streets-
         * v12 has genuine building-level detail at 17-18. The radar
         * overlays keep their own tighter caps (z=12 — that one is a
         * DATA-resolution bound, not a perf cap; see below). */
        maxZoom={18}
        style={{ width: "100%", height: "100%" }}
        attributionControl={false}
        /* Default zoom control replaced by an explicit <ZoomControl>
         * below so the +/- titles go through i18n (v3.1 Phase 3 —
         * the 40 px restyle itself lives in ui/reset.css). */
        zoomControl={false}
        touchZoom={true}
        dragging={true}
        fadeAnimation={false}
      >
        {!isPiMaxView(piLayoutState) && (
          <ZoomControl
            key={`zoom-${i18n.language}`}
            position="topleft"
            zoomInTitle={t("radar.zoomIn", { defaultValue: "Zoom in" })}
            zoomOutTitle={t("radar.zoomOut", { defaultValue: "Zoom out" })}
          />
        )}
        <MapClickHandler onClick={mapClickHandler} />
        <PanHandler panToCoords={panToCoords} setPanToCoords={setPanToCoords} railOffset={railOffset} />
        <InitialOffsetCentering railOffset={railOffset} markerPosition={markerPosition} />
        <RailOffsetTracker railOffset={railOffset} markerPosition={markerPosition} />
        <MapZoomTracker onZoomChange={setCurrentMapZoom} />
        <ZoomLevelHandler zoomToLevel={zoomToLevel} setZoomToLevel={setZoomToLevel} />
        <ZoomAnchorOffset railOffset={railOffset} />
        <MapResizer
          mobileRadarMaximized={mobileRadarMaximized}
          desktopRadarMaximized={desktopRadarMaximized}
          piRadarMaximized={piRadarMaximized}
          piLayoutState={piLayoutState}
          latitude={latitude}
          longitude={longitude}
          zoom={zoom}
        />
        {/* RadarFocusControl moved OUT of the MapContainer with v3.1
         * Phase 3 — it's now a standalone overlay button (rendered
         * after the map alongside RadarLegend/RadarTimeline), no
         * longer a Leaflet bar control. */}
        {/* v2.14.66: the Ukrainian flag (added by Leaflet v1.9.3 as a
         * humanitarian gesture) stays visible in every palette except
         * nightRed — its yellow stripe disrupts the dark-red basemap.
         * Earlier (v2.14.65) we toggled the `prefix` prop with a
         * `key`, which forced a remount and duplicated the tile-
         * layer attribution strings on every palette switch. Replaced
         * the React-side toggle with a pure CSS rule that hides
         * `.leaflet-attribution-flag` only when `data-palette` on
         * `.ambientRoot` resolves to `nightRed`. See ui/reset.css.
         * No remount, no duplicated attributions. */}
        {/* bottomright since v3.1 Phase 3: the timeline is now a
         * full-width bottom bar, so the strip docks above its right
         * end (offset in styles.css, rail-aware). The legal Mapbox +
         * RainViewer attribution stays visible in every state —
         * including the mobile mini-card. */}
        <AttributionControl position="bottomright" />
        <TileLayer
          attribution={MAPBOX_ATTRIBUTION}
          url={`/api/tiles/${dark ? darkModeStyle : lightModeStyle}/{z}/{x}/{y}`}
          tileSize={512}
          zoomOffset={-1}
          maxZoom={18}
          /* `keepBuffer: 2` (Leaflet default, was 4 in v2.15.4) —
           * the wider buffer made zoom-out seamless on desktop but
           * doubled the resident tile count, which combined with
           * the 512px @2x tiles to balloon Safari iPad's tile-cache
           * memory at high zoom (the freeze trigger in May 2026
           * reports). 2 trades a brief white flash on rapid zoom-
           * out for ~half the memory footprint — acceptable since
           * the Mapbox tile proxy caches server-side and re-fetches
           * are essentially free. */
          keepBuffer={2}
          /* `updateWhenIdle: true` defers tile re-rendering until
           * the user finishes panning / zooming. Safari iOS's
           * default redraw-on-every-move was the dominant cost
           * during a sustained pan at z=14+: every touchmove
           * fired tile checks, transforms, and decode. Idle-mode
           * defers all that until the gesture ends. Lower CPU
           * on Pi kiosk too. */
          updateWhenIdle={true}
        />
        {/* ── Layer 1: composite mosaic (low zoom) ──────────────
          * IEM's national N0Q reflectivity mosaic — wide-area
          * situational awareness. Frames are addressed by fixed
          * 5-minute offsets baked into the layer name, so the
          * animation needs no frame discovery at all.
          *
          * TILE CONFIG IS DELIBERATELY NOT the RainViewer config
          * above. That one (tileSize 512 / zoomOffset -1) was tuned
          * for RainViewer's 512 px tiles; IEM serves 256 px tiles
          * (measured at every zoom 6-15), so carrying those props
          * over would put every tile at the wrong scale and offset.
          *
          * `maxNativeZoom` is a data-resolution choice rather than a
          * server limit — see the note in iemRadar.js. */}
        {mountedMosaicFrames.map((f) => (
          <TileLayer
            key={`iem-mosaic-${f.stamp}`}
            attribution={IEM_ATTRIBUTION}
            url={f.url}
            opacity={f.stamp === currentMosaicFrame.stamp ? iemOpacity.mosaic : 0}
            maxNativeZoom={MOSAIC_MAX_NATIVE_ZOOM}
            maxZoom={MOSAIC_MAX_ZOOM}
            updateWhenIdle={true}
            keepBuffer={2}
          />
        ))}
        {/* ── Layer 2: single-site super-res (high zoom) ────────
          * N0B base reflectivity from the covering NEXRAD: 0.5°
          * tilt at 0.25 km gates, native radial data rather than a
          * resampled mosaic — the same product RadarScope shows by
          * default. Coverage is 230 km from the site and fades at
          * the edges, which is fine for a fixed kiosk.
          *
          * The timestamp is a REAL scan time from the frame poller,
          * never the `-0` "latest" sentinel: `-0` would render but
          * gives no way to know how old the picture is, and making
          * frame age visible is the point of this work. */}
        {mountedSiteFrames.map((f) => (
          <TileLayer
            key={`iem-site-${iemSite}-${f.stamp}`}
            attribution={IEM_ATTRIBUTION}
            url={siteTileUrl(iemSite, f.stamp)}
            opacity={f.stamp === currentSiteFrame.stamp && !radialShown ? iemOpacity.site : 0}
            maxNativeZoom={SITE_MAX_NATIVE_ZOOM}
            minZoom={SITE_MIN_ZOOM}
            updateWhenIdle={true}
            keepBuffer={2}
          />
        ))}
        {/* Raw-radial layer — the actual super-res picture, rendered
            client-side from N0B radial data instead of IEM's pre-smoothed
            tiles (see radialRender.js). Lives in its own pane between the
            tile pane (z200) and the vector overlay pane (z400): above the
            basemap and any radar tiles, below alert polygons and storm
            tracks. The `key` on the overlay forces a remount when the
            image URL changes — ImageOverlay's url prop update path can
            leave the old bitmap up briefly, and a scan boundary should
            swap atomically. */}
        <Pane name="radialPane" style={{ zIndex: 250 }}>
          {/* Mounted whenever an image exists and the band is in view —
              NOT only when `radialShown` — so a playing loop passing
              through the historical frames merely hides it (opacity 0)
              instead of unmounting it and re-decoding the bitmap every
              time the playhead returns to "latest". */}
          {Boolean(radial.url) && iemVisible.site ? (
            <ImageOverlay
              key={radial.url}
              url={radial.url}
              bounds={radial.bounds}
              opacity={radialShown ? iemOpacity.site : 0}
            />
          ) : null}
        </Pane>
      {markerIsVisible && markerPosition ? (
          /* v2.14.65: custom target icon only in nightRed mode. In every
           * other palette the default Leaflet blue teardrop pin stays —
           * it's a familiar map idiom and reads cleanly on the day /
           * dusk / night basemaps. nightRed is the one palette where
           * a bright blue clashes hard with the deep-red background,
           * so we swap to the palette-aware target marker there. The
           * `key` forces the marker DOM to be recreated when nightRed
           * flips so Leaflet picks up the new icon. */
          nightRed ? (
            <Marker
              key="target"
              position={markerPosition}
              icon={LOCATION_MARKER_ICON}
              opacity={1}
            />
          ) : (
            <Marker
              key="default"
              position={markerPosition}
              opacity={0.65}
            />
          )
        ) : null}
        {/* Nearby-alerts radius ring (Phase 2) — the user's survey extent,
            persistent while the layer is on. A cool-blue dotted circle
            (red dash-dot in nightRed) kept distinct from the radar risk
            rings. Hidden when zoomed in past the radar rings' threshold,
            same as them, since a 50-100 km circle is off-screen there.
            Independently gated on showAlertRing: a user can keep the alert
            polygons while hiding the ring (the ring is a round proxy for the
            survey radius; the polygon is the alert's real geometry). */}
        {showWeatherAlerts && showAlertRing && markerPosition && currentMapZoom < RING_HIDE_ZOOM ? (
          <Circle
            center={markerPosition}
            radius={alertRingMeters}
            pathOptions={radiusRingOptions}
          />
        ) : null}
        {/* Phase 4d (2026-05-28): polygon overlay of the alert zone
          * the user picked via the AlertBanner "Voir sur la carte"
          * button. Renders nothing when highlightedAlertId is null
          * or the matching alert has no geometry. The component
          * fitBounds-zooms on mount via useMap so the polygon is
          * actually visible after the user taps. */}
        <AlertGeometryOverlay
          highlightedAlertId={highlightedAlertId}
          govAlerts={govAlerts}
          nightRed={nightRed}
          dark={dark}
        />
        {/* Nearby-alerts survey polygons (Phase 2) — every active alert
            within the radius, painted tier-coloured. Display-only; gated
            on the layer toggle (OFF by default until the Phase 3 dock
            button). Never moves the map. */}
        {showWeatherAlerts ? <NearbyAlertsOverlay alerts={nearbyAlerts} nightRed={nightRed} dark={dark} /> : null}
        {/* Storm tracks (NEXRAD Level III STI) — inserted AFTER the alert
            polygons on purpose. Leaflet paints later-inserted vector layers
            on top, and a filled warning polygon would otherwise bury the
            thin dashed track running through it. */}
        {showStormTracks ? (
          <StormTracks cells={stormCells} mesos={stormMesos} dark={dark} nightRed={nightRed} />
        ) : null}
        {/* GLM lightning flashes -- age-faded dots, painted last so the
            freshest strikes read over every other overlay. */}
        {showLightning ? (
          <LightningOverlay
            flashes={lightning.flashes}
            fetchedAt={lightning.fetchedAt}
            dark={dark}
            nightRed={nightRed}
          />
        ) : null}
        {/* Survey tap popup (Phase 3b): opens at the tapped point when it
            landed inside one or more alert polygons. Lightweight subject +
            a single "Re-center here" that re-activates the point-based path. */}
        {showWeatherAlerts && surveyPopup ? (
          <Popup
            position={surveyPopup.latlng}
            className={styles.surveyPopupWrapper}
            eventHandlers={{ remove: () => setSurveyPopup(null) }}
          >
            <SurveyAlertContent alerts={surveyPopup.alerts} onRecenter={handleSurveyRecenter} />
          </Popup>
        ) : null}
      </MapContainer>
      {/* Radar-focus toggle — standalone overlay button under the zoom
          stack (v3.1 Phase 3; formerly a Leaflet bar control inside the
          MapContainer). Rendered when LayoutDesktop OR LayoutPi is the
          active layout (one of the two sentinels is non-null); tapping
          it hides HeroBand + rail so the radar fills the viewport, and
          a short toast confirms the toggle. LayoutMobile has its own
          maximize button on the inset card (same icon pair). */}
      {!isPiMaxView(piLayoutState)
        && ((desktopRadarMaximized !== null && desktopRadarMaximized !== undefined)
        || (piRadarMaximized !== null && piRadarMaximized !== undefined)) && (
        <RadarFocusControl
          active={Boolean(piRadarMaximized != null ? piRadarMaximized : desktopRadarMaximized)}
          onToggle={() => {
            if (piRadarMaximized != null) {
              setPiRadarMaximized(!piRadarMaximized);
            } else {
              setDesktopRadarMaximized(!desktopRadarMaximized);
            }
          }}
          titleOn={t("controls.restorePanels", { defaultValue: "Restore panels" })}
          titleOff={t("controls.focusRadar", { defaultValue: "Focus radar" })}
        />
      )}
      {/* Frame-age chip — the freshness surface. Radar that is quietly
          15 min behind looks exactly like current radar, and some of
          that lag is irreducible (a NEXRAD volume scan needs 4-6 min to
          complete before any product exists), so the age is shown
          rather than hidden. IEM-only for now: RainViewer's timeline
          already carries its own relative-time chip, and ECCC exposes
          no frame timestamp to report. */}
      {!isPiMaxView(piLayoutState) && iemAgeFrame && (
        <RadarFrameAge
          epoch={iemAgeFrame.epoch}
          approximate={iemAgeIsApproximate}
          sourceStale={iemStale}
          site={showIemSite ? iemSite : null}
          dark={dark}
        />
      )}
      {/* Legend + timeline serve both reflectivity sources (RainViewer
          and IEM); the legend's dBZ colour ramp describes either. Hidden
          when radarSource is ECCC — that's a precipitation-RATE product
          on a different scale, and its WMS exposes no time dimension to
          scrub.

          Short screens (≤ 520 px height) with the timeline open get the
          legend as a compact "(i)" chip instead of the card — the Q5
          mutual-exclusion rule from the Phase 3 design: both can't fit
          in the 7" kiosk's vertical budget, but the legend stays one
          tap away instead of vanishing. */}
      {legendShown && !isPiMaxView(piLayoutState) && (
        <RadarLegend dark={dark} chipMode={radarTimelineVisible && isSmallScreen} lightningCount={showLightning ? lightning.count : null} />
      )}
      {timelineShown && (
        <RadarTimeline
          frames={iemTimelineFrames}
          currentIdx={Math.max(0, iemTimelineFrames.length - 1 - iemFromEnd)}
          onScrub={handleIemScrub}
          timezone={mapTimezone}
          dark={dark}
          compact={isSmallScreen || isNarrow}
          sourceStale={iemStale}
          sourceName="NEXRAD"
        />
      )}
    </div>
  );
};

WeatherMap.propTypes = {
  zoom: PropTypes.number.isRequired,
  dark: PropTypes.bool,
};


export default WeatherMap;
