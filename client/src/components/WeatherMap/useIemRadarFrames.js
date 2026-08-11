// Frame-list poller for the single-site super-res radar layer.
//
// Volume-scan timestamps can't be computed client-side (see iemRadar.js),
// so this hook keeps a live list from `/api/radar/frames`, which resolves
// the covering NEXRAD site and returns the actual scan times.
//
// Poll cadence is tied to the radar's own: a new volume scan appears every
// 3-6 min, and the server caches frame lists for 45 s, so polling every
// 60 s costs at most one upstream call per minute while keeping the
// displayed frame age honest to within a minute.

import { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";

const POLL_INTERVAL_MS = 60 * 1000;

// Coordinate movement below this doesn't change the covering radar, so
// it shouldn't restart the poller. A NEXRAD's useful range is 230 km;
// 0.05° (~5 km) is far below the scale at which the assigned site
// changes, and it stops map-pan jitter from re-triggering the effect.
const COORD_EPSILON = 0.05;

/**
 * Poll the server for the current single-site radar frame list.
 *
 * @param {Object} params
 * @param {Number|null} params.latitude
 * @param {Number|null} params.longitude
 * @param {Boolean} params.enabled false pauses polling entirely (layer hidden / other source selected)
 * @returns {{site: String|null, frames: Array, stale: Boolean, loading: Boolean, available: Boolean}}
 */
export default function useIemRadarFrames({ latitude, longitude, enabled }) {
  const [state, setState] = useState({
    site: null,
    frames: [],
    stale: false,
    loading: false,
    available: true,
  });

  // Quantise the coordinates so sub-epsilon panning doesn't restart the
  // effect. Rounding to a grid (rather than comparing to a previous
  // value) keeps this a pure function of the inputs, so the dep array
  // stays honest.
  const latKey = latitude != null ? Math.round(latitude / COORD_EPSILON) : null;
  const lonKey = longitude != null ? Math.round(longitude / COORD_EPSILON) : null;

  const cancelledRef = useRef(false);

  const fetchFrames = useCallback(async (lat, lon) => {
    try {
      const res = await axios.get("/api/radar/frames", { params: { lat, lon } });
      if (cancelledRef.current) return;
      const { available, site, frames } = res.data || {};
      if (available === false) {
        // No NEXRAD coverage here (outside the US). Not an error — the
        // map simply stays on the mosaic layer.
        setState({ site: null, frames: [], stale: false, loading: false, available: false });
        return;
      }
      setState({
        site: site || null,
        frames: Array.isArray(frames) ? frames : [],
        stale: false,
        loading: false,
        available: true,
      });
    } catch {
      if (cancelledRef.current) return;
      // Keep the last good frame list on screen but mark it stale, so a
      // failed refresh surfaces as visibly-aging radar rather than as a
      // frozen picture the user has no reason to distrust. The age
      // display does the rest on its own as the timestamps get older.
      setState((prev) => ({ ...prev, stale: true, loading: false }));
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || latKey == null || lonKey == null) {
      return () => { cancelledRef.current = true; };
    }

    const lat = latKey * COORD_EPSILON;
    const lon = lonKey * COORD_EPSILON;

    setState((prev) => ({ ...prev, loading: true }));
    fetchFrames(lat, lon);
    const id = setInterval(() => fetchFrames(lat, lon), POLL_INTERVAL_MS);

    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [enabled, latKey, lonKey, fetchFrames]);

  return state;
}
