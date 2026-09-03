// Installs the standalone API in front of axios.
//
// Every client call to the server goes through axios with a same-origin path
// (`axios.get("/api/radar/frames", …)`), so swapping the axios ADAPTER routes
// those calls to `handleApi` without touching a single hook or component. The
// alternative — editing ~10 hooks to branch on the build — would leave the
// kiosk and app paths free to drift; here they are the same call site.
//
// The adapter, not an interceptor: an interceptor cannot answer a request, it
// can only rewrite it, so a request interceptor would still need the network
// layer beneath it to be a no-op. The adapter IS the network layer, which is
// exactly the seam this needs.
//
// The controllers themselves call axios for their upstreams. Those are
// absolute URLs, so `isStandaloneRoute` returns false and they fall straight
// through to the real adapter — the one this wraps rather than replaces.

import axios from "axios";
import { AxiosError, getAdapter } from "axios";
import { handleApi, isStandaloneRoute } from "./api";

/**
 * Point axios at the in-app API for same-origin `/api/*` requests.
 *
 * Idempotent: calling twice leaves one wrapper installed.
 */
export default function installStandaloneApi() {
  if (axios.defaults.adapter?.__sweepStandalone) return;

  // Resolve the platform adapter ONCE, before the swap: `getAdapter` on
  // `axios.defaults.adapter` after the swap would hand back this wrapper and
  // build an infinite loop the first time an upstream call passed through.
  const network = getAdapter(axios.defaults.adapter);

  /**
   * @param {object} config axios request config
   * @returns {Promise<object>} axios response
   */
  const adapter = async (config) => {
    if (!isStandaloneRoute(config.url)) return network(config);

    const path = String(config.url).split("?")[0];
    // Query params reach axios either in `config.params` or already inline in
    // the URL; the hooks use `params`, but honour both so a hand-written call
    // site does not silently lose its arguments.
    const query = { ...paramsFromUrl(config.url), ...normaliseParams(config.params) };

    // axios has already serialised `data` for a JSON request; the handlers
    // want the object Express's body-parser would have produced.
    let payload = config.data;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { /* leave as the raw string */ }
    }
    const method = String(config.method || "get").toUpperCase();

    const { status, body } = await handleApi(path, query, method, payload);
    const response = {
      data: body,
      status,
      statusText: status === 200 ? "OK" : String(status),
      headers: {},
      config,
      request: null,
    };

    const validate = config.validateStatus || ((s) => s >= 200 && s < 300);
    if (validate(status)) return response;
    throw new AxiosError(
      `Request failed with status code ${status}`,
      status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      null,
      response
    );
  };

  adapter.__sweepStandalone = true;
  axios.defaults.adapter = adapter;
}

/**
 * Pull query parameters out of a URL string.
 *
 * @param {string} url request URL
 * @returns {object} decoded parameters
 */
function paramsFromUrl(url) {
  const qs = String(url).split("?")[1];
  if (!qs) return {};
  return Object.fromEntries(new URLSearchParams(qs).entries());
}

/**
 * Normalise axios `params` to the string-valued object Express would hand a
 * handler, dropping the undefined entries axios omits from a query string.
 *
 * @param {object} params axios params object
 * @returns {object} query-parameter object
 */
function normaliseParams(params) {
  if (!params) return {};
  if (params instanceof URLSearchParams) return Object.fromEntries(params.entries());
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}
