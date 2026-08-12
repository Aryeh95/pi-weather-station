// Client-side renderer for raw NEXRAD super-res base reflectivity.
//
// This is the RadarScope-parity path: instead of showing IEM's
// pre-rendered (and measurably smoothed) tiles, the raw N0B radial data
// from /api/radar/radial is drawn here, gate by gate, into a canvas that
// becomes a Leaflet ImageOverlay.
//
// Approach: INVERSE mapping. The canvas covers a square in Web Mercator
// space centred on the radar; every pixel is mapped mercator → lat/lon →
// azimuth/range → radial bucket + range bin → colour. Rendering once per
// data frame (one volume scan, every 4-6 min) into an image with fixed
// geographic bounds means Leaflet handles pan/zoom by transforming the
// image — no per-frame redraws while the user moves the map.
//
// Because the overlay is mapped linearly in MERCATOR space between its
// corner coordinates (that is how L.ImageOverlay positions an image), the
// pixel grid must be uniform in mercator — so rows are converted with the
// exact inverse Gudermannian (lat = atan(sinh(y))), not a linear-in-lat
// approximation. Azimuth/range from the site then uses a local
// equirectangular step, whose error over a 300 km disc is far below one
// gate.

// Display clip. N0B data reaches 460 km, but rendering the full disc at
// gate resolution would need a ~7000 px canvas; 300 km at 2560 px gives
// ~234 m/px — at the 250 m range-gate size, effectively lossless — and
// comfortably covers the viewport at every zoom where this layer shows.
export const RADIAL_RADIUS_KM = 300;
export const RADIAL_CANVAS_PX = 2560;

const EARTH_R_KM = 6371;

// NWS-classic reflectivity ramp: [dBZ, r, g, b, a] stops, linearly
// interpolated between entries. Below the first stop is transparent —
// sub-0 dBZ is clear-air return that would smear the kiosk with noise.
// The alpha ramp keeps light precipitation translucent so the basemap
// reads through, matching how the IEM tiles behaved.
export const DBZ_STOPS = [
  [0, 90, 95, 115, 70],
  [5, 4, 233, 231, 190],
  [10, 1, 159, 244, 215],
  [15, 3, 0, 244, 230],
  [20, 2, 253, 2, 255],
  [25, 1, 197, 1, 255],
  [30, 0, 142, 0, 255],
  [35, 253, 248, 2, 255],
  [40, 229, 188, 0, 255],
  [45, 253, 149, 0, 255],
  [50, 253, 0, 0, 255],
  [55, 212, 0, 0, 255],
  [60, 188, 0, 0, 255],
  [65, 248, 0, 253, 255],
  [70, 152, 84, 198, 255],
  [75, 253, 253, 253, 255],
];

/**
 * RGBA for a reflectivity value, interpolated along DBZ_STOPS.
 *
 * @param {Number} dbz reflectivity
 * @returns {[Number, Number, Number, Number]} [r, g, b, a] 0-255
 */
export function colorForDbz(dbz) {
  if (dbz < DBZ_STOPS[0][0]) return [0, 0, 0, 0];
  const last = DBZ_STOPS[DBZ_STOPS.length - 1];
  if (dbz >= last[0]) return [last[1], last[2], last[3], last[4]];
  for (let i = 1; i < DBZ_STOPS.length; i += 1) {
    if (dbz < DBZ_STOPS[i][0]) {
      const lo = DBZ_STOPS[i - 1];
      const hi = DBZ_STOPS[i];
      const t = (dbz - lo[0]) / (hi[0] - lo[0]);
      return [
        Math.round(lo[1] + (hi[1] - lo[1]) * t),
        Math.round(lo[2] + (hi[2] - lo[2]) * t),
        Math.round(lo[3] + (hi[3] - lo[3]) * t),
        Math.round(lo[4] + (hi[4] - lo[4]) * t),
      ];
    }
  }
  return [0, 0, 0, 0];
}

/**
 * Precompute the 256-entry level → RGBA lookup for a product's scaling.
 * Levels 0 and 1 are below-threshold/missing by the ICD and stay
 * transparent; level L ≥ 2 decodes as `min + L × increment` dBZ.
 *
 * @param {{min: Number, increment: Number}} scaling from /api/radar/radial
 * @returns {Uint8ClampedArray} 256 × 4 RGBA entries
 */
export function buildLevelLut(scaling) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let level = 2; level < 256; level += 1) {
    const [r, g, b, a] = colorForDbz(scaling.min + level * scaling.increment);
    lut[level * 4] = r;
    lut[level * 4 + 1] = g;
    lut[level * 4 + 2] = b;
    lut[level * 4 + 3] = a;
  }
  return lut;
}

/**
 * Geographic bounds of the rendered square, as Leaflet corner latLngs.
 * Derived from the same mercator half-width the pixel loop uses, so the
 * overlay's corners land exactly where the pixels were computed.
 *
 * @param {Number} lat radar latitude
 * @param {Number} lon radar longitude
 * @returns {{bounds: Array, halfMerc: Number, ym0: Number, xm0: Number}}
 */
export function radialBounds(lat, lon) {
  const lat0 = (lat * Math.PI) / 180;
  const xm0 = (lon * Math.PI) / 180;
  const ym0 = Math.asinh(Math.tan(lat0));
  // Mercator stretches ground distance by 1/cos(lat); a small margin
  // keeps the disc fully inside the square at the poleward edge.
  const halfMerc = ((RADIAL_RADIUS_KM / EARTH_R_KM) / Math.cos(lat0)) * 1.02;
  const north = (Math.atan(Math.sinh(ym0 + halfMerc)) * 180) / Math.PI;
  const south = (Math.atan(Math.sinh(ym0 - halfMerc)) * 180) / Math.PI;
  const east = ((xm0 + halfMerc) * 180) / Math.PI;
  const west = ((xm0 - halfMerc) * 180) / Math.PI;
  return { bounds: [[south, west], [north, east]], halfMerc, ym0, xm0 };
}

/**
 * Render a radial payload into a canvas + its geographic bounds.
 *
 * Runs once per volume scan (~every 4-6 min); ~6.5 M pixels with a
 * per-row fast path (row latitude, cos and northward offset computed
 * once per row, azimuth/range per pixel). A few hundred ms on the
 * kiosk's x86 — irrelevant at this cadence.
 *
 * @param {Object} data /api/radar/radial payload (bins already decoded)
 * @param {Uint8Array} bins raw levels, numBuckets × numBins
 * @returns {{canvas: HTMLCanvasElement, bounds: Array}} drawable + corners
 */
export function renderRadialImage(data, bins) {
  const size = RADIAL_CANVAS_PX;
  const { radar, numBuckets, bucketDeg, numBins, binKm, firstBinKm, scaling } = data;
  const lut = buildLevelLut(scaling);
  // (xm0 is only needed for the bounds themselves — the column loop is
  // symmetric around the site, so it works in offsets.)
  const { bounds, halfMerc, ym0 } = radialBounds(radar.lat, radar.lon);
  const lat0 = (radar.lat * Math.PI) / 180;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const px = img.data;

  // Column mercator offsets are row-independent; hoist them.
  const colMerc = new Float64Array(size);
  for (let x = 0; x < size; x += 1) {
    colMerc[x] = (((x + 0.5) / size) * 2 - 1) * halfMerc * EARTH_R_KM;
  }

  const degPerRad = 180 / Math.PI;
  for (let y = 0; y < size; y += 1) {
    // Rows top → bottom = north → south in mercator.
    const ym = ym0 + (1 - ((y + 0.5) / size) * 2) * halfMerc;
    const latr = Math.atan(Math.sinh(ym));
    const dyKm = (latr - lat0) * EARTH_R_KM;
    const cosLat = Math.cos(latr);
    const rowOff = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const dxKm = colMerc[x] * cosLat;
      const range = Math.sqrt(dxKm * dxKm + dyKm * dyKm);
      const bin = Math.floor((range - firstBinKm) / binKm);
      if (bin < 0 || bin >= numBins || range > RADIAL_RADIUS_KM) continue;
      let az = Math.atan2(dxKm, dyKm) * degPerRad;
      if (az < 0) az += 360;
      const bucket = Math.min(numBuckets - 1, Math.floor(az / bucketDeg));
      const level = bins[bucket * numBins + bin];
      if (level < 2) continue;
      const l4 = level * 4;
      const o = rowOff + x * 4;
      px[o] = lut[l4];
      px[o + 1] = lut[l4 + 1];
      px[o + 2] = lut[l4 + 2];
      px[o + 3] = lut[l4 + 3];
    }
  }

  ctx.putImageData(img, 0, 0);
  return { canvas, bounds };
}

/**
 * Decode the payload's base64 bin block into a Uint8Array.
 *
 * @param {String} b64 base64 levels from /api/radar/radial
 * @returns {Uint8Array} raw levels
 */
export function decodeBins(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
