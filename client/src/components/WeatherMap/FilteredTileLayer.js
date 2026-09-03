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

/**
 * Make every pixel below `minDbz` transparent, in place.
 *
 * Exported for tests: pure function over an RGBA buffer.
 *
 * @param {Uint8ClampedArray} rgba canvas pixel data
 * @param {Number} minDbz threshold; pixels decoding below it are cleared
 * @returns {Number} how many pixels were cleared
 */
export function filterPixels(rgba, minDbz) {
  let cleared = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const dbz = DBZ_BY_COLOR.get(rgbKey(rgba[i], rgba[i + 1], rgba[i + 2]));
    if (dbz !== undefined && dbz < minDbz) {
      rgba[i + 3] = 0;
      cleared += 1;
    }
  }
  return cleared;
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
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, size.x, size.y);
      try {
        const data = ctx.getImageData(0, 0, size.x, size.y);
        filterPixels(data.data, this.options.minDbz);
        ctx.putImageData(data, 0, 0);
      } catch {
        // Tainted canvas (CORS) — the unfiltered image is already drawn.
      }
      done(null, canvas);
    };
    img.onerror = () => done(new Error("tile load failed"), canvas);
    img.src = this.getTileUrl(coords);
    return canvas;
  },
});

/**
 * react-leaflet component: same props as `<TileLayer>` plus `minDbz`.
 */
const FilteredTileLayer = createLayerComponent(
  function createFilteredTileLayer({ url, minDbz, ...options }, ctx) {
    const layer = new FilteredGridLayer(url, { ...options, minDbz });
    return { instance: layer, context: { ...ctx, overlayContainer: layer } };
  },
  function updateFilteredTileLayer(layer, props, prevProps) {
    updateGridLayer(layer, props, prevProps);
    if (props.url !== prevProps.url) layer.setUrl(props.url);
    if (props.minDbz !== prevProps.minDbz) {
      layer.options.minDbz = props.minDbz;
      layer.redraw();
    }
  },
);

export default FilteredTileLayer;
