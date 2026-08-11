/**
 * Pure logic for the government-alert stack, kept out of
 * `ambient/AlertBanner` so it can be exercised directly. No React, no
 * JSX, no DOM — safe to test under `node:test`.
 *
 * What remains after the radar rework:
 *
 *   - `ELIGIBLE_GOV_TIERS` / `..._WITH_ADVISORY` + `selectEligibleGovAlerts`
 *     — which alerts clear the display gate.
 *   - `severity(level)` — level → numeric tier for comparison.
 *   - `eventProductType(name)` — NWS product classification.
 *
 * The radar-derived banner state machine that used to live here went
 * with the RainViewer sampler that fed it.
 */

/**
 * Government-alert tiers the v3 banner stack displays by default.
 * `severityToTier` (server/govAlertSources/_shared.js) emits "red",
 * "orange" or "yellow"; only red/orange clear the default SHOW gate.
 * Yellow-tier (minor/low severity) alerts are hidden unless the user
 * opts into them — see `ELIGIBLE_GOV_TIERS_WITH_ADVISORY`.
 */
export const ELIGIBLE_GOV_TIERS = ["red", "orange"];

/**
 * Tiers shown when the user has enabled the "show advisory alerts"
 * preference: red/orange plus the yellow tier (NWS/ECCC advisories —
 * Flood / Heat / Wind Advisory, CAP severity minor/low). Opt-in and
 * off by default. Requested by a flood-prone user (k5map, TX) whose
 * Flood Advisories frequently escalate to Warnings; gating it behind a
 * per-device toggle keeps the quieter default for everyone else.
 */
export const ELIGIBLE_GOV_TIERS_WITH_ADVISORY = ["red", "orange", "yellow"];

/**
 * Filter a list of government alerts down to the displayable tiers.
 * Single source of truth shared — via the `useEligibleGovAlerts` hook
 * — by the AlertBanner counter + primary index, AlertDetailInline,
 * FloatingMiniBanner and AlertMiniCards, so none of them disagree on
 * what "N active alerts" means. Before this existed, the banner counter
 * counted ALL tiers while the mini-cards list only showed red/orange,
 * so a sub-threshold yellow ECCC alert inflated "1 / 2" without ever
 * appearing as a card (the Nicolet report, 2026-05-29).
 *
 * @param {Array<{tier?: string}>} alerts
 * @param {boolean} [showAdvisory=false] — when true, also keep the
 *   yellow (advisory) tier; otherwise red/orange only
 * @returns {Array} the subset whose tier is in the active set
 */
export function selectEligibleGovAlerts(alerts, showAdvisory = false) {
  if (!Array.isArray(alerts)) return [];
  const tiers = showAdvisory ? ELIGIBLE_GOV_TIERS_WITH_ADVISORY : ELIGIBLE_GOV_TIERS;
  return alerts.filter((a) => tiers.includes(a?.tier));
}

/**
 * Numeric severity for risk-level comparison.
 *
 * @param {string|null} level — "calm" | "yellow" | "orange" | "red" | null
 * @returns {number} 0-3
 */
export function severity(level) {
  if (level === "red") return 3;
  if (level === "orange") return 2;
  if (level === "yellow") return 1;
  return 0;
}

/**
 * Classify an NWS/ECCC alert's English event name to its PRODUCT TYPE
 * (Warning > Watch > Advisory > Statement), independent of CAP severity.
 * Both sources expose an English name carrying the product word: NWS
 * `event` / `title_en` ("Heat Advisory", "Flood Watch"), ECCC `alert_name_en`
 * / `title_en` ("Wind warning", "Special weather statement"). This lets the
 * SeverityChip print the real product word — so a Heat *Advisory* (CAP
 * severity Moderate) reads "Avis", never "Veille" (watch). Returns null when
 * no product type is recognizable (caller falls back to a severity word).
 * Order matters: a "Severe Thunderstorm Warning" is a warning, not a "severe".
 *
 * @param {?string} name — the English event name (alert.title_en / eventType)
 * @returns {?string} the product-type slug ("warning" | "watch" | "advisory" |
 *   "statement"), or null when none is recognizable
 */
export function eventProductType(name) {
  const s = String(name || "").toLowerCase();
  if (/\bwarning\b/.test(s)) return "warning";
  if (/\bwatch\b/.test(s)) return "watch";
  if (/\badvisory\b/.test(s)) return "advisory";
  if (/\bstatement\b/.test(s)) return "statement";
  return null;
}

// isCurrentlyPrecipitating / getRadarAlertState / getAirAlertState were
// removed in the radar rework. The first two implemented the RADAR-tier
// alert banner driven by the RainViewer tile sampler's risk levels and
// trend confidence; the third backed the air-quality alert card. All
// three lost their data sources, and the banner now shows government
// alerts only.
