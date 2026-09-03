// MRMS MESH — Maximum Estimated Size of Hail, from NOAA's Multi-Radar
// Multi-Sensor system, sampled at the storm cells the STI product tracks.
//
// WHY: the per-radar Hail Index (NHI), Storm Structure (NSS) and TVS (NTV)
// products stopped being archived in the public Level III bucket after
// 2022, so a cell's hail size cannot come from the single-radar feed any
// more. MRMS MESH is the operational NOAA/NSSL hail product — every radar
// that sees the storm merged onto a 1 km CONUS grid every two minutes —
// and it is public and keyless on the `noaa-mrms-pds` bucket.
//
// NO SYSTEM DEPENDENCY. MRMS GRIB2 files use PNG packing (data
// representation template 5.41): section 7 is literally a 16-bit
// grayscale PNG, so Node's own zlib decodes the field. Verified live
// 2026-09-03 against eccodes' `grib_ls` on the same file:
//
//   grid 7000 × 3500 at 0.01°, first point 54.995 N / 230.005 E
//   (−129.995), scanning mode 0 (north → south, west → east)
//   packing grid_png, 16 bits, reference −30, binary scale 0,
//   decimal scale 1  →  value_mm = (−30 + X) / 10
//   file ~54–120 KB gzipped, one every 2 min; −3 = no data, −1 = no
//   coverage; 0 = no hail; max in the verified file 59.1 mm
//
// Decoding a whole CONUS frame is ~24.5 M pixels — a few hundred ms in
// JS — so the grid is reduced immediately to a sparse list of hail
// points (value > 0) and the 49 MB raster is dropped. Cells sample the
// maximum MESH within a small radius of their centre.

const zlib = require("zlib");
const axios = require("axios");
const { recordServiceCall } = require("./serviceStatus");
const { increment } = require("./requestCounter");

const SERVICE_NAME = "MRMS (hail)";
const BUCKET_BASE = "https://noaa-mrms-pds.s3.amazonaws.com";
const PRODUCT_PREFIX = "CONUS/MESH_00.50";
const API_TIMEOUT_MS = 15_000;

// New file every ~2 min; the listing and the decoded field share that cadence.
const LIST_TTL_MS = 60 * 1000;
const FIELD_TTL_MS = 2 * 60 * 1000;

// Radius around a SCIT cell centre to search for its hail maximum. A cell
// centroid and the MESH core rarely coincide exactly; ~10 km covers a
// large cell without borrowing its neighbour's hail.
const SAMPLE_RADIUS_KM = 10;

// Below this the product is reporting graupel-sized noise; treat as none.
const MIN_REPORT_MM = 5;

let listCache = null;   // { value: key|null, expires }
let fieldCache = null;  // { key, value: {points, validTime}, expires }
// One decode per file even when several requests arrive together.
const inflightByKey = new Map();
const inflight = (key, fn) => {
  if (inflightByKey.has(key)) return inflightByKey.get(key);
  const p = fn().finally(() => inflightByKey.delete(key));
  inflightByKey.set(key, p);
  return p;
};

/**
 * UTC date folder for the bucket, YYYYMMDD.
 *
 * @param {Date} d
 * @returns {String}
 */
function dayFolder(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Validity time encoded in a MESH key
 * (`…/MRMS_MESH_00.50_20260903-132641.grib2.gz`).
 *
 * @param {String} key bucket key
 * @returns {String|null} ISO time, or null
 */
function keyValidTime(key) {
  const m = /_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.grib2/.exec(key || "");
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, hh, mm, ss)).toISOString();
}

/**
 * Newest MESH key, looking at today's folder and, around midnight UTC,
 * yesterday's.
 *
 * @returns {Promise<String|null>}
 */
async function latestKey() {
  if (listCache && listCache.expires > Date.now()) return listCache.value;
  const now = new Date();
  let best = null;
  for (const d of [now, new Date(now.getTime() - 86_400_000)]) {
    // eslint-disable-next-line no-await-in-loop -- stop at the first day with data
    const res = await axios.get(BUCKET_BASE, {
      params: { "list-type": 2, prefix: `${PRODUCT_PREFIX}/${dayFolder(d)}/`, "max-keys": 1000 },
      timeout: API_TIMEOUT_MS,
      responseType: "text",
    });
    increment("mrms", "list");
    const keys = [...String(res.data).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    if (keys.length) {
      best = keys[keys.length - 1];
      break;
    }
  }
  listCache = { value: best, expires: Date.now() + LIST_TTL_MS };
  return best;
}

/**
 * Parse the GRIB2 sections we need out of one MRMS message.
 *
 * Only the layouts MRMS uses are supported (grid template 3.0 lat/lon,
 * data representation template 5.41 PNG). Anything else throws, which the
 * caller turns into "hail unavailable" rather than a wrong number.
 *
 * @param {Buffer} buf uncompressed GRIB2 file
 * @returns {{ni: Number, nj: Number, lat0: Number, lon0: Number, dLat: Number, dLon: Number, ref: Number, binScale: Number, decScale: Number, bits: Number, png: Buffer}} field description and the PNG payload
 */
function parseGrib2(buf) {
  if (buf.toString("ascii", 0, 4) !== "GRIB") throw new Error("not GRIB");
  if (buf[7] !== 2) throw new Error(`GRIB edition ${buf[7]}`);
  let p = 16;
  const out = {};
  while (p < buf.length - 4) {
    if (buf.toString("ascii", p, p + 4) === "7777") break;
    const len = buf.readUInt32BE(p);
    const sec = buf[p + 4];
    if (sec === 3) {
      const template = buf.readUInt16BE(p + 12);
      if (template !== 0) throw new Error(`grid template ${template}`);
      // Template 3.0 octets (1-based within the section): Ni 31-34,
      // Nj 35-38, La1 47-50, Lo1 51-54, Di 64-67, Dj 68-71, scanning
      // mode 72. Offsets below are 0-based from the section start.
      out.ni = buf.readUInt32BE(p + 30);
      out.nj = buf.readUInt32BE(p + 34);
      out.lat0 = buf.readInt32BE(p + 46) / 1e6;
      out.lon0 = buf.readUInt32BE(p + 50) / 1e6;
      out.dLon = buf.readUInt32BE(p + 63) / 1e6;
      out.dLat = buf.readUInt32BE(p + 67) / 1e6;
      out.scanMode = buf[p + 71];
    } else if (sec === 5) {
      const template = buf.readUInt16BE(p + 9);
      if (template !== 41) throw new Error(`packing template ${template}`);
      out.ref = buf.readFloatBE(p + 11);
      out.binScale = buf.readInt16BE(p + 15);
      out.decScale = buf.readInt16BE(p + 17);
      out.bits = buf[p + 19];
    } else if (sec === 7) {
      out.png = buf.subarray(p + 5, p + len);
    }
    p += len;
  }
  if (!out.png || !out.ni) throw new Error("incomplete GRIB2 message");
  return out;
}

/**
 * Decode a 16-bit grayscale PNG (as MRMS packs it) into raw sample values.
 *
 * @param {Buffer} png the PNG file bytes
 * @param {Number} width expected width
 * @param {Number} height expected height
 * @returns {Uint16Array} width × height samples, row-major
 */
function decodePng16(png, width, height) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not PNG");
  let p = 8;
  const idat = [];
  let bitDepth = 0;
  let colorType = 0;
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString("ascii", p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      if (data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height) {
        throw new Error("PNG size does not match grid");
      }
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }
  if (bitDepth !== 16 || colorType !== 0) throw new Error(`PNG ${bitDepth}-bit type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 2;
  const stride = width * bpp;
  const out = new Uint16Array(width * height);
  let prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    const base = y * width;
    for (let x = 0; x < width; x += 1) out[base + x] = (cur[x * 2] << 8) | cur[x * 2 + 1];
    prev = Buffer.from(cur);
  }
  return out;
}

/**
 * Reduce a decoded MESH field to its hail points.
 *
 * @param {Object} g parsed GRIB2 description (see parseGrib2)
 * @param {Uint16Array} samples decoded PNG samples
 * @param {Number} [minMm] ignore values below this
 * @returns {Array<[Number, Number, Number]>} [lat, lon(−180..180), mm] for every point ≥ minMm
 */
function hailPoints(g, samples, minMm = MIN_REPORT_MM) {
  const scale = 2 ** g.binScale / 10 ** g.decScale;
  const offset = g.ref * (1 / 10 ** g.decScale);
  // Smallest raw sample that reaches minMm — compare integers in the loop.
  const minRaw = Math.ceil((minMm - offset) / scale);
  const out = [];
  for (let j = 0; j < g.nj; j += 1) {
    const lat = g.lat0 - j * g.dLat; // scanning mode 0: north → south
    const base = j * g.ni;
    for (let i = 0; i < g.ni; i += 1) {
      const raw = samples[base + i];
      if (raw < minRaw) continue;
      let lon = g.lon0 + i * g.dLon;
      if (lon > 180) lon -= 360;
      out.push([lat, lon, Math.round((offset + raw * scale) * 10) / 10]);
    }
  }
  return out;
}

/**
 * Fetch, decode and reduce the newest MESH field. Cached per file.
 *
 * @returns {Promise<{points: Array, validTime: String|null, key: String}|null>} null when no file is available
 */
async function fetchField() {
  const key = await latestKey();
  if (!key) return null;
  if (fieldCache && fieldCache.key === key && fieldCache.expires > Date.now()) return fieldCache.value;
  return inflight(key, async () => {
    const res = await axios.get(`${BUCKET_BASE}/${key}`, { responseType: "arraybuffer", timeout: API_TIMEOUT_MS });
    increment("mrms", "mesh");
    const grib = zlib.gunzipSync(Buffer.from(res.data));
    const g = parseGrib2(grib);
    const samples = decodePng16(g.png, g.ni, g.nj);
    const points = hailPoints(g, samples);
    const value = { points, validTime: keyValidTime(key), key };
    fieldCache = { key, value, expires: Date.now() + FIELD_TTL_MS };
    recordServiceCall(SERVICE_NAME, 200, `${points.length} hail points in ${key.split("/").pop()}`);
    return value;
  });
}

/**
 * Maximum MESH within `radiusKm` of a point.
 *
 * @param {Array<[Number, Number, Number]>} points hail points
 * @param {Number} lat
 * @param {Number} lon
 * @param {Number} [radiusKm]
 * @returns {Number|null} mm, or null when no point lies within the radius
 */
function maxWithin(points, lat, lon, radiusKm = SAMPLE_RADIUS_KM) {
  const dLatMax = radiusKm / 110.574;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLonMax = radiusKm / (111.32 * cos);
  const r2 = radiusKm * radiusKm;
  let best = null;
  for (const [pl, pn, mm] of points) {
    if (Math.abs(pl - lat) > dLatMax || Math.abs(pn - lon) > dLonMax) continue;
    const dy = (pl - lat) * 110.574;
    const dx = (pn - lon) * 111.32 * cos;
    if (dx * dx + dy * dy <= r2 && (best === null || mm > best)) best = mm;
  }
  return best;
}

/**
 * Attach a `hail` attribute to each storm cell (mutates the cells) and
 * return the field metadata for the payload. Never throws: a MESH outage
 * leaves the cells without hail rather than failing the tracks.
 *
 * @param {Array<Object>} cells storm cells with lat/lon
 * @returns {Promise<{source: String, validTime: String|null, available: Boolean}>} field metadata
 */
async function attachHail(cells) {
  const meta = { source: "MRMS MESH", validTime: null, available: false };
  if (!Array.isArray(cells) || !cells.length) return meta;
  try {
    const field = await fetchField();
    if (!field) return meta;
    meta.validTime = field.validTime;
    meta.available = true;
    for (const c of cells) {
      if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
      const mm = maxWithin(field.points, c.lat, c.lon);
      c.hail = mm === null ? null : { meshMm: mm, meshIn: Math.round((mm / 25.4) * 100) / 100 };
    }
  } catch (err) {
    const status = err?.response?.status || 500;
    recordServiceCall(SERVICE_NAME, status, `MESH unavailable: ${err.message}`);
  }
  return meta;
}

module.exports = {
  attachHail,
  // Exported for tests.
  parseGrib2,
  decodePng16,
  hailPoints,
  maxWithin,
  keyValidTime,
  SAMPLE_RADIUS_KM,
  MIN_REPORT_MM,
};
