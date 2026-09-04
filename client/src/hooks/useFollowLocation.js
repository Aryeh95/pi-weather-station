// Follow-me mode: keep the pin on the device as it moves.
//
// Built for driving. The pin is what every data layer keys on — the radar
// site at mosaic zoom, the alert polygons, the lightning window, and "home"
// for the storm-arrival estimate — so moving the pin moves all of it, and a
// single `watchPosition` is the whole feature.
//
// The one real design question is how often to commit a fix. `watchPosition`
// with high accuracy fires roughly once a second; at highway speed that is a
// new position every ~27 m. Committing each one would re-centre the map
// continuously (fighting the tile loader) and re-key every poller, for data
// that only changes every 2-5 minutes upstream. So fixes are gated on
// DISTANCE: nothing is committed until the device has actually moved
// `MIN_MOVE_M`, which at 60 mph is about one update every eight seconds and
// at walking pace is almost never.
//
// The distance gate doubles as the jitter filter — a stationary phone's fix
// wanders by a few metres, well under the threshold, so the map stays put at
// a traffic light.
//
// Keeping the SCREEN awake is deliberately not part of this: it is the
// `keepScreenAwake` preference (hooks/useWakeLock.js), so it can be had
// without follow mode and follow mode can be had without it.

import { useEffect, useRef } from "react";

// Metres of travel before the pin is moved. Chosen against what the pin
// feeds: the radar site is a 230 km disc, alerts are county-scale polygons,
// and the arrival estimate projects over tens of kilometres — none of which
// resolve anything finer than this, while a smaller value would re-centre
// the map every second or two on a motorway.
const MIN_MOVE_M = 200;

// A fix older or vaguer than this is a stale cache entry or a network-derived
// guess, not a GPS lock; committing one would teleport the pin backwards.
const MAX_ACCURACY_M = 500;

/**
 * Metres between two coordinates.
 *
 * Equirectangular approximation: exact enough at the scale of a threshold
 * check, and this runs on every position callback.
 *
 * @param {number} lat1 first latitude
 * @param {number} lon1 first longitude
 * @param {number} lat2 second latitude
 * @param {number} lon2 second longitude
 * @returns {number} distance in metres
 */
function metresBetween(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

/**
 * Watch the device's position while `enabled`, reporting meaningful moves.
 *
 * @param {object} params
 * @param {boolean} params.enabled whether to hold a position watch open
 * @param {(coords: {latitude: number, longitude: number}) => void} params.onMove
 *   called with the position on the first fix and after each `MIN_MOVE_M`
 * @param {(err: GeolocationPositionError) => void} [params.onError] called only when the permission is
 *   refused — the one error a watch cannot recover from — so the caller can
 *   leave follow mode instead of showing a pressed button over a dead watch
 */
export default function useFollowLocation({ enabled, onMove, onError }) {
  // Callbacks reach the watch through refs so a re-created `onMove` (they are
  // rebuilt on most renders) does not tear down and re-open the GPS watch,
  // which would restart the fix acquisition every time.
  const onMoveRef = useRef(onMove);
  const onErrorRef = useRef(onError);
  useEffect(() => { onMoveRef.current = onMove; }, [onMove]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.geolocation) {
      return undefined;
    }

    let lastCommitted = null;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos && pos.coords;
        if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
        // `accuracy` is a radius in metres; a huge one means the platform fell
        // back to cell/wifi trilateration, which can sit kilometres off and
        // would drag the pin somewhere the user is not.
        if (Number.isFinite(c.accuracy) && c.accuracy > MAX_ACCURACY_M) return;

        if (lastCommitted) {
          const moved = metresBetween(
            lastCommitted.latitude, lastCommitted.longitude, c.latitude, c.longitude
          );
          if (moved < MIN_MOVE_M) return;
        }
        lastCommitted = { latitude: c.latitude, longitude: c.longitude };
        onMoveRef.current?.(lastCommitted);
      },
      (err) => {
        // ONLY a refused permission ends follow mode.
        //
        // `watchPosition` reports POSITION_UNAVAILABLE and TIMEOUT
        // transiently — a tunnel, a multi-storey car park, a moment between
        // providers — and the watch recovers from them on its own. Treating
        // any error as fatal dropped the user out of follow mode at exactly
        // the moments they were moving; caught by the drive simulation in
        // test, where the platform emits POSITION_UNAVAILABLE between fixes.
        //
        // PERMISSION_DENIED (1) is the one that cannot recover: no further
        // fix will ever arrive, so the mode must not sit there pretending.
        if (err && err.code === 1) onErrorRef.current?.(err);
      },
      {
        enableHighAccuracy: true,
        // No cached fixes: a follow that opens with a five-minute-old
        // position starts by showing where the user was, not where they are.
        maximumAge: 0,
        timeout: 20000,
      }
    );

    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);
}
