// Standalone API — the server, running inside the app.
//
// WHY THIS EXISTS
// ---------------
// The kiosk build talks to `server/index.js` over the LAN, which is why the
// phone needed a VPN to see radar from anywhere. Every upstream this project
// uses is public, keyless and CORS-open (verified 2026-09-03: IEM, NWS,
// `unidata-nexrad-level3`, `noaa-mrms-pds` and `noaa-goes19` all answer
// `Access-Control-Allow-Origin: *`), so the browser can fetch them directly
// and the Node process is not actually required for radar at all.
//
// WHY THE REAL CONTROLLERS, NOT A REIMPLEMENTATION
// ------------------------------------------------
// The obvious approach — rewrite the fetch/parse logic against browser APIs —
// forks the hard-won parts of this project: the product-153/154 shim, the
// MOVEMENT-is-a-FROM-direction handling, the 8-bit/16-bit MRMS PNG split, the
// ±150 s frame-to-bucket-key matching. Those took live debugging to get right
// and their bugs are subtle and weather-dependent — exactly the kind that
// reappear in a parallel copy months later, on the platform where they are
// hardest to observe.
//
// So the controllers are imported and run VERBATIM. They already turned out
// to be portable: `require("axios")` works in a browser, and the only Node
// built-ins in the whole set are two `zlib` calls, plus `fs`/`path` in two
// best-effort caches. Those are aliased to `standalone/shims/*` by
// `webpack.app.config.js`. The server tests therefore cover the app's data
// path too, and a fix made for the kiosk lands in the app on the next build.
//
// The controllers are Express handlers, so this module supplies the two
// things Express would: a `req` carrying parsed query params, and a `res`
// that captures status and body instead of writing to a socket.

import { getRadarSite, getRadarFrames } from "../../../server/iemRadarCtrl";
import { getRadarRadial } from "../../../server/radarRadialCtrl";
import { getStormTracks } from "../../../server/stormTracksCtrl";
import { getLightning } from "../../../server/glmLightningCtrl";
import { getWeatherAlerts, getNearbyAlerts } from "../../../server/govAlertsCtrl";
import { reverseGeocode, sunriseSunset, ipGeolocation } from "./upstream";
import { getSettings, setSetting, createSettings } from "./settingsStore";

/**
 * Express `res` stand-in: records what the handler tried to send.
 *
 * The controllers all end with `res.status(n).json(body).end()`, so status,
 * json and end are chainable and `end()` is a no-op terminator.
 *
 * @returns {object} collector exposing `status`/`json`/`end` plus the result
 */
function makeRes() {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(body) {
      out.body = body;
      return res;
    },
    send(body) {
      out.body = body;
      return res;
    },
    set() {
      return res;
    },
    end() {
      return res;
    },
    out,
  };
  return res;
}

// Route table. Paths are matched exactly (the app makes no parameterised
// API calls — map tiles, the one `:style/:z/:x/:y` route, are fetched by
// Leaflet as <img> and never reach axios; see `mapTileUrl` in ./upstream).
//
// `isLocal: false` is passed on every request: it gates the gov-alert test
// injection and the kiosk-only settings writes, neither of which the app has.
// Keyed by "METHOD path" because `/settings` is both a read and a write.
const ROUTES = {
  "GET /api/radar/site": getRadarSite,
  "GET /api/radar/frames": getRadarFrames,
  "GET /api/radar/radial": getRadarRadial,
  "GET /api/storm-tracks": getStormTracks,
  "GET /api/lightning": getLightning,
  "GET /api/weather-alerts": getWeatherAlerts,
  "GET /api/nearby-alerts": getNearbyAlerts,
  "GET /api/reverse-geocode": reverseGeocode,
  "GET /api/sunrise-sunset": sunriseSunset,
  // Not under /api/ — legacy paths from before the prefix existed.
  "GET /geolocation": ipGeolocation,
  // Settings live in localStorage here (./settingsStore): the `advanced`
  // subtree and `favorites` are written through these routes, so without
  // them those controls would look editable and lose every change.
  "GET /settings": getSettings,
  "POST /settings": createSettings,
  "PATCH /setting": setSetting,
};

// Endpoints that exist only to serve the kiosk's own hardware and
// self-management. The app answers them itself so the components that poll
// them (health chip, update checker, settings panel) see a well-formed
// "nothing to do here" rather than a network error every cycle.
//
// The settings the app DOES keep are served by ./settingsStore above; what
// remains here is the kiosk's own hardware and self-management.
//
// `isLocal` is true: it means "this client may change its own settings",
// which on a phone that stores them itself is simply the case. Nothing
// dangerous rides on it — the debug panel additionally needs `debugEnabled`
// (absent here) and the update button needs `updateAvailable` (false below).
const STUBS = {
  "/api/is-local": () => ({ status: 200, body: { isLocal: true } }),
  "/api/update-check": () => ({
    status: 200,
    body: { updateAvailable: false, standalone: true },
  }),
  // The health panel classifies upstreams from the SERVER's request log,
  // which does not exist here. Report the app shell as healthy and say so,
  // rather than inventing per-service verdicts the app cannot observe.
  "/api/health": () => ({
    status: 200,
    body: { status: "ok", standalone: true, services: [], issues: [] },
  }),
  "/api/brightness": () => ({ status: 200, body: { percent: 100 } }),
  "/api/display-scale": () => ({ status: 200, body: { scale: 1 } }),
};

/**
 * Run one API path through the in-app implementation.
 *
 * @param {string} pathname request path, e.g. `/api/radar/frames`
 * @param {object} query parsed query parameters
 * @param {string} [method] HTTP method, uppercase
 * @param {*} [body] parsed request body, for writes
 * @returns {Promise<{status: Number, body: *}>} what the server would have sent
 */
export async function handleApi(pathname, query, method = "GET", body = undefined) {
  const stub = STUBS[pathname];
  if (stub) return stub();

  const handler = ROUTES[`${method} ${pathname}`];
  if (!handler) {
    return { status: 404, body: `No standalone handler for ${method} ${pathname}` };
  }

  // `isLocal: true` for the same reason the stub reports it — the device owns
  // its settings. It also un-gates the gov-alert test-alert opt-in, which is
  // a per-device display preference.
  const req = { query: query || {}, params: {}, body, isLocal: true };
  const res = makeRes();
  await handler(req, res);
  return { status: res.out.statusCode, body: res.out.body };
}

/**
 * True when `url` is a request this module should answer.
 *
 * Only same-origin API paths qualify. The controllers' own upstream calls go
 * out on absolute URLs and must fall through to the real network adapter —
 * that check is what keeps this from swallowing them.
 *
 * @param {string} url request URL as axios received it
 * @returns {boolean} whether to intercept
 */
export function isStandaloneRoute(url) {
  if (typeof url !== "string") return false;
  const path = url.split("?")[0];
  return (
    path === "/settings"
    || path === "/setting"
    || path === "/geolocation"
    || path.startsWith("/api/")
  );
}
