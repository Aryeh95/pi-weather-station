// Browser stand-in for Node's `fs`, for modules that reach the app only
// incidentally.
//
// Two reach it: `server/requestCounter.js` persists per-service call counts
// to a JSON file, and `server/geolocationCtrl.js` caches reverse-geocode
// results the same way. Neither is load-bearing — both are best-effort
// telemetry/caching wrapped in try/catch at every call site — so the app
// runs them against a filesystem that is permanently empty and unwritable.
//
// `existsSync` returning false is what makes the callers take their
// "no cache yet" branch; `readFileSync` throwing matches what those same
// callers already handle when the file is missing on a fresh install.

/**
 * @returns {boolean} always false — nothing is persisted in the app
 */
export function existsSync() {
  return false;
}

/**
 * @throws {Error} always — callers treat this as "no cache on disk"
 */
export function readFileSync() {
  const err = new Error("ENOENT: no filesystem in the app shell");
  err.code = "ENOENT";
  throw err;
}

/** Accepts and discards the write. */
export function writeFileSync() {
  // Intentionally not persisted — see the module comment.
}

/** Accepts and discards the directory creation. */
export function mkdirSync() {
  // Intentionally not persisted — see the module comment.
}

export default { existsSync, readFileSync, writeFileSync, mkdirSync };
