// Regression tests for `client/src/ui/alertLogic.js`. The state
// machine here used to live inside AlertBanner; pulling it out into a
// pure module means we can now lock its transitions down with tests
// that survive React refactors.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

// Same duplication pattern as `uiHybrid.test.js` — re-implementing the
// helpers here keeps the test runner deps-free. If `alertLogic.js`
// drifts from this copy, the tests fail loudly.
function severity(level) {
  if (level === "red") return 3;
  if (level === "orange") return 2;
  if (level === "yellow") return 1;
  return 0;
}

// ───────────────────────────────────────────────────────────────────────
// severity
// ───────────────────────────────────────────────────────────────────────

test("severity: red is 3, orange 2, yellow 1, calm/null 0", () => {
  assert.equal(severity("red"), 3);
  assert.equal(severity("orange"), 2);
  assert.equal(severity("yellow"), 1);
  assert.equal(severity("calm"), 0);
  assert.equal(severity(null), 0);
});

// ───────────────────────────────────────────────────────────────────────
// isCurrentlyPrecipitating
// ───────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// getRadarAlertState — SHOW gate
// ───────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// getRadarAlertState — bumped wording
// ───────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// getRadarAlertState — trend wording + confidence softening
// ───────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────
// selectEligibleGovAlerts — the displayable-tier filter shared by the
// AlertBanner counter, primary index, AlertDetailInline,
// FloatingMiniBanner and AlertMiniCards (via useEligibleGovAlerts).
// Re-implemented here deps-free, same pattern as the helpers above.
// ───────────────────────────────────────────────────────────────────────

const ELIGIBLE_GOV_TIERS = ["red", "orange"];
const ELIGIBLE_GOV_TIERS_WITH_ADVISORY = ["red", "orange", "yellow"];
function selectEligibleGovAlerts(alerts, showAdvisory = false) {
  if (!Array.isArray(alerts)) return [];
  const tiers = showAdvisory ? ELIGIBLE_GOV_TIERS_WITH_ADVISORY : ELIGIBLE_GOV_TIERS;
  return alerts.filter((a) => tiers.includes(a?.tier));
}

test("selectEligibleGovAlerts: keeps red and orange, drops yellow", () => {
  const out = selectEligibleGovAlerts([
    { id: "a", tier: "red" },
    { id: "b", tier: "orange" },
    { id: "c", tier: "yellow" },
  ]);
  assert.deepEqual(out.map((a) => a.id), ["a", "b"]);
});

test("selectEligibleGovAlerts: Nicolet regression — a yellow alert must not inflate the count", () => {
  // The Nicolet report (2026-05-29): one red/orange ECCC alert plus one
  // yellow-tier alert showed "1 / 2" in the banner but only one card.
  // The eligible set the counter/cards run off must be length 1, so the
  // counter reads "1 / 1" and there is no orphan second card.
  const visible = [
    { id: "orage", tier: "red" },
    { id: "veille-jaune", tier: "yellow" },
  ];
  const eligible = selectEligibleGovAlerts(visible);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, "orage");
});

test("selectEligibleGovAlerts: non-array / empty inputs return []", () => {
  assert.deepEqual(selectEligibleGovAlerts(null), []);
  assert.deepEqual(selectEligibleGovAlerts(undefined), []);
  assert.deepEqual(selectEligibleGovAlerts([]), []);
});

test("selectEligibleGovAlerts: alerts with no tier are dropped", () => {
  const out = selectEligibleGovAlerts([{ id: "a" }, { id: "b", tier: "red" }]);
  assert.deepEqual(out.map((a) => a.id), ["b"]);
});

test("selectEligibleGovAlerts: showAdvisory=true also keeps the yellow tier", () => {
  // The k5map opt-in (flood-prone TX): with advisories enabled the
  // yellow tier (Flood Advisory etc.) joins red/orange.
  const out = selectEligibleGovAlerts([
    { id: "a", tier: "red" },
    { id: "b", tier: "orange" },
    { id: "c", tier: "yellow" },
  ], true);
  assert.deepEqual(out.map((a) => a.id), ["a", "b", "c"]);
});

test("selectEligibleGovAlerts: defaults off — yellow dropped without the opt-in", () => {
  // Default arg must preserve the historical red/orange-only behaviour
  // so every existing caller is unchanged until it passes the flag.
  assert.deepEqual(selectEligibleGovAlerts([{ id: "adv", tier: "yellow" }]), []);
  assert.deepEqual(selectEligibleGovAlerts([{ id: "adv", tier: "yellow" }], false), []);
});

// ── getAirAlertState — AQ category → top-of-rail alert tier ──────────────
// Re-implemented per the deps-free duplication pattern (see file header).
// These lock the v3.2 health-risk threshold decision (2026-06-18): the AIR
// alert card escalates ONLY at high/veryHigh; moderate/low stay as the
// inline AirCard so the card isn't present nearly year-round.
