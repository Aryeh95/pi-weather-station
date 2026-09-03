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
      { timeout: 10000, maximumAge: 300000 }
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
