// Nowcast card — "rain at the pin in N minutes, this heavy, ending then".
//
// Reads /api/radar/nowcast (server/nowcastCtrl.js), which extrapolates the
// last few volume scans' motion over the pin. The card says three things
// and no more: the headline (raining now / rain in N min / dry through
// the horizon), one line of detail (how heavy, when it ends), and a
// 0–90 min intensity strip in the active reflectivity palette so the
// card reads in the same colours as the map. The footer names the
// motion, the confidence and the scan the answer is based on, because a
// nowcast that hides its basis is a forecast, and this is not one.

import React, { useContext, useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";
import {
  AlertsContext, LocationContext, SystemContext, UiPrefsContext,
} from "~/AppContext";
import { colorForDbz } from "~/components/WeatherMap/radialRender";
import { frameAge } from "~/components/WeatherMap/iemRadar";
import useNowcast from "./useNowcast";
import styles from "./styles.css";

// The age line re-counts between polls, like the frame-age chip.
const TICK_MS = 15 * 1000;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/**
 * Eight-point compass name for a bearing.
 *
 * @param {Number} deg bearing, degrees clockwise from north
 * @returns {String} e.g. "NE"
 */
function compass(deg) {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * Speed in the user's unit.
 *
 * @param {Number} kmh speed
 * @param {String} unit "mph" | "kmh" | "ms" | "kt"
 * @returns {String} formatted speed
 */
function speedLabel(kmh, unit) {
  if (unit === "mph") return `${Math.round(kmh / 1.609344)} mph`;
  if (unit === "ms" || unit === "m/s") return `${Math.round(kmh / 3.6)} m/s`;
  if (unit === "kt") return `${Math.round(kmh / 1.852)} kt`;
  return `${Math.round(kmh)} km/h`;
}

/**
 * Clock time `leadMin` minutes after the scan the nowcast is based on.
 *
 * @param {String} scanTime ISO scan time
 * @param {Number} leadMin minutes
 * @param {String} clockTime "12" | "24"
 * @param {String} [timeZone] IANA zone of the pin, when known
 * @returns {String} e.g. "3:40 PM"
 */
function clockAt(scanTime, leadMin, clockTime, timeZone) {
  const t = Date.parse(scanTime) + leadMin * 60000;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric", minute: "2-digit", hour12: clockTime === "12", timeZone: timeZone || undefined,
    }).format(new Date(t));
  } catch {
    return new Date(t).toTimeString().slice(0, 5);
  }
}

/**
 * CSS colour for a series step.
 *
 * @param {Object} step advectSeries entry
 * @param {String} palette radar palette id
 * @returns {String|null} rgb() string, null for no rain
 */
function stepColor(step, palette) {
  if (!step || step.category === "none" || step.dbz == null) return null;
  const [r, g, b] = colorForDbz(step.dbz, palette);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The nowcast card. Returns null unless the toggle is on.
 *
 * @param {Object} props
 * @param {Boolean} [props.compact] tighter card for the Pi rail and phones
 * @returns {JSX.Element|null}
 */
const NowcastPanel = ({ compact = false }) => {
  const { t } = useTranslation();
  const { showNowcast, radarPalette } = useContext(AlertsContext);
  const { mapGeo, mapTimezone } = useContext(LocationContext);
  const { pollingPaused, radarSite } = useContext(SystemContext);
  const { speedUnit, clockTime, darkMode } = useContext(UiPrefsContext);

  const { data, stale, loading } = useNowcast({
    latitude: mapGeo ? mapGeo.latitude : null,
    longitude: mapGeo ? mapGeo.longitude : null,
    site: radarSite || "",
    enabled: showNowcast && Boolean(mapGeo),
    paused: pollingPaused,
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!showNowcast) return undefined;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [showNowcast]);

  if (!showNowcast) return null;

  const cardClass = [
    styles.card,
    compact ? styles.compact : "",
    darkMode ? styles.dark : "",
    stale ? styles.stale : "",
  ].filter(Boolean).join(" ");

  // ---- Pending / failed states -------------------------------------
  if (!data) {
    return (
      <section className={cardClass} aria-label={t("nowcast.title")}>
        <header className={styles.head}><span className={styles.title}>{t("nowcast.title")}</span></header>
        <div className={styles.headline}>{loading ? t("nowcast.loading") : t("nowcast.unavailable")}</div>
      </section>
    );
  }
  if (!data.available) {
    return (
      <section className={cardClass} aria-label={t("nowcast.title")}>
        <header className={styles.head}>
          <span className={styles.title}>{t("nowcast.title")}</span>
          {data.site ? <span className={styles.site}>{data.site}</span> : null}
        </header>
        <div className={styles.headline}>{t("nowcast.unavailable")}</div>
        <div className={styles.detail}>
          {data.reason === "no-recent-scans" ? t("nowcast.noScans", { site: data.site }) : t("nowcast.tryLater")}
        </div>
      </section>
    );
  }

  // ---- The answer ---------------------------------------------------
  const {
    now: current, arrival, peak, end, series, motion, trend, confidence, horizonMin, scanTime, site, hindcast, liveSkill, mrms,
  } = data;
  const at = (lead) => clockAt(scanTime, lead, clockTime, mapTimezone);
  const cat = (name) => t(`nowcast.intensity.${name}`);
  const pct = (p) => Math.round((p ?? 0) * 100);
  const { ageMinutes, level } = frameAge(Date.parse(scanTime), now);
  // Leads are measured from the scan; the card is read later. Shift so
  // "in N min" is from now, never negative.
  const elapsed = Math.max(0, Math.round((now - Date.parse(scanTime)) / 60000));
  const fromNow = (lead) => Math.max(1, lead - elapsed);
  // Precipitation-type vocabulary: "Rain", "Snow", "Sleet / freezing
  // rain", "Hail", "Graupel" — one headline key per type.
  const typeOf = (x) => (x && x.ptype && x.ptype !== "none" ? x.ptype : "rain");

  let headline;
  let detail;
  let tone = "dry";
  if (current.raining) {
    tone = current.category;
    headline = `${t(`nowcast.now.${typeOf(current)}`)} · ${cat(current.category)}`;
    const parts = [];
    if (peak && peak.leadMin > 0 && peak.category !== current.category) {
      parts.push(t("nowcast.peakAt", { intensity: cat(peak.category), time: at(peak.leadMin) }));
    }
    if (end) parts.push(t("nowcast.endsAround", { time: at(end.leadMin), min: fromNow(end.leadMin) }));
    else parts.push(t("nowcast.noEnd", { time: at(horizonMin) }));
    detail = parts.join(" · ");
  } else if (arrival) {
    tone = arrival.category;
    // The ensemble's range: "20–35 min" when the members disagree, "~25"
    // when they agree within one step.
    const lo = fromNow(arrival.earliestMin ?? arrival.leadMin);
    const hi = arrival.latestMin != null ? fromNow(arrival.latestMin) : null;
    const range = hi != null && hi - lo >= 10 ? `${lo}–${hi}` : `~${fromNow(arrival.leadMin)}`;
    headline = t(`nowcast.in.${typeOf(arrival)}`, { range });
    const parts = [cat(peak ? peak.category : arrival.category)];
    if (peak && peak.rateMmh >= 0.5) parts.push(t("nowcast.rate", { rate: peak.rateMmh }));
    parts.push(t("nowcast.chance", { pct: pct(arrival.prob) }));
    if (end) parts.push(t("nowcast.endsAround", { time: at(end.leadMin), min: fromNow(end.leadMin) }));
    detail = parts.join(" · ");
  } else if (!motion && data.echoCellsInRange > 0) {
    headline = t("nowcast.motionUnknown");
    detail = t("nowcast.motionUnknownDetail", { km: data.gridKm });
  } else {
    headline = t("nowcast.noRain", { min: horizonMin });
    // The highest chance anywhere in the window, so "dry" never hides a
    // 40 % step.
    const maxStep = series.reduce((b, x) => (x.prob > (b ? b.prob : 0) ? x : b), null);
    detail = horizonMin < 90
      ? t("nowcast.horizonShort", { min: horizonMin })
      : (maxStep && maxStep.prob >= 0.2
        ? t("nowcast.someChance", { pct: pct(maxStep.prob), time: at(maxStep.leadMin) })
        : t("nowcast.noRainDetail", { km: data.gridKm }));
  }

  const motionLine = motion
    ? (motion.speedKmh < 5
      ? t("nowcast.stationary")
      : t("nowcast.moving", { speed: speedLabel(motion.speedKmh, speedUnit), dir: compass(motion.fromDeg) }))
    : null;
  const trendLine = trend && trend.label !== "steady" ? t(`nowcast.trend.${trend.label}`) : null;
  const conf = t(`nowcast.confidence.${confidence}`);
  const keyLead = arrival ? arrival.leadMin : (end ? end.leadMin : null);
  const skillLead = keyLead != null ? String(Math.min(60, Math.max(15, Math.round(keyLead / 15) * 15))) : null;
  const skill = hindcast && hindcast.leads && skillLead ? hindcast.leads[skillLead] : null;
  // The live score for THIS pin, once it has enough verified calls to mean
  // something (a couple of hours of scans).
  const liveLead = skillLead === "45" ? "30" : skillLead;
  const live = liveSkill && liveSkill.leads && liveLead ? liveSkill.leads[liveLead] : null;
  const liveShown = live && live.n >= 20 && live.far != null;

  const ticks = [0, 30, 60, 90];
  return (
    <section
      className={`${cardClass} ${styles[`tone-${tone}`] || ""}`}
      aria-label={t("nowcast.aria", { headline })}
      aria-live="polite"
    >
      <header className={styles.head}>
        <span className={styles.title}>{t("nowcast.title")}</span>
        <span className={`${styles.age} ${styles[`age-${stale ? "stale" : level}`] || ""}`}>
          <span className={styles.site}>{site}</span>
          <span className={styles.ageDot} aria-hidden="true" />
          {ageMinutes < 1 ? t("radar.ageNow") : t("radar.ageMinutes", { count: ageMinutes })}
        </span>
      </header>
      <div className={styles.headline}>{headline}</div>
      {detail ? <div className={styles.detail}>{detail}</div> : null}
      <div className={styles.strip} role="img" aria-label={t("nowcast.stripAria", { min: horizonMin })}>
        {series.map((step) => {
          // Likely steps in the palette colour, at an opacity that grows
          // with the probability; possible steps (20–50 %) as a faint
          // neutral tint; the rest dry.
          const color = stepColor(step, radarPalette);
          const likely = Boolean(color) && step.prob >= 0.5;
          const possible = !likely && step.prob >= 0.2;
          const style = likely
            ? { background: color, opacity: 0.55 + 0.45 * step.prob }
            : (possible ? { opacity: 0.25 + step.prob } : undefined);
          const label = likely
            ? `${cat(step.category)} · ${step.dbz} dBZ`
            : t("nowcast.intensity.none");
          return (
            <span
              key={step.leadMin}
              className={`${styles.step} ${likely ? "" : (possible ? styles.stepPossible : styles.stepDry)}`}
              style={style}
              title={`+${step.leadMin} min · ${pct(step.prob)} % · ${label}`}
            />
          );
        })}
        {series.length < 19 ? <span className={styles.stepGap} style={{ flex: 19 - series.length }} /> : null}
      </div>
      <div className={styles.ticks} aria-hidden="true">
        {ticks.map((m) => <span key={m}>{m === 0 ? t("nowcast.nowTick") : `+${m}`}</span>)}
      </div>
      <footer className={styles.foot}>
        {motionLine ? <span>{motionLine}{trendLine ? ` · ${trendLine}` : ""}</span> : null}
        <span className={`${styles.conf} ${styles[`conf-${confidence}`] || ""}`}>
          {conf}{mrms && mrms.weight ? ` · ${t("nowcast.withSurface")}` : ""}
        </span>
        {/* One plain number: of the times the card called rain at this
          * lead, how often it came true (1 − false-alarm ratio). The miss
          * rate (1 − hit rate) lives in the tooltip — two percentages with
          * different denominators on one line read as a riddle. */}
        {skill && Number.isFinite(skill.far) ? (
          <span
            className={styles.skill}
            title={t("nowcast.skillHint", {
              lead: skill.leadMin, right: Math.round((1 - skill.far) * 100), missed: Math.round((1 - skill.pod) * 100),
            })}
          >
            {t("nowcast.skill", { lead: skill.leadMin, right: Math.round((1 - skill.far) * 100) })}
          </span>
        ) : null}
        {liveShown && live.far != null ? (
          <span className={styles.skill} title={t("nowcast.liveSkillHint", { lead: live.leadMin })}>
            {t("nowcast.liveSkill", { lead: live.leadMin, right: Math.round((1 - live.far) * 100), n: live.n })}
          </span>
        ) : null}
      </footer>
    </section>
  );
};

NowcastPanel.propTypes = {
  compact: PropTypes.bool,
};

export default NowcastPanel;
