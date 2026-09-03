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
const ROUTES = {
  "/api/radar/site": getRadarSite,
  "/api/radar/frames": getRadarFrames,
  "/api/radar/radial": getRadarRadial,
  "/api/storm-tracks": getStormTracks,
  "/api/lightning": getLightning,
  "/api/weather-alerts": getWeatherAlerts,
  "/api/nearby-alerts": getNearbyAlerts,
  "/api/reverse-geocode": reverseGeocode,
  "/api/sunrise-sunset": sunriseSunset,
  // Not under /api/ — a legacy path from before the prefix existed.
  "/geolocation": ipGeolocation,
};

// Endpoints that exist only to serve the kiosk's own hardware and
// self-management. The app answers them itself so the components that poll
// them (health chip, update checker, settings panel) see a well-formed
// "nothing to do here" rather than a network error every cycle.
//
// `/settings` reports the two keys as absent: the app needs neither. The
// basemap is keyless (see ./upstream) and the place name comes from NWS,
// so `mapApiKey` being empty must NOT trigger the missing-key prompt —
// `AppContext` skips that prompt in standalone mode.
const STUBS = {
  "/settings": () => ({ status: 200, body: {} }),
  "/api/is-local": () => ({ status: 200, body: { isLocal: false } }),
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
 * @returns {Promise<{status: Number, body: *}>} what the server would have sent
 */
export async function handleApi(pathname, query) {
  const stub = STUBS[pathname];
  if (stub) return stub();

  const handler = ROUTES[pathname];
  if (!handler) return { status: 404, body: `No standalone handler for ${pathname}` };

  const req = { query: query || {}, params: {}, isLocal: false };
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
  return path === "/settings" || path === "/geolocation" || path.startsWith("/api/");
}
