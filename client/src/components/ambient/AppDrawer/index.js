import React, { useContext, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { useTranslation } from "react-i18next";
import { InlineIcon } from "@iconify/react";
import closeIcon from "@iconify/icons-carbon/close";
import sidePanelOpenIcon from "@iconify/icons-carbon/side-panel-open";
import sidePanelCloseIcon from "@iconify/icons-carbon/side-panel-close";
import { UiPrefsContext, AppActionsContext } from "~/AppContext";
import ControlButtons from "~/components/ambient/ControlButtons";
import styles from "./styles.css";

/**
 * Swipe-out drawer naming every control (app shell only).
 *
 * The icon rail is fast once the glyphs are learned and opaque before that —
 * a funnel and a pair of arrows do not announce "clear-air filter" and "base
 * velocity". This is the same `ControlButtons` set rendered with each
 * button's own `aria-label` beside it, so there is exactly one definition of
 * every control and the drawer cannot drift from the rail.
 *
 * It is also how a hidden rail is reached: the drawer opens from a left-edge
 * swipe whether the rail is showing or not, and carries the row that puts it
 * back.
 *
 * Dismissal is deliberately generous — scrim tap, close button, a leftward
 * swipe on the panel, or Escape — because it opens from a gesture and a
 * gesture that is easy to trigger must be easy to undo.
 *
 * @param {object} props
 * @param {boolean} props.open whether the drawer is showing
 * @param {Function} props.onClose called to dismiss it
 * @returns {JSX.Element|null} the drawer, or null when closed
 */
const AppDrawer = ({ open, onClose }) => {
  const { t } = useTranslation();
  const { railHidden } = useContext(UiPrefsContext);
  const { toggleRailHidden } = useContext(AppActionsContext);
  const panelRef = useRef(null);
  const swipeRef = useRef({ x: 0, y: 0, active: false });

  // Escape closes it, matching every other dismissible surface here.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onTouchStart = (e) => {
    swipeRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, active: true };
  };
  const onTouchEnd = (e) => {
    const st = swipeRef.current;
    if (!st.active) return;
    swipeRef.current = { x: 0, y: 0, active: false };
    const touch = e.changedTouches[0];
    const dx = touch.clientX - st.x;
    const dy = touch.clientY - st.y;
    // Leftward, and more horizontal than vertical — otherwise a scroll of the
    // button column would close the drawer under the user's finger.
    if (dx < -60 && Math.abs(dx) > Math.abs(dy)) onClose();
  };

  return (
    <div className={styles.root} role="dialog" aria-modal="true">
      <div className={styles.scrim} onClick={onClose} />
      <div
        ref={panelRef}
        className={styles.panel}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className={styles.header}>
          <span className={styles.title}>{t("controls.drawerTitle", { defaultValue: "Controls" })}</span>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={t("controls.drawerClose", { defaultValue: "Close controls" })}
          >
            <InlineIcon icon={closeIcon} />
          </button>
        </div>

        <div className={styles.body}>
          <ControlButtons labelled />
        </div>

        {/* Show / hide the rail. Lives at the foot of the drawer because it is
          * about the drawer's own surroundings rather than about the map, and
          * because a hidden rail leaves this as the only way back. */}
        <button
          type="button"
          className={styles.railToggle}
          onClick={() => { toggleRailHidden(); onClose(); }}
          aria-pressed={railHidden}
        >
          <InlineIcon icon={railHidden ? sidePanelOpenIcon : sidePanelCloseIcon} />
          <span>
            {railHidden
              ? t("controls.showRail", { defaultValue: "Show toolbar" })
              : t("controls.hideRail", { defaultValue: "Hide toolbar" })}
          </span>
        </button>
      </div>
    </div>
  );
};

AppDrawer.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
};

export default AppDrawer;
