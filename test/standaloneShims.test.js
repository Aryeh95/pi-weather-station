// Guards for the two browser shims the Android app build depends on
// (client/src/standalone/shims/). Both replace a Node facility the app has
// no access to, and both fail in ways that stay invisible until a specific
// kind of weather shows up on a phone — so they are pinned here instead.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// pako lives in the CLIENT dependency tree — it is the app bundle's zlib, not
// the server's — so these comparisons need `npm ci` to have been run in
// client/ as well as at the root. Requiring it at module scope took the whole
// file down with it when only the root tree was installed, which is how CI ran
// for eight commits: the two table guards below need nothing but the root
// tree, and they were being skipped for want of a module they never touch.
// CI installs both trees now (.github/workflows/ci.yml); this keeps a
// root-only checkout useful rather than red.
let pako = null;
try {
  pako = require("../client/node_modules/pako");
} catch {
  pako = null;
}
const noPako = pako
  ? false
  : "client/node_modules/pako is not installed — run `npm ci` in client/";

const SHIM_DIR = path.join(__dirname, "..", "client", "src", "standalone", "shims");
const PKG_SRC = path.join(__dirname, "..", "node_modules", "nexrad-level-3-data", "src");

/**
 * Collect the module names a shim requires out of the Level III package.
 *
 * @param {string} file shim filename under standalone/shims
 * @returns {Array<string>} the last path segment of each require, in order
 */
function requiredNames(file) {
  const src = fs.readFileSync(path.join(SHIM_DIR, file), "utf8");
  return [...src.matchAll(/require\("nexrad-level-3-data\/src\/[a-z]+\/([^"]+)"\)/g)]
    .map((m) => m[1]);
}

test("the static product table lists every product the library ships", () => {
  // The library builds this table with fs.readdirSync at import time, which a
  // webpack bundle cannot do, so the app replaces it with an explicit list
  // (webpack.app.config.js). A library upgrade that added a product would
  // silently drop it from the app, and the omission would surface only as a
  // decode failure for one product in one kind of storm. Fail here instead.
  const onDisk = fs
    .readdirSync(path.join(PKG_SRC, "products"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.deepEqual(requiredNames("nexradProducts.js").sort(), onDisk.sort());
});

test("the static packet table lists every packet the library ships", () => {
  const onDisk = fs
    .readdirSync(path.join(PKG_SRC, "packets"), { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name !== "index.js")
    .map((e) => e.name.replace(/\.js$/, ""));
  assert.deepEqual(requiredNames("nexradPackets.js").sort(), onDisk.sort());
});

test("the pako zlib shim decodes MRMS gzip byte-for-byte like Node's zlib", { skip: noPako }, () => {
  // The hail decoder needs SYNCHRONOUS inflate, which the platform's
  // DecompressionStream cannot provide, so the app swaps in pako. A silent
  // difference here would reproduce the 2026-09-03 incident where a decode
  // failure read as "no hail" for every cell. Both committed frames are
  // checked because they differ in PNG bit depth.
  for (const name of [
    "MRMS_MESH_00.50_20260903-133641.grib2.gz",
    "MRMS_MESH_00.50_20260903-140242.grib2.gz",
  ]) {
    const gz = fs.readFileSync(path.join(__dirname, "fixtures", name));
    const viaNode = zlib.gunzipSync(gz);
    const viaPako = Buffer.from(pako.ungzip(gz));
    assert.equal(viaPako.length, viaNode.length, `${name} length`);
    assert.ok(viaPako.equals(viaNode), `${name} contents`);
  }
});

test("the pako zlib shim inflates a deflate stream like Node's zlib", { skip: noPako }, () => {
  // The GRIB2 payload's inner PNG is inflated through the same shim; a
  // round-trip pins that path too.
  const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  const deflated = zlib.deflateSync(payload);
  assert.ok(Buffer.from(pako.inflate(deflated)).equals(payload));
});
