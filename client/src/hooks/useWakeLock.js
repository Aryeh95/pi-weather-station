// Hold the screen awake while `enabled`.
//
// Split out of follow-me mode, which originally took this lock implicitly.
// Tying it to a mode made it invisible: there was no way to keep the screen
// on without also being followed, and no way to be followed without the
// screen staying on. It is a preference (`keepScreenAwake`), so it lives on
// its own and the caller decides when it applies.

import { useEffect } from "react";

/**
 * Keep the display from sleeping for as long as `enabled` holds.
 *
 * No-ops where the Wake Lock API is absent (it needs a secure context, which
 * the app has and a plain-HTTP LAN page does not) or where the platform
 * refuses the request — the screen then just times out as usual.
 *
 * @param {boolean} enabled whether to hold the lock
 */
export default function useWakeLock(enabled) {
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.wakeLock) {
      return undefined;
    }
    let sentinel = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== "visible") return;
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Denied, or the device is in a battery-saver state that refuses it.
      }
    };
    // The browser drops the lock whenever the page loses visibility, and does
    // NOT restore it on return — so without re-acquiring here the setting
    // would silently stop working after the first trip to another app.
    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release?.().catch(() => undefined);
    };
  }, [enabled]);
}
