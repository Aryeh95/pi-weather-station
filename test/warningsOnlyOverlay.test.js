// Regression tests for the "warnings only" filter on the nearby-alerts
// map overlay (the dock's warning-triangle toggle).
//
// The trap this locks down: it is tempting to filter the overlay by
// `tier`, because tier is right there on every alert and red *looks*
// like it means "Warning". It doesn't. `tier` comes from
// `severityToTier` in server/govAlertSources/_shared.js, which maps CAP
// SEVERITY:
//
//     extreme | severe  → red
//     moderate          → orange
//     everything else   → yellow
//
// plus `capWatchSeverity`, which caps watches at moderate so a
// CAP-Severe Tornado Watch doesn't shout as loud as a warning.
//
// Severity and product type are different axes. NWS tags plenty of real
// Warnings CAP `Moderate` (Winter Storm Warning, many Flood Warnings),
// which lands them on orange — the same tier as a watch. A tier filter
// would therefore silently drop genuine Warnings from the map, which is
// the exact failure a warnings-only view must never have.
//
// So the filter keys on the event NAME via `eventProductType`, whose
// Warning > Watch > Advisory > Statement precedence is itself locked by
// test/severityProductType.test.js.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");

// ---------- start of verbatim copy from client/src/ui/alertLogic.js ----------

function eventProductType(name) {
  const s = String(name || "").toLowerCase();
  if (/\bwarning\b/.test(s)) return "warning";
  if (/\bwatch\b/.test(s)) return "watch";
  if (/\badvisory\b/.test(s)) return "advisory";
  if (/\bstatement\b/.test(s)) return "statement";
  return null;
}

// ---------- end of verbatim copy ----------

// Mirrors the filter applied in AppContext where /api/nearby-alerts lands.
const warningsOnly = (alerts) =>
  alerts.filter((a) => eventProductType(a && a.eventType) === "warning");

test("keeps warnings, drops watches / advisories / statements", () => {
  const feed = [
    { id: "1", eventType: "Tornado Warning" },
    { id: "2", eventType: "Tornado Watch" },
    { id: "3", eventType: "Heat Advisory" },
    { id: "4", eventType: "Special Weather Statement" },
    { id: "5", eventType: "Severe Thunderstorm Warning" },
  ];
  assert.deepEqual(warningsOnly(feed).map((a) => a.id), ["1", "5"]);
});

test("a CAP-Moderate warning survives — the tier-filter trap", () => {
  // This is the whole point. Both of these carry tier "orange": the
  // warning because NWS tagged it CAP Moderate, the watch because
  // capWatchSeverity pinned it there. Filtering on tier would keep both
  // or drop both; filtering on the name keeps exactly the warning.
  const feed = [
    { id: "warn", eventType: "Winter Storm Warning", tier: "orange", severity: "moderate" },
    { id: "watch", eventType: "Winter Storm Watch", tier: "orange", severity: "moderate" },
  ];
  const kept = warningsOnly(feed);
  assert.deepEqual(kept.map((a) => a.id), ["warn"]);
  assert.equal(kept[0].tier, "orange", "kept alert is NOT red — tier is the wrong axis");
});

test("a yellow-tier warning is still a warning", () => {
  // Minor-severity warnings exist (e.g. some Flood Warnings). They must
  // not be filtered out just because their tier is the advisory colour.
  const feed = [{ id: "w", eventType: "Flood Warning", tier: "yellow", severity: "minor" }];
  assert.equal(warningsOnly(feed).length, 1);
});

test("a red-tier watch is still not a warning", () => {
  // The mirror case: severity alone must not promote a watch onto the
  // warnings-only overlay.
  const feed = [{ id: "watch", eventType: "Tornado Watch", tier: "red", severity: "severe" }];
  assert.deepEqual(warningsOnly(feed), []);
});

test("precedence: a warning that mentions a watch is a warning", () => {
  const feed = [{ id: "w", eventType: "Severe Thunderstorm Warning (replaces Watch)" }];
  assert.equal(warningsOnly(feed).length, 1);
});

test("malformed entries are dropped rather than thrown on", () => {
  // The list is a network payload — it must never crash the overlay.
  const feed = [null, undefined, {}, { eventType: null }, { eventType: 42 }, { eventType: "" }];
  assert.deepEqual(warningsOnly(feed), []);
});

test("an empty feed stays empty", () => {
  assert.deepEqual(warningsOnly([]), []);
});
