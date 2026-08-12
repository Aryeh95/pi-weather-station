import React, { useContext, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";

import { AlertsContext, UiPrefsContext } from "~/AppContext";
import { CloseIcon } from "./icons";
import styles from "./styles.css";

// Tile-scale segment classes t1…t6 — backed by the --rc-tile-* tokens
// (the EXACT RainViewer colour-scheme-6 palette the tiles ship with,
// fixed across all four palettes — see styles.css).
const TILE_SEGMENTS = ["t1", "t2", "t3", "t4", "t5", "t6"];

// Warning-family rows, RadarScope convention (the map overlay is
// warnings-only and coloured by event type): tornado red, severe
// thunderstorm yellow, flash flood green. Swatches are backed by the
// --rc-warn-* vars, which nightRed overrides to the red family.
const WARNING_KEY = [
  { swatch: "alertTierSwatchTor", key: "legendTornado" },
  { swatch: "alertTierSwatchSvr", key: "legendStorm" },
  { swatch: "alertTierSwatchFfw", key: "legendFlood" },
];

/**
 * Six-segment precipitation colour bar — the real tile palette.
 *
 * @returns {JSX.Element} Scale bar
 */
const PrecipScale = () => (
  <span className={styles.precipScale} aria-hidden="true">
    {TILE_SEGMENTS.map((seg) => (
      <span key={seg} className={styles[seg]} />
    ))}
  </span>
);

/**
 * Radar map legend (v3.1 Phase 3, Claude Design v2.1). Three sections:
 * (the analysis-radii section was removed with the rings — unit- and
 * extended-radius-aware), the precipitation scale (the real 6-colour
 * tile palette), and the nearby-alert tier key + honest in-radius
 * count (only when the alert overlay is on).
 *
 * Three presentations, one component:
 *  - card (default) — bottom-left, glanceable, non-interactive;
 *  - chip (`chipMode`, 7" kiosk with the timeline open) — the Q5
 *    mutual-exclusion rule: a compact "(i) Légende" pill that opens
 *    the full legend as an overlay;
 *  - mobile strip — full-width compact bar, CSS-gated to the ambient
 *    mobile layout, whose (i) opens the same overlay as a bottom sheet.
 *
 * The overlay dismisses via scrim tap, the ✕ button, or Escape.
 *
 * @param {object} props
 * @param {boolean} props.dark Dark-palette variant
 * @param {boolean} props.chipMode Render the compact chip instead of the card (short screens with the timeline open)
 * @returns {JSX.Element} Legend overlay
 */
const RadarLegend = ({ dark, chipMode, lightningCount = null }) => {
  const { t } = useTranslation();
  const {
    showWeatherAlerts,
    nearbyAlerts,
    nearbyResidualCount,
    alertRadiusKm,
  } = useContext(AlertsContext);
  const { distanceUnit } = useContext(UiPrefsContext);
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Escape closes the overlay — keyboard parity with the scrim/✕
  // (the DetailsPopover pattern elsewhere in the ambient tree).
  useEffect(() => {
    if (!overlayOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOverlayOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlayOpen]);

  const nearbyCount = Array.isArray(nearbyAlerts) ? nearbyAlerts.length : 0;
  // The alert-search radius is km-native — in miles mode it converts
  // (100 km → "62 mi").
  const radiusDisplay = distanceUnit === "mi" ? Math.round(alertRadiusKm / 1.609344) : alertRadiusKm;
  const unitLabel = distanceUnit === "mi" ? "mi" : "km";

  // Variant class on the CARD ONLY. The chip/strip/sheet must NOT carry
  // it: LayoutMobile's mini-card rules match the unhashed
  // `radar-legend-dark/light` substrings to hide the card, and routing
  // the other presentations through the same matcher put them at the
  // mercy of the maximized-state restore rules (review finding — the
  // card resurrected over the strip). They style their own colours
  // from the ambient tokens and have dedicated LayoutMobile rules.
  const variantClass = dark ? styles.radarLegendDark : styles.radarLegendLight;

  const sections = (
    <>
      <div className={styles.legendSection}>
        <div className={styles.legendTitle}>{t("radar.legendPrecip")}</div>
        <PrecipScale />
        <div className={styles.scaleLabels}>
          <span>{t("radar.light")}</span>
          <span>{t("radar.extreme")}</span>
        </div>
      </div>
      {lightningCount != null ? (
        <div className={styles.legendSection}>
          <div className={styles.legendTitle}>{t("radar.legendLightning")}</div>
          <div className={styles.alertCount}>
            {t("radar.lightningCount", { count: lightningCount })}
          </div>
        </div>
      ) : null}
      {showWeatherAlerts ? (
        <div className={styles.legendSection}>
          <div className={styles.legendTitle}>{t("radar.nearbyTitle")}</div>
          <div className={styles.alertTiers}>
            {WARNING_KEY.map(({ swatch, key }) => (
              <span key={key} className={styles.alertTier}>
                <i className={`${styles.alertTierSwatch} ${styles[swatch]}`} />
                {t(`radar.${key}`)}
              </span>
            ))}
          </div>
          <div className={styles.alertCount}>
            {t("radar.nearbyWithin", { count: nearbyCount, radius: radiusDisplay, unit: unitLabel })}
            {nearbyResidualCount > 0 ? (
              <span className={styles.alertCountMore}>
                {" · "}
                {t("radar.nearbyNotMapped", { count: nearbyResidualCount })}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <>
      {chipMode ? (
        <button
          type="button"
          className={styles.legendChip}
          onClick={() => setOverlayOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={overlayOpen}
          title={t("radar.legendOpen")}
        >
          <span className={styles.legendChipI} aria-hidden="true">i</span>
          <PrecipScale />
          {t("radar.legendTitle")}
        </button>
      ) : (
        <div className={`${styles.radarLegend} ${variantClass}`}>
          {sections}
        </div>
      )}
      <div className={styles.legendMobileStrip}>
        <PrecipScale />
        {showWeatherAlerts && nearbyCount > 0 ? (
          <span className={styles.legendMobileAlert}>
            <svg viewBox="0 0 18 16" aria-hidden="true">
              <path d="M9 1 L17 15 H1 Z" fill="currentColor" />
            </svg>
            {nearbyCount}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.legendInfoBtn}
          onClick={() => setOverlayOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={overlayOpen}
          aria-label={t("radar.legendOpen")}
          title={t("radar.legendOpen")}
        >
          i
        </button>
      </div>
      {overlayOpen ? (
        <div className={styles.legendOverlay} role="dialog" aria-modal="true" aria-label={t("radar.legendTitle")}>
          <button
            type="button"
            className={styles.legendOverlayScrim}
            onClick={() => setOverlayOpen(false)}
            aria-label={t("radar.legendClose")}
            tabIndex={-1}
          />
          <div className={styles.legendOverlaySheet}>
            <div className={styles.legendOverlayHead}>
              <span className={styles.legendOverlayTitle}>{t("radar.legendTitle")}</span>
              <button
                type="button"
                className={styles.legendOverlayClose}
                onClick={() => setOverlayOpen(false)}
                aria-label={t("radar.legendClose")}
                title={t("radar.legendClose")}
              >
                <CloseIcon />
              </button>
            </div>
            {sections}
          </div>
        </div>
      ) : null}
    </>
  );
};

RadarLegend.propTypes = {
  dark: PropTypes.bool,
  chipMode: PropTypes.bool,
  lightningCount: PropTypes.number,
};

export default RadarLegend;
