/* The reflectivity colour palettes, shared by the context that stores the
 * choice, the renderer and tile layer that paint with it, the legend that
 * describes it and the Settings picker that switches it.
 *
 *   nws    the NWS / IEM "classic" ramp — the colours IEM's own tiles are
 *          painted in. Weak echo is vivid (cyan and blue from 5 dBZ), so
 *          drizzle shouts.
 *   scope  a RadarScope-style ramp: weak echo in whites and greys that
 *          recede, greens from 20 dBZ, then the familiar yellow → red →
 *          magenta → purple → cyan. An approximation built from the
 *          published scale bar, not RadarScope's own table.
 *
 * Per-device (localStorage). Default is the RadarScope-style ramp — the
 * user's stated preference (2026-09-22) after seeing the two side by side.
 */
export const RADAR_PALETTES = ["scope", "nws"];
export const RADAR_PALETTE_DEFAULT = "scope";
export const RADAR_PALETTE_STORAGE_KEY = "radarPalette";

/**
 * Normalise a stored / requested palette id.
 *
 * @param {*} value anything read from storage or a caller
 * @returns {String} a member of RADAR_PALETTES
 */
export function normalizeRadarPalette(value) {
  return RADAR_PALETTES.includes(value) ? value : RADAR_PALETTE_DEFAULT;
}
