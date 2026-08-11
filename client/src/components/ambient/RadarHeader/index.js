import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";
import { UiPrefsContext, LocationContext } from "~/AppContext";
import LocationName from "~/components/LocationName";
import LocationDetailsPopover from "~/components/ambient/LocationDetailsPopover";
import styles from "./styles.css";

const I18N_LOCALE = { en: "en-US", fr: "fr-FR", es: "es-ES" };

/**
 * Header slab for the radar viewer: place name and clock, nothing else.
 *
 * Replaces HeroBand / HeroCompact / TimeBlock, which between them showed
 * temperature, condition, feels-like, sun/moon meta and a seasonal
 * countdown — all sourced from Tomorrow.io, which the radar rework
 * removed. Rather than gut a 249-line weather-coupled component down to
 * two fields, this is the small thing that was actually wanted.
 *
 * The `data-ambient-hero` attribute is applied by the LAYOUT, not here —
 * WeatherMap's `useRailOffset` measures that element's rendered height to
 * push the location marker below the slab, and the contract belongs with
 * whoever positions it.
 *
 * Clock behaviour is carried over verbatim from TimeBlock because it was
 * hard-won: it ticks once per MINUTE aligned to the boundary (the slab
 * only shows HH:mm, so a 1 Hz tick re-ran Intl formatting 60× more often
 * than the display could change — pure waste on an always-on kiosk), via
 * a chained setTimeout rather than setInterval so the phase self-heals
 * after timer throttling, sleep/wake, or an NTP step.
 *
 * @param {object} props
 * @param {boolean} [props.compact] narrow variant for the Pi / mobile rail
 * @returns {JSX.Element} header slab
 */
const RadarHeader = ({ compact = false }) => {
  const { clockTime } = useContext(UiPrefsContext);
  const { mapTimezone } = useContext(LocationContext);
  const { t, i18n } = useTranslation();

  const localeKey = i18n.language.startsWith("fr")
    ? "fr"
    : i18n.language.startsWith("es")
      ? "es"
      : "en";
  const locale = I18N_LOCALE[localeKey];

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const MINUTE_MS = 60 * 1000;
    let timerId = null;
    const scheduleNext = () => {
      timerId = setTimeout(() => {
        setNow(new Date());
        scheduleNext();
      }, MINUTE_MS - (Date.now() % MINUTE_MS));
    };
    scheduleNext();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setNow(new Date());
        clearTimeout(timerId);
        scheduleNext();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimeout(timerId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const hour12 = clockTime === "12";

  // Intl.DateTimeFormat construction (locale-data lookup) is the
  // expensive half of formatting — memoized so each tick pays only for
  // format().
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, {
      weekday: "long", month: "long", day: "numeric", timeZone: mapTimezone,
    }),
    [locale, mapTimezone]
  );
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, {
      hour: "numeric", minute: "2-digit", hour12, timeZone: mapTimezone,
    }),
    [locale, mapTimezone, hour12]
  );

  const parts = timeFormatter.formatToParts(now);
  const hhmm = parts
    .filter((p) => ["hour", "minute", "literal"].includes(p.type))
    .map((p) => p.value)
    .join("")
    .trim()
    // FR 24 h renders "21 h 03" — strip the trailing " h" so the digit
    // block reads as HH:mm the same way it does in EN.
    .replace(/\s+h\s*$/i, "");
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value || "";

  // Place popover (kept from HeroBand): tapping the place name opens the
  // coordinate / timezone detail, which is genuinely useful on a radar
  // kiosk for confirming which point the single-site layer is centred on.
  const [locationOpen, setLocationOpen] = useState(false);
  const locationRef = useRef(null);

  return (
    <div className={`${styles.header} ${compact ? styles.compact : ""}`}>
      <div className={styles.placeRow}>
        <button
          ref={locationRef}
          type="button"
          className={styles.placeButton}
          onClick={() => setLocationOpen((v) => !v)}
          aria-expanded={locationOpen}
          aria-label={t("location.details")}
        >
          <LocationName />
        </button>
        <LocationDetailsPopover
          open={locationOpen}
          onClose={() => setLocationOpen(false)}
          triggerRef={locationRef}
          anchor="left"
        />
      </div>
      <div className={styles.clockRow}>
        <span className={styles.time}>{hhmm}</span>
        {hour12 && dayPeriod ? <span className={styles.amPm}>{dayPeriod}</span> : null}
      </div>
      <div className={styles.date}>{dateFormatter.format(now).toUpperCase()}</div>
    </div>
  );
};

RadarHeader.propTypes = {
  compact: PropTypes.bool,
};

export default RadarHeader;
