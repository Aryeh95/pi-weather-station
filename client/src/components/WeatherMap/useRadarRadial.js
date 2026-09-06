// Poller + renderer driver for the raw-radial layer.
//
// Polls /api/radar/radial once a minute (the server caches 60 s; a new
// volume scan lands every 4-6 min), and re-renders the canvas ONLY when
// the product key changes — the render is the expensive step (~6.5 M
// pixels), so an unchanged scan must never re-run it.
//
// The rendered canvas is published as an object URL for Leaflet's
// ImageOverlay. Old URLs are revoked on replacement and unmount — each
// one pins a ~26 MB decoded image, so leaking them would matter fast on
// an always-on kiosk.

import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { renderRadialImage, decodeBins, NOISE_FILTER_MIN_DBZ } from "./radialRender";

const POLL_INTERVAL_MS = 60 * 1000;
// Dual-pol clean asked for, classification not published yet. The two
// products of one scan land ~30 s apart (measured on LWX), so a poll can
// fall in the gap and render the unfiltered bloom the mode exists to
// remove. Come back for it rather than waiting out the full minute.
const CLEAN_RETRY_MS = 20 * 1000;

/**
 * Keep a rendered raw-radial image current for a site.
 *
 * @param {Object} params
 * @param {String|null} params.site 3-letter NEXRAD id
 * @param {Boolean} params.enabled false pauses polling and clears the image
 * @param {Boolean} params.noiseFilter hide echoes below NOISE_FILTER_MIN_DBZ (reflectivity only)
 * @param {Boolean} [params.dualPolClean] also drop gates the scan's dual-pol classification calls non-meteorological (server side)
 * @param {String} [params.product] "N0B" (reflectivity, default) or "N0G" (velocity)
 * @param {Boolean} [params.paused] true suspends polling but keeps the current image
 * @returns {{url: String|null, bounds: Array|null, scanTime: String|null, stale: Boolean, cleanApplied: Boolean|null}}
 *   `cleanApplied` is null unless dual-pol clean was asked for: true when the
 *   scan's classification was found and used, false when it was not.
 */
export default function useRadarRadial({
  site, enabled, noiseFilter, dualPolClean = false, product = "N0B", paused = false,
}) {
  const [state, setState] = useState({ url: null, bounds: null, scanTime: null, stale: false, cleanApplied: null });
  const lastKeyRef = useRef(null);
  const urlRef = useRef(null);
  const cancelledRef = useRef(false);
  const retryRef = useRef(null);

  useEffect(() => {
    cancelledRef.current = false;

    const publish = (url, bounds, scanTime, cleanApplied = null) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setState({ url, bounds, scanTime, stale: false, cleanApplied });
    };

    if (!enabled || !site) {
      lastKeyRef.current = null;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
      setState({ url: null, bounds: null, scanTime: null, stale: false, cleanApplied: null });
      return () => { cancelledRef.current = true; };
    }
    // Paused: keep the rendered image, stop asking for new scans. The
    // effect re-runs on resume and fetches at once.
    if (paused) return undefined;

    const clearRetry = () => {
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
    };

    const fetchAndRender = () => {
      clearRetry();
      // The mask is applied server-side, before the bins are packed, so
      // the payload and the render are identical either way — only the
      // gates that survive differ.
      const params = { site, product };
      if (dualPolClean) params.clean = 1;
      axios.get("/api/radar/radial", { params })
        .then((res) => {
          if (cancelledRef.current) return;
          const d = res.data || {};
          if (!d.available) {
            // No recent product — clear so the tile fallback shows.
            lastKeyRef.current = null;
            publish(null, null, null);
            return;
          }
          // The render key carries the filter state too, so toggling the
          // noise filter re-renders the current scan instead of waiting
          // for the next one. It uses whether the mask was APPLIED, not
          // whether it was asked for: a scan with no classification
          // available comes back unmasked, and that is the same picture
          // the dBZ-only mode would have drawn.
          if (dualPolClean && d.clean && !d.clean.applied
              && d.clean.reason === "no-classification") {
            retryRef.current = setTimeout(fetchAndRender, CLEAN_RETRY_MS);
          }
          const renderKey = `${d.key}|${d.kind}|nf:${Boolean(noiseFilter)}|dp:${Boolean(d.clean?.applied)}`;
          if (renderKey === lastKeyRef.current) {
            // Same volume scan — refresh only the staleness flag.
            setState((prev) => (prev.stale ? { ...prev, stale: false } : prev));
            return;
          }
          const minDbz = noiseFilter ? NOISE_FILTER_MIN_DBZ : undefined;
          const { canvas, bounds } = renderRadialImage(d, decodeBins(d.bins), minDbz);
          canvas.toBlob((blob) => {
            if (cancelledRef.current || !blob) return;
            lastKeyRef.current = renderKey;
            publish(URL.createObjectURL(blob), bounds, d.scanTime,
                    dualPolClean ? Boolean(d.clean?.applied) : null);
          }, "image/png");
        })
        .catch(() => {
          if (cancelledRef.current) return;
          // Keep the last rendered frame, flagged stale — consistent with
          // the frame-list and storm-track pollers.
          setState((prev) => ({ ...prev, stale: true }));
        });
    };

    fetchAndRender();
    const id = setInterval(fetchAndRender, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
      clearRetry();
    };
  }, [site, enabled, noiseFilter, dualPolClean, product, paused]);

  // Revoke the final URL when the consumer unmounts.
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  return state;
}
