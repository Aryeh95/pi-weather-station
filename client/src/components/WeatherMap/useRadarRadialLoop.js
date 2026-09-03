// Historical raw-radial frames for loop playback.
//
// The latest-frame radial renderer (useRadarRadial) made "now" sharp,
// but every historical frame in the loop still came from IEM's
// pre-smoothed tiles — so a 30-frame playback was 29 soft frames and a
// visibly sharper finale. This hook backfills the loop: for each frame
// stamp it fetches the matching raw N0B scan (`/api/radar/radial?stamp=`)
// and renders it through the exact same canvas pipeline, storing the
// result as an object URL.
//
// Budget thinking, because 30 frames of raw radials is a lot of pixels:
//   - RENDERS happen once per (scan, filter-state): ~300 ms each, paced
//     with a yield between frames so the warmup doesn't freeze the UI.
//     A full 30-frame warmup finishes in ~15 s of background work.
//   - BLOB URLS are cheap (a mostly-transparent 2560 px PNG compresses
//     small), so every frame's URL stays cached for instant replays.
//   - DECODED BITMAPS are the expensive part (~26 MB each), so the map
//     mounts only a sliding window of overlays around the playhead —
//     that decision lives in WeatherMap, not here.
//
// Misses (scan not in the bucket yet) are remembered briefly and then
// retried — mirroring the server's own short negative-cache TTL.

import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { renderRadialImage, decodeBins, NOISE_FILTER_MIN_DBZ } from "./radialRender";

// How long a "no matching scan" result stands before the stamp is tried
// again — matches the server's negative-cache TTL.
const MISS_RETRY_MS = 2 * 60 * 1000;

// Pause between successive fetch+render cycles. The render itself blocks
// the main thread for a few hundred ms; this gap keeps playback and map
// interaction responsive while the loop warms up.
const PACE_MS = 150;

/**
 * Keep rendered raw-radial images cached for a list of frame stamps.
 *
 * @param {Object} params
 * @param {String|null} params.site 3-letter NEXRAD id
 * @param {Array<String>} params.stamps frame stamps to cover, in fetch-priority order
 * @param {Boolean} params.enabled false pauses fetching and clears everything
 * @param {Boolean} params.noiseFilter hide echoes below NOISE_FILTER_MIN_DBZ (reflectivity only)
 * @param {String} [params.product] "N0B" (reflectivity, default) or "N0G" (velocity)
 * @param {Boolean} [params.paused] true stops the warm-up pump but keeps rendered frames
 * @returns {{byStamp: Object<String, {url: String, bounds: Array}>}} rendered frames
 */
export default function useRadarRadialLoop({ site, stamps, enabled, noiseFilter, product = "N0B", paused = false }) {
  const [byStamp, setByStamp] = useState({});
  // stamp → {url, bounds} for rendered frames, {miss: true, at} for
  // known-absent scans. Lives in a ref so the pump can mutate it without
  // re-running effects; `byStamp` is the published, render-ready view.
  const cacheRef = useRef(new Map());
  const generationRef = useRef(0);

  const revokeAll = () => {
    for (const v of cacheRef.current.values()) {
      if (v && v.url) URL.revokeObjectURL(v.url);
    }
    cacheRef.current.clear();
  };

  // Site, product or filter changed (or the layer left view): everything
  // cached was rendered for the wrong site/product/filter, so drop it.
  // Bumping the generation makes any in-flight pump abandon its results.
  // `paused` is deliberately NOT here — pausing must keep the cache.
  useEffect(() => {
    generationRef.current += 1;
    revokeAll();
    setByStamp({});
  }, [site, product, noiseFilter, enabled]);

  useEffect(() => {
    if (!enabled || !site || !stamps || !stamps.length) return undefined;
    if (paused) return undefined;
    const gen = generationRef.current;
    let cancelled = false;

    const publish = () => {
      const out = {};
      for (const [k, v] of cacheRef.current) {
        if (v && v.url) out[k] = v;
      }
      setByStamp(out);
    };

    // Frames that rolled off the list free their URLs before new work
    // starts — keeps the cache bounded at the loop length by construction.
    const wanted = new Set(stamps);
    for (const [k, v] of cacheRef.current) {
      if (!wanted.has(k)) {
        if (v && v.url) URL.revokeObjectURL(v.url);
        cacheRef.current.delete(k);
      }
    }

    const nextStamp = () => stamps.find((s) => {
      const v = cacheRef.current.get(s);
      if (v === undefined) return true;
      return Boolean(v && v.miss && Date.now() - v.at > MISS_RETRY_MS);
    });

    const pump = async () => {
      let s = nextStamp();
      while (!cancelled && generationRef.current === gen && s) {
        try {
          const res = await axios.get("/api/radar/radial", { params: { site, product, stamp: s } });
          const d = res.data || {};
          if (cancelled || generationRef.current !== gen) return;
          if (d.available) {
            const minDbz = noiseFilter ? NOISE_FILTER_MIN_DBZ : undefined;
            const { canvas, bounds } = renderRadialImage(d, decodeBins(d.bins), minDbz);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
            if (cancelled || generationRef.current !== gen) return;
            if (blob) {
              cacheRef.current.set(s, { url: URL.createObjectURL(blob), bounds });
              publish();
            } else {
              cacheRef.current.set(s, { miss: true, at: Date.now() });
            }
          } else {
            cacheRef.current.set(s, { miss: true, at: Date.now() });
          }
        } catch {
          // Transient failure — treat like a miss so it retries later
          // instead of hot-looping against a down server.
          cacheRef.current.set(s, { miss: true, at: Date.now() });
        }
        await new Promise((r) => setTimeout(r, PACE_MS));
        s = nextStamp();
      }
    };
    pump();

    return () => { cancelled = true; };
  }, [site, product, enabled, paused, noiseFilter, stamps]);

  // Revoke everything on unmount — each URL pins a blob for the life of
  // the page otherwise.
  useEffect(() => () => revokeAll(), []);  // eslint-disable-line react-hooks/exhaustive-deps -- unmount-only cleanup of the ref cache

  return { byStamp };
}
