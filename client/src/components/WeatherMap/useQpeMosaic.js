// Poller for the MRMS rainfall-accumulation mosaic (accumulation mode's
// low-zoom layer). One GET a minute; the ~250 KB field is only replaced
// when the file key changes (a new MRMS frame lands every 2 min).

import { useState, useEffect, useRef } from "react";
import axios from "axios";
import { rleDecode } from "../../../../server/precipType";
import { decodeBins } from "./radialRender";

const POLL_INTERVAL_MS = 60 * 1000;
const EMPTY = { field: null, stale: false, unavailable: null };

/**
 * Keep the newest MRMS QPE field for a period decoded and current.
 *
 * @param {Object} params
 * @param {Number|null} params.periodMin 60 or 180 (null: no mosaic for this product)
 * @param {Boolean} params.enabled false stops polling and drops the field
 * @param {Boolean} [params.paused] true stops polling but keeps the field
 * @returns {{field: Object|null, stale: Boolean, unavailable: String|null}}
 *   `field` is `{key, grid, cells, validTime, periodMin, maxIn}` with `cells`
 *   one accumulation tier per 2 km cell (see server/accumulation.js)
 */
export default function useQpeMosaic({ periodMin, enabled, paused = false }) {
  const [state, setState] = useState(EMPTY);
  const keyRef = useRef(null);

  useEffect(() => {
    if (!enabled || !periodMin) {
      keyRef.current = null;
      setState(EMPTY);
      return undefined;
    }
    if (paused) return undefined;
    let cancelled = false;

    const poll = () => {
      axios.get("/api/radar/qpe-mosaic", { params: { period: periodMin } })
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
              key: d.key, grid: d.grid, cells, validTime: d.validTime, periodMin: d.periodMin, maxIn: d.maxIn,
            },
            stale: false,
            unavailable: null,
          });
        })
        .catch(() => {
          if (cancelled) return;
          setState((prev) => ({ ...prev, stale: true }));
        });
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, paused, periodMin]);

  return state;
}
