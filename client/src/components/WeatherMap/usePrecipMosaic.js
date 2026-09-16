// Poller for the MRMS surface precipitation-type mosaic
// (/api/radar/precip-mosaic) — the low-zoom half of precipitation-type
// mode.
//
// One CONUS frame every 2 min, ~290 KB of run-length-encoded bytes, kept
// DECODED here (a 3500 × 1750 Uint8Array, ~6 MB) so PrecipMosaicLayer can
// paint whatever the viewport shows without another fetch. The server
// caches per file, so polling once a minute costs one small JSON round
// trip when nothing has changed; the field is only replaced when the file
// key changes.

import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { rleDecode } from "../../../../server/precipType";
import { decodeBins } from "./radialRender";

const POLL_INTERVAL_MS = 60 * 1000;

const EMPTY = { field: null, stale: false, unavailable: null };

/**
 * Keep the newest MRMS precipitation-type field decoded and current.
 *
 * @param {Object} params
 * @param {Boolean} params.enabled false stops polling and drops the field
 * @param {Boolean} [params.paused] true stops polling but keeps the field
 * @returns {{field: Object|null, stale: Boolean, unavailable: String|null}}
 *   `field` is `{key, grid, cells, validTime, rateAvailable}` with `cells` a
 *   Uint8Array of encoded class/tier bytes (see server/precipType.js);
 *   `stale` flags a failing refresh (the last field stays); `unavailable`
 *   carries the server's reason when no frame exists.
 */
export default function usePrecipMosaic({ enabled, paused = false }) {
  const [state, setState] = useState(EMPTY);
  const keyRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      keyRef.current = null;
      setState(EMPTY);
      return undefined;
    }
    if (paused) return undefined;
    let cancelled = false;

    const poll = () => {
      axios.get("/api/radar/precip-mosaic")
        .then((res) => {
          if (cancelled) return;
          const d = res.data || {};
          if (!d.available || !d.grid || !d.data) {
            keyRef.current = null;
            setState({ field: null, stale: false, unavailable: d.reason || "unavailable" });
            return;
          }
          if (d.key && d.key === keyRef.current) {
            setState((prev) => (prev.stale ? { ...prev, stale: false } : prev));
            return;
          }
          const cells = rleDecode(decodeBins(d.data), d.grid.ni * d.grid.nj);
          keyRef.current = d.key;
          setState({
            field: {
              key: d.key,
              grid: d.grid,
              cells,
              validTime: d.validTime,
              rateAvailable: Boolean(d.rate && d.rate.available),
            },
            stale: false,
            unavailable: null,
          });
        })
        .catch(() => {
          if (cancelled) return;
          // Keep the last field, flagged — same convention as every other
          // poller: a failing refresh is visible, not silent.
          setState((prev) => ({ ...prev, stale: true }));
        });
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, paused]);

  return state;
}
