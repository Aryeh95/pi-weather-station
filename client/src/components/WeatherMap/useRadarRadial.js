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
// products of one scan land ~30-45 s apart (measured on LWX 2026-09-06:
// N0B at 04:43:35, N0H at 04:44:06), so a poll can fall in the gap and
// draw the unfiltered bloom the mode exists to remove. Come back for it
// rather than waiting out the full minute — but a bounded number of
// times, or a site whose classification simply is not published would
// poll forever.
const CLEAN_RETRY_MS = 10 * 1000;
const CLEAN_RETRY_LIMIT = 5; // ~50 s, i.e. up to the next scheduled poll

// While waiting, the frame already on screen is kept rather than replaced
// with the unmasked new one — swapping the bloom in for 20 s is the thing
// the mode exists to prevent, and the held frame is one volume scan old,
// not wrong. The frame-age chip reports the HELD frame's time, so the
// trade is visible rather than hidden.
//
// Bounded, because a site that stops publishing the classification
// altogether would otherwise freeze the radar indefinitely. Two volume
// scans of slack; past that the newest picture is worth more than the
// clean one, and the legend says the mask is unavailable.
const CLEAN_HOLD_MAX_MS = 10 * 60 * 1000;

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
 * @returns {{url: String|null, bounds: Array|null, scanTime: String|null, stale: Boolean, cleanApplied: Boolean|null, holdingClean: Boolean}}
 *   `cleanApplied` is null unless dual-pol clean was asked for: true when the
 *   scan's classification was found and used, false when it was not.
 *   `holdingClean` is true while an older clean frame is being kept on screen
 *   because the newest scan has no classification yet — `scanTime` is then the
 *   held frame's, not the newest scan's.
 */
export default function useRadarRadial({
  site, enabled, noiseFilter, dualPolClean = false, product = "N0B", paused = false,
}) {
  const [state, setState] = useState({
    url: null, bounds: null, scanTime: null, stale: false, cleanApplied: null, holdingClean: false,
  });
  const lastKeyRef = useRef(null);
  const urlRef = useRef(null);
  const cancelledRef = useRef(false);
  const retryRef = useRef(null);
  const retriesRef = useRef(0);
  // scanTime of the clean frame on screen, or null when it is not clean.
  const cleanFrameRef = useRef(null);

  useEffect(() => {
    cancelledRef.current = false;

    const publish = (url, bounds, scanTime, cleanApplied = null) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      // What is on screen now is what a later "hold" would hold.
      cleanFrameRef.current = cleanApplied === true ? scanTime : null;
      setState({ url, bounds, scanTime, stale: false, cleanApplied, holdingClean: false });
    };

    if (!enabled || !site) {
      lastKeyRef.current = null;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
      cleanFrameRef.current = null;
      setState({
        url: null, bounds: null, scanTime: null, stale: false, cleanApplied: null, holdingClean: false,
      });
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
    retriesRef.current = 0;

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
          const cleanApplied = dualPolClean ? Boolean(d.clean?.applied) : null;
          const pending = cleanApplied === false
            && d.clean?.reason === "no-classification";
          if (pending) {
            if (retriesRef.current < CLEAN_RETRY_LIMIT) {
              retriesRef.current += 1;
              retryRef.current = setTimeout(fetchAndRender, CLEAN_RETRY_MS);
            }
          } else {
            retriesRef.current = 0;
          }
          // Hold rather than swap in the bloom: the newest scan came back
          // unmasked only because its classification has not been published
          // yet (it lands 30-45 s after the reflectivity), and it will be
          // maskable within a retry or two. Keeping the last clean frame is
          // one volume scan of lag; showing the unmasked one is the picture
          // this mode exists to remove. Bounded — see CLEAN_HOLD_MAX_MS.
          if (pending && cleanFrameRef.current) {
            const heldAge = Date.now() - Date.parse(cleanFrameRef.current);
            if (!(heldAge >= CLEAN_HOLD_MAX_MS)) {
              setState((prev) => (
                (prev.stale || !prev.holdingClean)
                  ? { ...prev, stale: false, cleanApplied: true, holdingClean: true }
                  : prev
              ));
              return;
            }
            // Held too long — the classification is not merely late. Fall
            // through and draw the newest scan, unmasked and labelled so.
            cleanFrameRef.current = null;
          }
          const renderKey = `${d.key}|${d.kind}|nf:${Boolean(noiseFilter)}|dp:${Boolean(d.clean?.applied)}`;
          if (renderKey === lastKeyRef.current) {
            // Same pixels, so no re-render — but the CLEAN status under
            // them can still have changed, and an unmasked clean frame is
            // pixel-identical to the dBZ-only one, so this is exactly the
            // path a "classification not published yet" answer takes.
            // Publishing it is what keeps the legend from claiming a mask
            // that did not run (seen on the kiosk 2026-09-06).
            setState((prev) => (
              (prev.stale || prev.cleanApplied !== cleanApplied || prev.holdingClean)
                ? { ...prev, stale: false, cleanApplied, holdingClean: false }
                : prev
            ));
            return;
          }
          const minDbz = noiseFilter ? NOISE_FILTER_MIN_DBZ : undefined;
          const { canvas, bounds } = renderRadialImage(d, decodeBins(d.bins), minDbz);
          canvas.toBlob((blob) => {
            if (cancelledRef.current || !blob) return;
            lastKeyRef.current = renderKey;
            publish(URL.createObjectURL(blob), bounds, d.scanTime, cleanApplied);
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
