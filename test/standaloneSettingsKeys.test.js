// Every setting the client writes has to be writable on BOTH surfaces.
//
// The kiosk's allowlist lives in `server/settingsCtrl.js` and the Android
// app keeps a parallel one in `client/src/standalone/settingsStore.js`,
// because without a server only some settings mean anything. Two lists
// drift, and when they do the app fails silently in the worst way: the
// PATCH 400s, `pickRadarSite`'s optimistic local state makes the pin look
// like it took, and the next settings hydrate quietly reverts it.
//
// That is exactly what happened when `radarSite` was added on 2026-09-14
// — the server learned the key, the app did not. So rather than compare
// two hand-written lists, this derives the requirement from the code that
// actually does the writing: every key passed to `PATCH /setting` anywhere
// in the client must be accepted by both allowlists.
//
// Run: `npm test`

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CLIENT_SRC = path.join(__dirname, "..", "client", "src");
const APP_STORE = path.join(CLIENT_SRC, "standalone", "settingsStore.js");
const SERVER_CTRL = path.join(__dirname, "..", "server", "settingsCtrl.js");

/**
 * Every .js file under a directory.
 *
 * @param {string} dir root to walk
 * @returns {Array<string>} absolute paths
 */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * The contents of an `ALLOWED_KEYS = new Set([...])` literal, read as
 * text so this works across the CommonJS server and the ES-module app
 * store without a bundler.
 *
 * @param {string} file path to read
 * @returns {Set<string>} the quoted entries
 */
function allowedKeys(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = /ALLOWED_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(m, `no ALLOWED_KEYS set found in ${path.basename(file)}`);
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

/**
 * Keys the client hands to `PATCH /setting`.
 *
 * @returns {Map<string, string>} key → the file that writes it
 */
function patchedKeys() {
  const found = new Map();
  for (const file of jsFiles(CLIENT_SRC)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/patch\(\s*"\/setting"\s*,\s*\{\s*key:\s*"([^"]+)"/g)) {
      found.set(m[1], path.relative(CLIENT_SRC, file));
    }
  }
  return found;
}

test("every setting the client writes is allowed on both surfaces", () => {
  const app = allowedKeys(APP_STORE);
  const server = allowedKeys(SERVER_CTRL);
  const written = patchedKeys();

  // Sanity: the scan found the writers at all, so an empty result can
  // never pass this file vacuously.
  assert.ok(written.size >= 4, `expected several PATCH /setting writers, found ${written.size}`);
  assert.ok(written.has("radarSite"), "expected the site picker's writer to be found");

  for (const [key, where] of written) {
    assert.ok(server.has(key), `server/settingsCtrl.js rejects "${key}", written by ${where}`);
    assert.ok(app.has(key), `the app's settingsStore rejects "${key}", written by ${where} — `
      + "the PATCH 400s there and the optimistic local state reverts on the next hydrate");
  }
});

test("the app's allowlist stays a subset of the server's", () => {
  // The app may keep FEWER settings (an API key means nothing without a
  // server) but never a key the server would refuse.
  const app = allowedKeys(APP_STORE);
  const server = allowedKeys(SERVER_CTRL);
  for (const key of app) {
    assert.ok(server.has(key), `the app allows "${key}" but the server does not`);
  }
});
