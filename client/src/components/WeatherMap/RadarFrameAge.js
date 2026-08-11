import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";

import { frameAge } from "./iemRadar";
import styles from "./styles.css";

// How often the displayed age re-computes. The frame list only refreshes
// every 60 s, but the age has to keep counting up between refreshes —
// otherwise a stalled poller would show a permanently "2 min" old frame,
// which is precisely the failure this indicator exists to expose.
const TICK_MS = 15 * 1000;

// Explicit level → class map. css-loader is configured with
// `exportLocalsConvention: "camelCase"`, so `.frame-age-fresh` is
// exported as `frameAgeFresh` — a computed `styles[`frameAge-${level}`]`
// would silently resolve to undefined and drop the colour entirely.
const LEVEL_CLASS = {
  fresh: styles.frameAgeFresh,
  aging: styles.frameAgeAging,
  stale: styles.frameAgeStale,
};

/**
 * Frame-age chip for the radar overlay.
 *
 * The motivating problem: radar that is quietly ~15 min behind looks
 * identical to radar that is current. Some of that lag is irreducible —
 * a NEXRAD volume scan takes 4-6 min to complete before any product
 * exists, and mosaicking adds more — so the fix isn't only a fresher
 * source, it's making the age *visible* so staleness is a fact on screen
 * rather than a suspicion.
 *
 * Three states, from `frameAge`:
 *   fresh (< 6 min)  — as current as NEXRAD physically gets
 *   aging (6-12 min) — past a normal scan interval, worth noticing
 *   stale (12 min+)  — something upstream is wrong; don't trust the picture
 *
 * `approximate` marks the composite mosaic, whose frame times come from
 * IEM's fixed 5-min generation schedule rather than from a specific
 * volume scan — accurate to the schedule, not to the radar, so the
 * value is prefixed with a "~".
 *
 * @param {object} props
 * @param {Number|null} props.epoch timestamp of the displayed frame (epoch ms)
 * @param {Boolean} [props.approximate] frame time is schedule-derived (mosaic layer)
 * @param {Boolean} [props.sourceStale] the frame-list refresh itself is failing
 * @param {String} [props.site] NEXRAD site id shown alongside, when single-site is active
 * @param {Boolean} [props.dark] dark palette active
 * @returns {JSX.Element|null} the chip, or null when there's no frame to describe
 */
const RadarFrameAge = ({ epoch, approximate = false, sourceStale = false, site = null, dark = false }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const { ageMinutes, level } = frameAge(epoch, now);
  if (level === "unknown") return null;

  // A failing refresh is reported at least as severely as the raw age:
  // the list may still be young enough to read "fresh" on the first
  // failed poll, but the user should already know it stopped updating.
  const effectiveLevel = sourceStale && level === "fresh" ? "aging" : level;

  // i18next plural forms live in the locale files as ageMinutes_one /
  // ageMinutes_other (the project's convention — see solarEventIn_*).
  const label = ageMinutes < 1
    ? t("radar.ageNow")
    : t("radar.ageMinutes", { count: ageMinutes });

  return (
    <div
      className={[
        styles.frameAge,
        LEVEL_CLASS[effectiveLevel],
        dark ? styles.frameAgeDark : styles.frameAgeLight,
      ].filter(Boolean).join(" ")}
      /* aria-live so a screen reader announces the transition into a
       * stale state — the colour change alone is not perceivable to
       * every user, and staleness is the safety-relevant signal here. */
      aria-live="polite"
      title={sourceStale ? t("radar.ageRefreshFailing") : undefined}
    >
      {site ? <span className={styles.frameAgeSite}>{site}</span> : null}
      <span className={styles.frameAgeDot} aria-hidden="true" />
      <span className={styles.frameAgeValue}>
        {approximate && ageMinutes >= 1 ? "~" : ""}{label}
      </span>
      {sourceStale ? <span className={styles.frameAgeWarn} aria-hidden="true">!</span> : null}
    </div>
  );
};

RadarFrameAge.propTypes = {
  epoch: PropTypes.number,
  approximate: PropTypes.bool,
  sourceStale: PropTypes.bool,
  site: PropTypes.string,
  dark: PropTypes.bool,
};

export default RadarFrameAge;
