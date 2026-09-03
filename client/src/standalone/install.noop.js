// Kiosk-build stand-in for ./install.js.
//
// `src/index.js` calls `installStandaloneApi()` behind `if (__STANDALONE__)`,
// which the DefinePlugin folds to `if (false)` — but the static import above
// it is a dependency either way, so the kiosk bundle would still pull in the
// whole server controller tree (and fail to resolve its `fs`/`path` requires,
// which only the app config shims).
//
// `webpack.config.js` therefore points `~/standalone/install` at this file
// unless STANDALONE is set. An alias rather than a dynamic import: a dynamic
// import would emit a chunk into the committed `dist/`, which CI checks for
// drift against a clean build.

/** No-op: the kiosk talks to the real server. */
export default function installStandaloneApi() {
  // Intentionally empty — see the module comment.
}
