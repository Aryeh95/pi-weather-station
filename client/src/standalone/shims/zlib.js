// Browser stand-in for the two Node `zlib` calls the MRMS hail decoder makes.
//
// `server/mrmsHailCtrl.js` runs unmodified inside the app (see
// `standalone/api.js` for why the real controllers are reused rather than
// reimplemented), and it needs SYNCHRONOUS inflate: the GRIB2 parser walks
// the message section by section and unpacks the PNG payload inline. The
// platform's `DecompressionStream` is async-only, so pako — the same zlib
// port webpack ecosystems have used for a decade — provides the sync path.
//
// Only the two functions the controller actually calls are implemented; an
// unimplemented member should fail loudly rather than silently return
// undefined, so nothing else is stubbed.

import { inflate, ungzip } from "pako";

/**
 * Raw DEFLATE/zlib inflate (PNG IDAT payloads).
 *
 * @param {Uint8Array|Buffer} buf compressed bytes
 * @returns {Buffer} inflated bytes
 */
export function inflateSync(buf) {
  return Buffer.from(inflate(buf));
}

/**
 * gzip member inflate (the `.grib2.gz` MRMS objects).
 *
 * @param {Uint8Array|Buffer} buf gzipped bytes
 * @returns {Buffer} inflated bytes
 */
export function gunzipSync(buf) {
  return Buffer.from(ungzip(buf));
}

export default { inflateSync, gunzipSync };
