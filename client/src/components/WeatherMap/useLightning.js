// Poller for the GOES GLM lightning overlay.
//
// Polls /api/lightning once a minute (the server caches responses for one
// 20-second product cadence and keeps a rolling per-file cache, so a poll
// costs at most a couple of ~320 KB upstream fetches). Ages arrive baked
// into each flash as seconds-at-generation; the overlay adds the time
// since the fetch when fading, so markers keep aging between polls.

import { useState, useEffect, useRef } from "react";
import axios from "axios";

const POLL_INTERVAL_MS = 60 * 1000;

// Matches the raw-radial display radius — lightning beyond the rendered
// radar disc would float over nothing identifiable.
const RADIUS_KM = 300;

/**
 * Keep the current lightning-flash list for a map centre.
 *
 * @param {Object} params
 * @param {Number|null} params.latitude map centre
 * @param {Number|null} params.longitude map centre
 * @param {Boolean} params.enabled false pauses polling and clears
 * @param {Boolean} [params.paused] true suspends polling but keeps the current flashes
 * @returns {{flashes: Array, count: Number|null, fetchedAt: Number|null, dataEpoch: Number|null, stale: Boolean}} `dataEpoch` is the time of the newest flash (or of the window itself when it holds none)
 */
export default function useLightning({ latitude, longitude, enabled, paused = false }) {
  const [state, setState] = useState({ flashes: [], count: null, fetchedAt: null, dataEpoch: null, stale: false });
  const cancelledRef = useRef(false);

  // Quantised coords so map jitter doesn't restart the poller — same
  // pattern as useIemRadarFrames.
  const latKey = latitude != null ? Math.round(latitude / 0.05) : null;
  const lonKey = longitude != null ? Math.round(longitude / 0.05) : null;

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || latKey == null || lonKey == null) {
      setState({ flashes: [], count: null, fetchedAt: null, dataEpoch: null, stale: false });
      return () => { cancelledRef.current = true; };
    }
    if (paused) return undefined;
    const lat = latKey * 0.05;
    const lon = lonKey * 0.05;

    const fetchFlashes = () => {
      axios.get("/api/lightning", { params: { lat, lon, radiusKm: RADIUS_KM } })
        .then((res) => {
          if (cancelledRef.current) return;
          const d = res.data || {};
          const flashes = Array.isArray(d.flashes) ? d.flashes : [];
          const fetchedAt = Date.now();
          // How current the DATA is, for the frame-age stack: the newest
          // flash's time when there are flashes, else the window's own
          // generation time (no flashes is a current "nothing here", not
          // a stale feed).
          let newestAge = Infinity;
          for (const [, , age] of flashes) {
            if (Number.isFinite(age) && age < newestAge) newestAge = age;
          }
          const generated = Date.parse(d.generatedAt);
          const dataEpoch = Number.isFinite(newestAge)
            ? fetchedAt - newestAge * 1000
            : (Number.isFinite(generated) ? generated : fetchedAt);
          setState({
            flashes,
            count: Number.isFinite(d.count) ? d.count : null,
            fetchedAt,
            dataEpoch,
            stale: false,
          });
        })
        .catch(() => {
          if (cancelledRef.current) return;
          // Keep the last flashes — they age out visually on their own,
          // which is the honest failure mode for this overlay.
          setState((prev) => ({ ...prev, stale: true }));
        });
    };

    fetchFlashes();
    const id = setInterval(fetchFlashes, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [enabled, paused, latKey, lonKey]);

  return state;
}
