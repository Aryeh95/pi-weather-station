// Poller for the nowcast card.
//
// One GET /api/radar/nowcast a minute for the pin (the server caches the
// answer for a minute per newest scan, and a new volume scan lands every
// 4–6 min, so most polls are a cache hit). The pin is quantised to ~1 km
// so map jitter does not restart the poll; the site override rides along
// as the `site` query for the app, which has no settings.json to read.

import { useState, useEffect, useRef } from "react";
import axios from "axios";

const POLL_INTERVAL_MS = 60 * 1000;
const QUANT_DEG = 0.01;

/**
 * Keep the current nowcast for a home point.
 *
 * @param {Object} params
 * @param {Number|null} params.latitude pin
 * @param {Number|null} params.longitude pin
 * @param {String} [params.site] manual site override ("" for automatic)
 * @param {Boolean} params.enabled false stops polling and clears
 * @param {Boolean} [params.paused] true suspends polling but keeps the last answer
 * @returns {{data: Object|null, fetchedAt: Number|null, stale: Boolean, loading: Boolean}}
 */
export default function useNowcast({ latitude, longitude, site = "", enabled, paused = false }) {
  const [state, setState] = useState({ data: null, fetchedAt: null, stale: false, loading: false });
  const cancelledRef = useRef(false);

  const latKey = latitude != null ? Math.round(latitude / QUANT_DEG) : null;
  const lonKey = longitude != null ? Math.round(longitude / QUANT_DEG) : null;

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || latKey == null || lonKey == null) {
      setState({ data: null, fetchedAt: null, stale: false, loading: false });
      return () => { cancelledRef.current = true; };
    }
    if (paused) return undefined;
    const lat = latKey * QUANT_DEG;
    const lon = lonKey * QUANT_DEG;
    setState((prev) => (prev.data ? prev : { ...prev, loading: true }));

    const fetchNowcast = () => {
      const params = { lat, lon };
      if (site) params.site = site;
      axios.get("/api/radar/nowcast", { params })
        .then((res) => {
          if (cancelledRef.current) return;
          setState({ data: res.data || null, fetchedAt: Date.now(), stale: false, loading: false });
        })
        .catch(() => {
          if (cancelledRef.current) return;
          // Keep the last answer, flagged: a stale nowcast is still more
          // useful than none, as long as it says so.
          setState((prev) => ({ ...prev, stale: true, loading: false }));
        });
    };

    fetchNowcast();
    const id = setInterval(fetchNowcast, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [enabled, paused, latKey, lonKey, site]);

  return state;
}
