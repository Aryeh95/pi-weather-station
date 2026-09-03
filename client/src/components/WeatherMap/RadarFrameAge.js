import React, { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";

import { frameAge } from "./iemRadar";
import styles from "./styles.css";

// How often the displayed ages re-compute. The pollers only refresh every
// 60 s, but the age has to keep counting up between refreshes —
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
 * One row of the age stack.
 *
 * @param {object} props
 * @param {String} props.label short layer name (site id, "Mosaic", "Tracks", "GLM")
 * @param {Number|null} props.epoch data time of what that layer shows (epoch ms)
 * @param {Boolean} props.approximate time is schedule-derived, not reported
 * @param {Boolean} props.sourceStale that layer's refresh is failing
 * @param {Number} props.now current epoch ms (shared tick)
 * @returns {JSX.Element|null} the row, or null when there is no time to describe
 */
const AgeRow = ({ label, epoch, approximate, sourceStale, now }) => {
  const { t } = useTranslation();
  const { ageMinutes, level } = frameAge(epoch, now);
  if (level === "unknown") return null;

  // A failing refresh is reported at least as severely as the raw age:
  // the data may still be young enough to read "fresh" on the first
  // failed poll, but the user should already know it stopped updating.
  const effectiveLevel = sourceStale && level === "fresh" ? "aging" : level;

  // i18next plural forms live in the locale files as ageMinutes_one /
  // ageMinutes_other (the project's convention — see solarEventIn_*).
  const text = ageMinutes < 1
    ? t("radar.ageNow")
    : t("radar.ageMinutes", { count: ageMinutes });

  return (
    <div
      className={[styles.frameAgeRow, LEVEL_CLASS[effectiveLevel]].filter(Boolean).join(" ")}
      title={sourceStale ? t("radar.ageRefreshFailing") : undefined}
    >
      {label ? <span className={styles.frameAgeSite}>{label}</span> : null}
      <span className={styles.frameAgeDot} aria-hidden="true" />
      <span className={styles.frameAgeValue}>
        {approximate && ageMinutes >= 1 ? "~" : ""}{text}
      </span>
      {sourceStale ? <span className={styles.frameAgeWarn} aria-hidden="true">!</span> : null}
    </div>
  );
};

AgeRow.propTypes = {
  label: PropTypes.string,
  epoch: PropTypes.number,
  approximate: PropTypes.bool,
  sourceStale: PropTypes.bool,
  now: PropTypes.number.isRequired,
};

/**
 * Frame-age stack for the radar overlays.
 *
 * The motivating problem: radar that is quietly ~15 min behind looks
 * identical to radar that is current. Some of that lag is irreducible —
 * a NEXRAD volume scan takes 4-6 min to complete before any product
 * exists, and mosaicking adds more — so the fix isn't only a fresher
 * source, it's making the age *visible* so staleness is a fact on screen
 * rather than a suspicion.
 *
 * One row per VISIBLE layer, because each has its own clock: the
 * single-site scan, the composite mosaic (IEM's published valid time),
 * the storm-track product, and the lightning window. A single number
 * could only describe one of them and would be wrong about the rest.
 *
 * Three states per row, from `frameAge`:
 *   fresh (< 6 min)  — as current as NEXRAD physically gets
 *   aging (6-12 min) — past a normal scan interval, worth noticing
 *   stale (12 min+)  — something upstream is wrong; don't trust the picture
 *
 * @param {object} props
 * @param {Array<{key: String, label: String, epoch: Number|null, approximate?: Boolean, sourceStale?: Boolean}>} props.rows layers to describe, in display order
 * @param {Boolean} [props.dark] dark palette active
 * @returns {JSX.Element|null} the stack, or null when no row has a time
 */
const RadarFrameAge = ({ rows, dark = false }) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const live = (rows || []).filter((r) => r && Number.isFinite(r.epoch));
  if (!live.length) return null;

  return (
    <div
      className={[styles.frameAge, dark ? styles.frameAgeDark : styles.frameAgeLight].join(" ")}
      /* aria-live so a screen reader announces the transition into a
       * stale state — the colour change alone is not perceivable to
       * every user, and staleness is the safety-relevant signal here. */
      aria-live="polite"
    >
      {live.map((r) => (
        <AgeRow
          key={r.key || r.label}
          label={r.label}
          epoch={r.epoch}
          approximate={Boolean(r.approximate)}
          sourceStale={Boolean(r.sourceStale)}
          now={now}
        />
      ))}
    </div>
  );
};

RadarFrameAge.propTypes = {
  rows: PropTypes.arrayOf(PropTypes.shape({
    key: PropTypes.string,
    label: PropTypes.string,
    epoch: PropTypes.number,
    approximate: PropTypes.bool,
    sourceStale: PropTypes.bool,
  })),
  dark: PropTypes.bool,
};

export default RadarFrameAge;
