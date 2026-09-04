import React, { useContext } from "react";
import { useTranslation } from "react-i18next";
import { InlineIcon } from "@iconify/react";
import sidePanelCloseIcon from "@iconify/icons-carbon/side-panel-close";
import { AppActionsContext } from "~/AppContext";
import ControlButtons from "~/components/ambient/ControlButtons";
import HealthIndicator from "~/components/ambient/HealthIndicator";
import styles from "./styles.css";

/**
 * Direction C bottom dock — anchors the row of control icons (reset
 * map / marker / timeline / dark mode / settings / debug / update)
 * along the bottom edge of the Pi layout.
 *
 * v3.1 Phase 1: `ControlButtons` and `HealthIndicator` are now
 * wired in their grouped / chip variants. The icons split into
 * three labelled groups (Map · Display · System) with hairline
 * separators between them, and the health dot is replaced by a
 * status chip ("Services · OK / Dégradé / Critique / Hors ligne")
 * anchored to the right edge of the dock. Both component-side
 * styles include their own narrow-viewport collapse rules so the
 * 7" Pi (932 px) and phones get tighter layouts without changing
 * the dock wrapper itself.
 *
 * @returns {JSX.Element} bottom-dock slab
 */
const BottomDock = () => {
  const { t } = useTranslation();
  const { toggleRailHidden } = useContext(AppActionsContext);

  return (
    <div className={styles.dock}>
      <ControlButtons />
      {/* Collapse the rail (app only). The map is the point of this screen and
        * the rail costs ~60 px of it; hiding is never a trap, because the
        * left-edge swipe still opens the labelled drawer, which carries the
        * row that brings the rail back. */}
      {__STANDALONE__ && (
        <button
          type="button"
          className={styles.hideRail}
          onClick={toggleRailHidden}
          title={t("controls.hideRail", { defaultValue: "Hide toolbar" })}
          aria-label={t("controls.hideRail", { defaultValue: "Hide toolbar" })}
        >
          <InlineIcon icon={sidePanelCloseIcon} />
        </button>
      )}
      <HealthIndicator chip />
    </div>
  );
};

export default BottomDock;
