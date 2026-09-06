/* The clear-air noise filter's three settings, shared by the context that
 * stores the choice, the map that acts on it and the dock button that
 * cycles it.
 *
 * Ordered as the button steps through them, weakest first — a tap always
 * filters more until it wraps back to the raw picture.
 *
 *   off    every echo the radar reported
 *   dbz    hide below NOISE_FILTER_MIN_DBZ (radialRender.js)
 *   clean  that, plus drop the gates the volume scan's own dual-pol
 *          classification calls non-meteorological (server side)
 *
 * Lives here rather than in the renderer because the stored preference
 * outlives any one component, and the button needs the order.
 */
export const RADAR_NOISE_MODES = ["off", "dbz", "clean"];

// What a device with no stored preference gets. The dBZ floor was the
// default when it was the only filter, and staying there means an
// upgrade changes nothing until the button is pressed.
export const RADAR_NOISE_DEFAULT = "dbz";

/**
 * Is any filtering on? The dBZ floor applies in both filtered modes —
 * the IEM tile layers have no per-gate classification to work from, so
 * "clean" degrades to the floor for them.
 *
 * @param {String} mode one of RADAR_NOISE_MODES
 * @returns {Boolean} true when the dBZ floor should be applied
 */
export function noiseFloorOn(mode) {
  return mode !== "off";
}

/**
 * Should the server strip non-meteorological gates from the radials?
 *
 * @param {String} mode one of RADAR_NOISE_MODES
 * @returns {Boolean} true in "clean" only
 */
export function dualPolCleanOn(mode) {
  return mode === "clean";
}
