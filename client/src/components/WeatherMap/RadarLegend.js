import React, { useContext, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";

import { AlertsContext, UiPrefsContext } from "~/AppContext";
import { CloseIcon } from "./icons";
import styles from "./styles.css";

import { colorForDbz, colorForVelocity, colorForCorrelation } from "./radialRender";
import { GROUPS as PTYPE_GROUPS, colorForGate, encodeGate } from "../../../../server/precipType";

// Tiers sampled for each precipitation-type ramp in the legend: 7.5 to
// 62.5 dBZ mid-points, light → heavy, from the same table the map uses.
const PTYPE_TIERS = [2, 4, 6, 8, 10, 13];
// Mid-intensity swatch for the compact strip / chip key.
const PTYPE_STRIP_TIER = 7;

const rgba = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;

// Warning-family rows, RadarScope convention (the map overlay is
// warnings-only and coloured by event type): tornado red, severe
// thunderstorm yellow, flash flood green. Swatches are backed by the
// --rc-warn-* vars, which nightRed overrides to the red family.
const WARNING_KEY = [
  { swatch: "alertTierSwatchTor", key: "legendTornado" },
  { swatch: "alertTierSwatchSvr", key: "legendStorm" },
  { swatch: "alertTierSwatchFfw", key: "legendFlood" },
];

// The reflectivity bar samples the active palette every 5 dBZ from 0 to
// 75, so the "0 · 20 · 40 · 60 · 75" labels under it line up whichever
// palette is on (the RadarScope-style table starts at −30, the NWS one at 0).
const SCALE_DBZ = Array.from({ length: 16 }, (_, i) => i * 5);

/**
 * 16-segment reflectivity colour bar in the active palette.
 *
 * @param {object} props
 * @param {string} props.palette reflectivity palette id
 * @returns {JSX.Element} Scale bar
 */
const PrecipScale = ({ palette }) => (
  <span className={styles.precipScale} aria-hidden="true">
    {SCALE_DBZ.map((dbz) => {
      const [r, g, b] = colorForDbz(dbz, palette);
      return <span key={dbz} style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }} />;
    })}
  </span>
);

PrecipScale.propTypes = { palette: PropTypes.string };

/**
 * Precipitation-type ramps, one row per group (rain, snow, mix, graupel,
 * hail), each shaded light → heavy exactly as the map colours them.
 *
 * @returns {JSX.Element} Rows of swatch ramps with labels
 */
const PrecipTypeRows = () => {
  const { t } = useTranslation();
  return (
    <div className={styles.ptypeRows}>
      {PTYPE_GROUPS.map((g) => (
        <span key={g.key} className={styles.ptypeRow}>
          <span className={styles.ptypeRamp} aria-hidden="true">
            {PTYPE_TIERS.map((tier) => (
              <span key={tier} style={{ backgroundColor: rgba(colorForGate(encodeGate(g.sampleClass, tier))) }} />
            ))}
          </span>
          {t(`radar.ptype${g.key.charAt(0).toUpperCase()}${g.key.slice(1)}`)}
        </span>
      ))}
    </div>
  );
};

/**
 * One swatch per precipitation-type group — the compact key for the chip
 * and the mobile strip while the mode is on.
 *
 * @returns {JSX.Element} Scale bar
 */
const PrecipTypeScale = () => (
  <span className={styles.precipScale} aria-hidden="true">
    {PTYPE_GROUPS.map((g) => (
      <span key={g.key} style={{ backgroundColor: rgba(colorForGate(encodeGate(g.sampleClass, PTYPE_STRIP_TIER))) }} />
    ))}
  </span>
);

// Velocity bar: −64 … +64 m/s in 8 m/s steps (17 swatches, zero centred).
const VEL_SCALE_MS = Array.from({ length: 17 }, (_, i) => -64 + i * 8);
// Correlation bar: 0.2 … 1.05 sampled where the ramp changes.
const CC_SCALE = [0.2, 0.35, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99, 1.0, 1.05];

/**
 * Velocity colour bar in the active palette — toward the radar on the
 * left (greens), away on the right (reds).
 *
 * @param {object} props
 * @param {string} props.palette palette id
 * @returns {JSX.Element} Scale bar
 */
const VelocityScale = ({ palette }) => (
  <span className={styles.precipScale} aria-hidden="true">
    {VEL_SCALE_MS.map((v) => {
      const [r, g, b] = colorForVelocity(v, palette);
      return <span key={v} style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }} />;
    })}
  </span>
);

VelocityScale.propTypes = { palette: PropTypes.string };

/**
 * Correlation-coefficient colour bar (CC_STOPS in radialRender.js).
 *
 * @returns {JSX.Element} Scale bar
 */
const CorrelationScale = () => (
  <span className={styles.precipScale} aria-hidden="true">
    {CC_SCALE.map((cc) => {
      const [r, g, b] = colorForCorrelation(cc);
      return <span key={cc} style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }} />;
    })}
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
 * @param {number|null} [props.lightningCount] GLM flash count for the lightning section (null hides it)
 * @param {boolean} [props.velocity] Show the base-velocity colour bar (velocity mode on, site layer in view)
 * @param {boolean} [props.correlation] Show the correlation-coefficient bar (CC mode on, site layer in view)
 * @param {boolean} [props.correlationUnavailable] CC mode on but this radar publishes no N0C
 * @param {boolean|null} [props.cleanApplied] Dual-pol clean: true applied, false the scan had no classification, null not asked for
 * @param {boolean} [props.holdingClean] The frame on screen is an older CLEAN scan, held because the newest one has no classification yet
 * @param {object|null} [props.precip] Precipitation-type mode state, null when the mode is off: `siteInView` (single-site band showing), `siteUnavailable` (this radar publishes no classification), `mosaicInView`, `historyHidden` (playhead on a past frame, so the type mosaic is hidden)
 * @returns {JSX.Element} Legend overlay
 */
const RadarLegend = ({
  dark, chipMode, lightningCount = null, velocity = false,
  correlation = false, correlationUnavailable = false,
  cleanApplied = null, holdingClean = false, precip = null,
}) => {
  const { t } = useTranslation();
  const {
    showWeatherAlerts,
    nearbyAlerts,
    nearbyResidualCount,
    alertRadiusKm,
    radarNoiseMode,
    radarPalette,
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

  // Which source is drawing the precipitation type right now, and any
  // reason it is not: the radar's own classification is a verdict ALOFT
  // (the 0.5° beam), MRMS's a surface one, and the two can disagree in a
  // melting layer — the legend says which one the colours mean.
  let precipNote = null;
  if (precip) {
    if (precip.siteInView) {
      precipNote = precip.siteUnavailable ? "radar.legendPtypeUnavailable" : "radar.legendPtypeSite";
    } else if (precip.mosaicInView) {
      precipNote = "radar.legendPtypeMosaic";
    }
  }

  const sections = (
    <>
      {precip ? (
        <div className={styles.legendSection}>
          <div className={styles.legendTitle}>{t("radar.legendPrecipType")}</div>
          <PrecipTypeRows />
          <div className={styles.scaleLabels}>
            <span>{t("radar.ptypeLight")}</span>
            <span>{t("radar.ptypeHeavy")}</span>
          </div>
          {precipNote ? <div className={styles.alertCount}>{t(precipNote)}</div> : null}
          {precip.historyHidden ? <div className={styles.alertCount}>{t("radar.legendPtypeNoHistory")}</div> : null}
        </div>
      ) : (
        <div className={styles.legendSection}>
          <div className={styles.legendTitle}>{t("radar.legendPrecip")}</div>
          <PrecipScale palette={radarPalette} />
          <div className={styles.scaleLabels}>
            <span>0</span>
            <span>20</span>
            <span>40</span>
            <span>60</span>
            <span>75 dBZ</span>
          </div>
          {/* Dual-pol clean is the one filter setting that can be on and
            * doing nothing — the mask needs the scan's classification, and
            * not every scan has one published. Say which, here, where the
            * question "what am I looking at" is already being answered —
            * but only while a raw-radial frame the mask applies to is what
            * is drawn (`cleanApplied` is null at mosaic zoom and for
            * velocity), so the line never describes a picture the mask
            * never touched. */}
          {radarNoiseMode === "clean" && cleanApplied !== null ? (
            <div className={styles.alertCount}>
              {t(cleanApplied === false
                ? "radar.legendCleanUnavailable"
                : (holdingClean ? "radar.legendCleanHolding" : "radar.legendClean"))}
            </div>
          ) : null}
        </div>
      )}
      {velocity ? (
        <div className={styles.legendSection}>
          <div className={styles.legendTitle}>{t("radar.legendVelocity")}</div>
          <VelocityScale palette={radarPalette} />
          <div className={styles.scaleLabels}>
            <span>{t("radar.legendToward")}</span>
            <span>0</span>
            <span>{t("radar.legendAway")}</span>
          </div>
        </div>
      ) : null}
      {correlation ? (
        <div className={styles.legendSection}>
          <div className={styles.legendTitle}>{t("radar.legendCorrelation")}</div>
          <CorrelationScale />
          <div className={styles.scaleLabels}>
            <span>0.2</span>
            <span>0.7</span>
            <span>0.9</span>
            <span>1.0</span>
          </div>
          <div className={styles.alertCount}>
            {t(correlationUnavailable ? "radar.legendCorrelationUnavailable" : "radar.legendCorrelationNote")}
          </div>
        </div>
      ) : null}
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
          {precip ? <PrecipTypeScale /> : <PrecipScale palette={radarPalette} />}
          {t("radar.legendTitle")}
        </button>
      ) : (
        <div className={`${styles.radarLegend} ${variantClass}`}>
          {sections}
        </div>
      )}
      <div className={styles.legendMobileStrip}>
        {precip ? <PrecipTypeScale /> : <PrecipScale palette={radarPalette} />}
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
  cleanApplied: PropTypes.bool,
  holdingClean: PropTypes.bool,
  precip: PropTypes.shape({
    siteInView: PropTypes.bool,
    siteUnavailable: PropTypes.bool,
    mosaicInView: PropTypes.bool,
    historyHidden: PropTypes.bool,
  }),
  dark: PropTypes.bool,
  chipMode: PropTypes.bool,
  lightningCount: PropTypes.number,
  velocity: PropTypes.bool,
  correlation: PropTypes.bool,
  correlationUnavailable: PropTypes.bool,
};

export default RadarLegend;
