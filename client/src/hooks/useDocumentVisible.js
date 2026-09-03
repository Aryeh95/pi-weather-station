import { useState, useEffect } from "react";

/**
 * Whether the document is currently visible (`document.visibilityState`).
 *
 * The kiosk browser is normally always visible, but a minimised window, a
 * background tab on a remote client, or a display that the compositor
 * has put to sleep all report `hidden` — and every poller in the app was
 * still firing into it. Pollers gate on this (via `pollingPaused` in
 * SystemContext) so a screen nobody can see stops costing IEM, NWS and
 * S3 requests, and resume immediately when it comes back.
 *
 * @returns {boolean} true while the document is visible
 */
export default function useDocumentVisible() {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
