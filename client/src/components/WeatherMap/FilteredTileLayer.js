// IEM radar tile layer with the clear-air noise filter applied per pixel.
//
// The raw-radial layer filters sub-15 dBZ returns in its LUT, but the
// IEM tiles it falls back to (the low-zoom mosaic, and every historical
// frame until its radial is rendered) are pre-coloured PNGs — so a dry
// day still painted the whole disc with clear-air speckle at low zoom.
//
// This layer fixes that WITHOUT guessing at colours. IEM publishes the
// exact lookup table its N0Q rasters are painted with (255 colour
// indices, dBZ = index / 2 − 32.5, every colour unique), and a live check
// on 2026-09-03 found that 100 % of the opaque pixels in both a mosaic
// tile and a `ridge::` single-site tile are exact entries from that
// table — tile.py resamples with nearest-neighbour, so no blends appear.
// Each tile is therefore drawn to a canvas, every opaque pixel's colour
// looked up in the table, and pixels whose dBZ sits below the threshold
// are made transparent. A colour that is NOT in the table (a future
// palette change upstream) is left untouched — the failure mode is
// "unfiltered", never "blank".
//
// Tiles are fetched with `crossOrigin: "anonymous"` (IEM answers with
// `Access-Control-Allow-Origin: *`). Should CORS ever break, the canvas
// taints, `getImageData` throws, and the tile falls back to the plain
// image — again unfiltered rather than missing.

import L from "leaflet";
import { createLayerComponent, updateGridLayer } from "@react-leaflet/core";
import palette from "./iemN0qPalette.json";
import { colorForDbz } from "./radialRender";

/**
 * Pack an RGB triple into one integer key.
 *
 * @param {Number} r red 0-255
 * @param {Number} g green 0-255
 * @param {Number} b blue 0-255
 * @returns {Number} 24-bit key
 */
function rgbKey(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

// Colour → dBZ, built once from IEM's table.
const DBZ_BY_COLOR = new Map(palette.map(([dbz, r, g, b]) => [rgbKey(r, g, b), dbz]));

// Recolouring tables per palette id: IEM colour → this palette's RGBA for
// the same dBZ. The tiles ARE the NWS palette, so "nws" needs no table and
// the pixels pass through; any other palette is repainted through the same
// exact colour → dBZ lookup the filter uses. Built lazily, once per id.
const RECOLOR_BY_PALETTE = new Map();

/**
 * The recolouring table for a palette id, or null when none is needed.
 *
 * @param {String} [paletteId] reflectivity palette id (ui/radarPalette.js)
 * @returns {Map<Number, Array<Number>>|null} IEM colour key → [r, g, b, a]
 */
export function recolorTable(paletteId) {
  if (!paletteId || paletteId === "nws") return null;
  let table = RECOLOR_BY_PALETTE.get(paletteId);
  if (!table) {
    table = new Map(palette.map(([dbz, r, g, b]) => [rgbKey(r, g, b), colorForDbz(dbz, paletteId)]));
    RECOLOR_BY_PALETTE.set(paletteId, table);
  }
  return table;
}

/**
 * Make every pixel below `minDbz` transparent, and repaint the rest in
 * another palette when one is given — in place.
 *
 * Exported for tests: pure function over an RGBA buffer.
 *
 * @param {Uint8ClampedArray} rgba canvas pixel data
 * @param {Number} minDbz threshold; pixels decoding below it are cleared (−Infinity clears none)
 * @param {Map<Number, Array<Number>>|null} [recolor] IEM colour key → replacement RGBA (see recolorTable)
 * @returns {Number} how many pixels were cleared
 */
export function filterPixels(rgba, minDbz, recolor = null) {
  let cleared = 0;
  // Most of a radar tile is transparent; the alpha check first keeps the
  // Map lookup off the hot path for those pixels.
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const key = rgbKey(rgba[i], rgba[i + 1], rgba[i + 2]);
    const dbz = DBZ_BY_COLOR.get(key);
    if (dbz === undefined) continue;
    if (dbz < minDbz) {
      rgba[i + 3] = 0;
      cleared += 1;
    } else if (recolor) {
      const c = recolor.get(key);
      if (c) {
        rgba[i] = c[0];
        rgba[i + 1] = c[1];
        rgba[i + 2] = c[2];
        rgba[i + 3] = c[3];
      }
    }
  }
  return cleared;
}

/**
 * Filter one tile's canvas in place. Idempotent: a tile is filtered once.
 *
 * @param {HTMLCanvasElement} canvas tile canvas with the unfiltered image drawn
 * @param {Number} minDbz threshold
 * @param {String} [paletteId] palette to repaint in
 */
function filterCanvas(canvas, minDbz, paletteId) {
  if (canvas._sweepFiltered) return;
  const ctx = canvas.getContext("2d");
  try {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    filterPixels(data.data, minDbz, recolorTable(paletteId));
    ctx.putImageData(data, 0, 0);
  } catch {
    // Tainted canvas (CORS) — the unfiltered image is already drawn.
  }
  canvas._sweepFiltered = true;
}

const FilteredGridLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const size = this.getTileSize();
    const canvas = document.createElement("canvas");
    canvas.width = size.x;
    canvas.height = size.y;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      canvas.getContext("2d").drawImage(img, 0, 0, size.x, size.y);
      // PERFORMANCE: with the timeline open every loop frame is a mounted
      // layer (11 mosaic + up to 30 site), but only one is visible. Filtering
      // every tile of every hidden frame on each pan/zoom was ~40 layers ×
      // ~20 tiles × ~2 ms of main-thread work per gesture — the sluggish
      // panning reported on 2026-09-03. Hidden frames now keep the raw
      // image and are filtered in place the moment they become visible
      // (setOpacity below), so a pan costs one layer's worth of filtering.
      if (this.options.opacity > 0) filterCanvas(canvas, this.options.minDbz, this.options.palette);
      done(null, canvas);
    };
    img.onerror = () => done(new Error("tile load failed"), canvas);
    img.src = this.getTileUrl(coords);
    return canvas;
  },

  setOpacity(opacity) {
    const wasHidden = !(this.options.opacity > 0);
    L.TileLayer.prototype.setOpacity.call(this, opacity);
    if (wasHidden && opacity > 0) this._filterLoadedTiles();
    return this;
  },

  /** Filter every loaded, not-yet-filtered tile in place (no redraw, no flicker). */
  _filterLoadedTiles() {
    const { minDbz, palette: paletteId } = this.options;
    for (const key of Object.keys(this._tiles || {})) {
      const t = this._tiles[key];
      if (t && t.loaded && t.el && t.el.tagName === "CANVAS") filterCanvas(t.el, minDbz, paletteId);
    }
  },
});

/**
 * react-leaflet component: same props as `<TileLayer>` plus `minDbz` and
 * `palette` (reflectivity palette id; "nws" leaves IEM's colours alone).
 */
const FilteredTileLayer = createLayerComponent(
  function createFilteredTileLayer({ url, minDbz, palette: paletteId, ...options }, ctx) {
    const layer = new FilteredGridLayer(url, { ...options, minDbz, palette: paletteId });
    return { instance: layer, context: { ...ctx, overlayContainer: layer } };
  },
  function updateFilteredTileLayer(layer, props, prevProps) {
    updateGridLayer(layer, props, prevProps);
    if (props.url !== prevProps.url) layer.setUrl(props.url);
    if (props.minDbz !== prevProps.minDbz || props.palette !== prevProps.palette) {
      layer.options.minDbz = props.minDbz;
      layer.options.palette = props.palette;
      layer.redraw();
    }
    // react-leaflet's updateGridLayer only forwards opacity/zIndex; the
    // deferred filtering hooks setOpacity, so make sure it is what runs.
    if (props.opacity !== prevProps.opacity) layer.setOpacity(props.opacity);
  },
);

export default FilteredTileLayer;
