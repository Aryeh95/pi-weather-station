// Minimal POSIX `path` for the app shell. The only paths that reach it are
// the synthetic cache-file names built by `requestCounter` and
// `geolocationCtrl`, which the `fs` shim then refuses — so this needs to be
// correct enough to produce a string, not to be a general path library.

/**
 * Join segments with single separators, dropping empty ones.
 *
 * @param {...string} parts path segments
 * @returns {string} joined path
 */
export function join(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/");
}

/**
 * @param {...string} parts path segments
 * @returns {string} joined path, rooted
 */
export function resolve(...parts) {
  const joined = join(...parts);
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * @param {string} p path
 * @returns {string} everything before the last separator
 */
export function dirname(p) {
  const i = String(p).lastIndexOf("/");
  return i <= 0 ? "/" : String(p).slice(0, i);
}

/**
 * @param {string} p path
 * @returns {string} everything after the last separator
 */
export function basename(p) {
  return String(p).split("/").pop();
}

/**
 * @param {string} p path
 * @returns {string} extension including the dot, or ""
 */
export function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export default { join, resolve, dirname, basename, extname };
