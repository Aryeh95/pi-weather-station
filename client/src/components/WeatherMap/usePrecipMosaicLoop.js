// Historical MRMS precipitation-type frames for loop playback at mosaic
// zoom — the counterpart of useRadarRadialLoop for the type mosaic.
//
// Each frame stamp (a mosaic frame's UTC minute, "YYYYMMDDHHMM") is fetched
// from /api/radar/precip-mosaic?stamp=, which answers with the MRMS pair
// nearest that minute. The payload is kept RUN-LENGTH ENCODED (~215 KB per
// frame) rather than decoded: eleven decoded CONUS fields would be ~66 MB
// on a phone, while decoding one on demand as the playhead lands on it is
// ~10–20 ms (WeatherMap does that with useMemo). Misses (no MRMS file within
// the server's window) are remembered briefly and retried, like the radial
// loop's.

import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { decodeBins } from "./radialRender";

const MISS_RETRY_MS = 2 * 60 * 1000;
// Pause between fetches so a burst of eleven does not starve the live poll.
const PACE_MS = 200;

/**
 * Keep encoded type-mosaic frames cached for a list of stamps.
 *
 * @param {Object} params
 * @param {Array<String>} params.stamps frame stamps, in fetch-priority order
 * @param {Boolean} params.enabled false stops fetching and clears everything
 * @param {Boolean} [params.paused] true stops the pump but keeps the cache
 * @returns {{byStamp: Object<String, {key: String, grid: Object, rle: Uint8Array, validTime: String, rateAvailable: Boolean}>}}
 */
export default function usePrecipMosaicLoop({ stamps, enabled, paused = false }) {
  const [byStamp, setByStamp] = useState({});
  const cacheRef = useRef(new Map());
  const generationRef = useRef(0);

  // Leaving the mode or the band drops everything; `paused` deliberately
  // does not (see useRadarRadialLoop for the same rule).
  useEffect(() => {
    generationRef.current += 1;
    cacheRef.current.clear();
    setByStamp({});
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !stamps || !stamps.length) return undefined;
    if (paused) return undefined;
    const gen = generationRef.current;
    let cancelled = false;

    const publish = () => {
      const out = {};
      for (const [k, v] of cacheRef.current) {
        if (v && v.rle) out[k] = v;
      }
      setByStamp(out);
    };

    const wanted = new Set(stamps);
    for (const k of [...cacheRef.current.keys()]) {
      if (!wanted.has(k)) cacheRef.current.delete(k);
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
          const res = await axios.get("/api/radar/precip-mosaic", { params: { stamp: s } });
          const d = res.data || {};
          if (cancelled || generationRef.current !== gen) return;
          if (d.available && d.grid && d.data) {
            cacheRef.current.set(s, {
              key: d.key,
              grid: d.grid,
              rle: decodeBins(d.data),
              validTime: d.validTime,
              rateAvailable: Boolean(d.rate && d.rate.available),
            });
            publish();
          } else {
            cacheRef.current.set(s, { miss: true, at: Date.now() });
          }
        } catch {
          cacheRef.current.set(s, { miss: true, at: Date.now() });
        }
        await new Promise((r) => setTimeout(r, PACE_MS));
        s = nextStamp();
      }
    };
    pump();

    return () => { cancelled = true; };
  }, [enabled, paused, stamps]);

  return { byStamp };
}
