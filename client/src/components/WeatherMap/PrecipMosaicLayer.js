// Viewport-fitted renderer for the MRMS precipitation-type mosaic.
//
// The field is a CONUS-wide 2 km grid (see usePrecipMosaic). Rendering all
// of it at a useful resolution would be a ~12 M pixel canvas (≈ 46 MB
// decoded) that is mostly off screen; instead this paints ONLY the current
// view plus a half-view margin on every side, at about twice the screen's
// pixel density, into an ImageOverlay. Panning inside the margin costs
// nothing (Leaflet transforms the image); leaving it, or zooming by more
// than REZOOM_DELTA, re-renders — a lookup-only loop over ≤ 3072² pixels,
// tens of milliseconds, since the mercator maths is done once per row and
// once per column rather than per pixel.
//
// Same geometry rule as radialRender: an ImageOverlay is mapped LINEARLY
// in Web Mercator between its corners, so rows are stepped in mercator y
// and converted back with the exact inverse Gudermannian.

import React, { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { ImageOverlay, useMap, useMapEvents } from "react-leaflet";
import { buildPrecipLut } from "../../../../server/precipType";

// Margin around the view, as a fraction of the view size, on each side.
export const PAD = 0.5;
// Largest canvas edge. Bounds decoded-bitmap memory (3072² ≈ 38 MB worst
// case on a very large kiosk; a phone's view renders far smaller).
export const MAX_PX = 3072;
// Zoom change that forces a re-render even inside the margin — beyond it
// the rendered pixels are visibly coarser (or wastefully finer) than the
// screen's.
export const REZOOM_DELTA = 0.75;
// Rendered images kept per field key for the CURRENT view: the eleven
// loop frames plus the newest. A loop pass renders each frame once (a
// 2560 × 1600 PNG encode is a few hundred ms on a phone); every pass after
// that is an instant swap, exactly like the tile stacks' opacity flips.
export const RENDER_CACHE_MAX = 14;

const toMerc = (latDeg) => Math.asinh(Math.tan((latDeg * Math.PI) / 180));
const fromMerc = (ym) => (Math.atan(Math.sinh(ym)) * 180) / Math.PI;

/**
 * Paint the part of a field inside `bounds` onto a new canvas.
 *
 * @param {{grid: Object, cells: Uint8Array}} field decoded mosaic (grid lat0/lon0 are CELL CENTRES)
 * @param {{south: Number, west: Number, north: Number, east: Number}} bounds geographic corners
 * @param {Number} width canvas width, px
 * @param {Number} height canvas height, px
 * @param {Number} [minDbz] noise-filter floor (tiers below it are not drawn)
 * @returns {HTMLCanvasElement} the painted canvas
 */
export function renderPrecipCanvas(field, bounds, width, height, minDbz) {
  const { grid, cells } = field;
  const lut32 = new Uint32Array(buildPrecipLut(minDbz).buffer);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  const px32 = new Uint32Array(img.data.buffer);

  // Column → grid column, once.
  const col = new Int32Array(width);
  const lonSpan = bounds.east - bounds.west;
  for (let x = 0; x < width; x += 1) {
    const lon = bounds.west + ((x + 0.5) / width) * lonSpan;
    const c = Math.round((lon - grid.lon0) / grid.dLon);
    col[x] = (c >= 0 && c < grid.ni) ? c : -1;
  }
  const yN = toMerc(bounds.north);
  const yS = toMerc(bounds.south);
  for (let y = 0; y < height; y += 1) {
    const lat = fromMerc(yN - ((y + 0.5) / height) * (yN - yS));
    const r = Math.round((grid.lat0 - lat) / grid.dLat);
    if (r < 0 || r >= grid.nj) continue;
    const rowBase = r * grid.ni;
    const out = y * width;
    for (let x = 0; x < width; x += 1) {
      const c = col[x];
      if (c < 0) continue;
      const level = cells[rowBase + c];
      if (level === 0) continue;
      px32[out + x] = lut32[level];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Does the rendered image still cover the current view well enough?
 *
 * @param {{bounds: Object, zoom: Number}|null} rendered what is on screen
 * @param {Object} view Leaflet LatLngBounds of the current view
 * @param {Number} zoom current zoom
 * @returns {Boolean} true when no re-render is needed
 */
export function renderCovers(rendered, view, zoom) {
  if (!rendered) return false;
  if (Math.abs(zoom - rendered.zoom) >= REZOOM_DELTA) return false;
  const b = rendered.bounds;
  return view.getSouth() >= b.south && view.getNorth() <= b.north
    && view.getWest() >= b.west && view.getEast() <= b.east;
}

/**
 * The MRMS precipitation-type mosaic as a viewport-fitted ImageOverlay.
 *
 * @param {Object} props
 * @param {Object|null} props.field decoded field from usePrecipMosaic, or null to draw nothing (the layer stays mounted so its render cache survives a loop frame that has not arrived yet)
 * @param {Number} props.opacity overlay opacity (0 hides without unmounting)
 * @param {Number} [props.minDbz] noise-filter floor
 * @returns {JSX.Element|null} the overlay once rendered
 */
const PrecipMosaicLayer = ({ field, opacity, minDbz }) => {
  const map = useMap();
  const [img, setImg] = useState(null);
  // The view the cache was rendered for; a move outside it empties the cache.
  const renderedRef = useRef(null);
  // field.key|minDbz → {url, bounds}; insertion order is eviction order.
  const cacheRef = useRef(new Map());
  const aliveRef = useRef(true);

  const clearCache = useCallback(() => {
    for (const v of cacheRef.current.values()) URL.revokeObjectURL(v.url);
    cacheRef.current.clear();
  }, []);

  const render = useCallback(() => {
    if (!field) {
      setImg(null);
      return;
    }
    const size = map.getSize();
    if (size.x < 1 || size.y < 1) return;
    const cacheKey = `${field.key}|${minDbz ?? "none"}`;
    const view = map.getBounds();
    const zoom = map.getZoom();
    // Same view as the cache was built for, and this frame already drawn?
    if (renderCovers(renderedRef.current, view, zoom) && cacheRef.current.has(cacheKey)) {
      const hit = cacheRef.current.get(cacheKey);
      setImg({ url: hit.url, bounds: hit.leaflet });
      return;
    }
    if (!renderCovers(renderedRef.current, view, zoom)) {
      // New view → every cached image is for the wrong place or scale.
      clearCache();
      const padLat = (view.getNorth() - view.getSouth()) * PAD;
      const padLon = (view.getEast() - view.getWest()) * PAD;
      renderedRef.current = {
        bounds: {
          south: Math.max(-85, view.getSouth() - padLat),
          north: Math.min(85, view.getNorth() + padLat),
          west: view.getWest() - padLon,
          east: view.getEast() + padLon,
        },
        zoom,
        width: Math.min(MAX_PX, Math.ceil(size.x * (1 + 2 * PAD))),
        height: Math.min(MAX_PX, Math.ceil(size.y * (1 + 2 * PAD))),
      };
    }
    const { bounds, width, height } = renderedRef.current;
    const canvas = renderPrecipCanvas(field, bounds, width, height, minDbz);
    canvas.toBlob((blob) => {
      if (!blob || !aliveRef.current) return;
      // The view may have moved while encoding; a stale render must not
      // enter the cache for the new view.
      if (renderedRef.current && renderedRef.current.bounds !== bounds) return;
      const url = URL.createObjectURL(blob);
      const leaflet = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
      cacheRef.current.set(cacheKey, { url, leaflet });
      while (cacheRef.current.size > RENDER_CACHE_MAX) {
        const oldest = cacheRef.current.keys().next().value;
        URL.revokeObjectURL(cacheRef.current.get(oldest).url);
        cacheRef.current.delete(oldest);
      }
      setImg({ url, bounds: leaflet });
    }, "image/png");
  }, [map, field, minDbz, clearCache]);

  // New field (a loop frame, a new scan) or filter state: paint it — from
  // the cache when this view has seen it before.
  useEffect(() => {
    render();
  }, [render]);

  // Moved or zoomed: repaint only when the view has left the rendered
  // image's margin or the zoom has changed enough to matter.
  useMapEvents({
    moveend: () => {
      if (!renderCovers(renderedRef.current, map.getBounds(), map.getZoom())) render();
    },
  });

  useEffect(() => () => {
    aliveRef.current = false;
    clearCache();
  }, [clearCache]);

  if (!img) return null;
  // Keyed on the URL so a repaint swaps the bitmap atomically rather than
  // leaving the old one up while the new decodes.
  return <ImageOverlay key={img.url} url={img.url} bounds={img.bounds} opacity={opacity} />;
};

PrecipMosaicLayer.propTypes = {
  field: PropTypes.shape({
    grid: PropTypes.object.isRequired,
    cells: PropTypes.instanceOf(Uint8Array).isRequired,
    key: PropTypes.string.isRequired,
  }),
  opacity: PropTypes.number.isRequired,
  minDbz: PropTypes.number,
};

export default PrecipMosaicLayer;
