// The app's stand-in for `settings.json`.
//
// The kiosk keeps its server-side settings in a file that only localhost may
// write. The app has no server and no file, but it still needs somewhere
// durable for the same shape of data — the `advanced` subtree (radar opacity,
// alert radius) and `favorites` are both written through `PATCH /setting`,
// so without a store behind that route those controls would appear editable
// and silently lose every change on relaunch.
//
// localStorage is the right home for it here: per-device, survives restarts,
// and is exactly the scope of "this phone's preferences". The API keys the
// real file also holds are deliberately absent — the app needs none, and the
// Settings panel hides that section entirely in standalone builds.

const STORAGE_KEY = "sweep.app.settings.v1";

// The subset of the server's ALLOWED_KEYS that means anything without a
// server. Writes to anything else are refused with the same 400 the server
// would send, rather than quietly accepted into a store nothing reads.
const ALLOWED_KEYS = new Set([
  "advanced",
  "favorites",
  "startingLat",
  "startingLon",
]);

/**
 * Read the whole settings object.
 *
 * @returns {object} stored settings, or `{}` when nothing is stored yet
 */
export function readSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Corrupt entry, or storage disabled. An empty object is the same state
    // a fresh install has, and every caller already handles it.
    return {};
  }
}

/**
 * Replace the whole settings object.
 *
 * @param {object} next settings to store
 * @returns {boolean} whether the write succeeded
 */
function writeSettings(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * `GET /settings` — the app's own settings, with no key fields.
 *
 * @param {object} req Express-shaped request (unused)
 * @param {object} res Express-shaped response collector
 * @returns {object} the response collector
 */
export function getSettings(req, res) {
  return res.status(200).json(readSettings()).end();
}

/**
 * `PATCH /setting` — merge one top-level key, matching the server's contract
 * (`{ key, val }`, 400 on a missing or unknown key).
 *
 * @param {object} req Express-shaped request carrying `body.key` / `body.val`
 * @param {object} res Express-shaped response collector
 * @returns {object} the response collector
 */
export function setSetting(req, res) {
  const { key, val } = req.body || {};
  if (!key || val === undefined || val === null) {
    return res.status(400).json("You must supply a key and val").end();
  }
  if (!ALLOWED_KEYS.has(key)) {
    return res.status(400).json("Unknown setting key").end();
  }
  const next = { ...readSettings(), [key]: val };
  if (!writeSettings(next)) {
    return res.status(500).json("Could not persist setting").end();
  }
  return res.status(200).json(next).end();
}

/**
 * `POST /settings` — replace the stored object wholesale.
 *
 * @param {object} req Express-shaped request whose `body` is the new settings
 * @param {object} res Express-shaped response collector
 * @returns {object} the response collector
 */
export function createSettings(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const next = Object.fromEntries(
    Object.entries(body).filter(([k]) => ALLOWED_KEYS.has(k))
  );
  if (!writeSettings(next)) {
    return res.status(500).json("Could not persist settings").end();
  }
  return res.status(200).json(next).end();
}
