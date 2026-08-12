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
 * @returns {{flashes: Array, count: Number|null, fetchedAt: Number|null, stale: Boolean}}
 */
export default function useLightning({ latitude, longitude, enabled }) {
  const [state, setState] = useState({ flashes: [], count: null, fetchedAt: null, stale: false });
  const cancelledRef = useRef(false);

  // Quantised coords so map jitter doesn't restart the poller — same
  // pattern as useIemRadarFrames.
  const latKey = latitude != null ? Math.round(latitude / 0.05) : null;
  const lonKey = longitude != null ? Math.round(longitude / 0.05) : null;

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || latKey == null || lonKey == null) {
      setState({ flashes: [], count: null, fetchedAt: null, stale: false });
      return () => { cancelledRef.current = true; };
    }
    const lat = latKey * 0.05;
    const lon = lonKey * 0.05;

    const fetchFlashes = () => {
      axios.get("/api/lightning", { params: { lat, lon, radiusKm: RADIUS_KM } })
        .then((res) => {
          if (cancelledRef.current) return;
          const d = res.data || {};
          setState({
            flashes: Array.isArray(d.flashes) ? d.flashes : [],
            count: Number.isFinite(d.count) ? d.count : null,
            fetchedAt: Date.now(),
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
  }, [enabled, latKey, lonKey]);

  return state;
}
