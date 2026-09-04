import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineIcon } from "@iconify/react";
import locationCurrentIcon from "@iconify/icons-carbon/location-current";
import locationHazardIcon from "@iconify/icons-carbon/location-hazard";
import { AppActionsContext } from "~/AppContext";
import styles from "./styles.css";

// How long the failure state stays on the button before it returns to idle.
// Long enough to read, short enough that a denied permission does not leave
// a permanently broken-looking control on the map.
const ERROR_RESET_MS = 4000;

/**
 * "Centre the map on me" — one GPS fix, no watch.
 *
 * Lives on the map itself rather than in the toolbar, because the toolbar is
 * exactly what is not there when it is wanted: the app's rail can be hidden
 * and the drawer is closed by default, and having to open a menu to answer
 * "where am I" is a menu too many. This is the one control that stays on
 * screen whatever else is collapsed.
 *
 * Distinct from the rail's follow toggle on purpose. Follow opens a
 * `watchPosition` and holds the map on the device — right for driving, and
 * expensive. This is a single fix that costs nothing after it lands, which is
 * what the gesture means the rest of the time. Neither cancels the other.
 *
 * Three states, because a GPS fix is not instant and can fail: idle, in
 * flight (the icon spins, repeat taps ignored — a second `getCurrentPosition`
 * would just queue behind the first), and failed (a denied permission or a
 * device that never got a lock). The failure is shown ON the button and
 * announced, rather than thrown away, or the button reads as dead.
 *
 * @returns {JSX.Element} the locate button
 */
const LocateButton = () => {
  const { t } = useTranslation();
  const { locateOnce } = useContext(AppActionsContext);
  const [state, setState] = useState("idle"); // idle | locating | error
  // Survives unmount: a fix can land after the layout has switched away.
  const aliveRef = useRef(true);
  const resetRef = useRef(null);
  useEffect(() => () => {
    aliveRef.current = false;
    clearTimeout(resetRef.current);
  }, []);

  const handleClick = useCallback(() => {
    if (state === "locating") return;
    clearTimeout(resetRef.current);
    setState("locating");
    locateOnce()
      .then(() => { if (aliveRef.current) setState("idle"); })
      .catch(() => {
        if (!aliveRef.current) return;
        setState("error");
        resetRef.current = setTimeout(() => {
          if (aliveRef.current) setState("idle");
        }, ERROR_RESET_MS);
      });
  }, [locateOnce, state]);

  const label = t(
    state === "error" ? "controls.locateFailed" : "controls.locateMe",
    { defaultValue: state === "error" ? "Could not get your location" : "Centre on my location" }
  );

  return (
    <button
      type="button"
      className={`${styles.locateButton} ${state === "error" ? styles.error : ""}`}
      onClick={handleClick}
      title={label}
      aria-label={label}
      aria-busy={state === "locating"}
    >
      <InlineIcon
        icon={state === "error" ? locationHazardIcon : locationCurrentIcon}
        className={state === "locating" ? styles.spin : ""}
      />
      {/* The state change is visual only; screen readers get it here. */}
      <span className={styles.srOnly} role="status" aria-live="polite">
        {state === "locating"
          ? t("controls.locating", { defaultValue: "Finding your location" })
          : ""}
      </span>
    </button>
  );
};

export default LocateButton;
