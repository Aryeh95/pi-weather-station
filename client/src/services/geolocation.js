import axios from "axios";

/**
 * Gets coordinates from `navigator.geolocation` (currently not supported on aspbian Chromium)
 *
 * @returns {Promise} coordinates
 */
export function getCoordsFromBrowser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(null);
    // The error callback and timeout are load-bearing, not defensive padding:
    // without them a denied permission (or a device that never gets a fix)
    // leaves this promise pending forever, and any caller that awaits it
    // before falling back to the IP lookup stalls with no position at all.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!pos || !pos.coords) reject("Could not get current position");
        else resolve(pos.coords);
      },
      (err) => reject(err),
      {
        // `enableHighAccuracy` is what actually engages the GPS radio —
        // granting ACCESS_FINE_LOCATION only makes a precise fix *available*,
        // and without this flag the platform is free to answer from the
        // cheaper network provider, which is what "fine location granted but
        // the pin is a kilometre out" looks like. The pin doubles as home for
        // the storm-arrival estimate and the alert-radius ring, so precision
        // is worth the radio.
        //
        // Kiosk builds ask for the cheap fix: that machine is stationary,
        // has no GPS, and resolves its position from the server anyway.
        enableHighAccuracy: __STANDALONE__,
        // A cold GPS fix outdoors can take longer than a network one; 20 s
        // in the app before falling through to the IP lookup.
        timeout: __STANDALONE__ ? 20000 : 10000,
        // Accept a fix up to 5 min old — the phone has almost certainly
        // located itself recently, and reusing that starts the map instantly.
        maximumAge: 300000,
      }
    );
  });
}

/**
 * Gets coordinates from an external API
 *
 * @returns {Promise} coordinates
 */
export function getCoordsFromApi() {
  return new Promise((resolve, reject) => {
    axios
      .get("/geolocation")
      .then((res) => {
        const { latitude, longitude } = res.data;
        if (
          !latitude ||
          (!latitude && latitude !== 0) ||
          !longitude ||
          (!longitude && longitude !== 0)
        ) {
          reject("Could not get lan/lon");
        } else {
          resolve({
            latitude,
            longitude,
          });
        }
      })
      .catch((err) => {        
        reject(err);
      });
  });
}
