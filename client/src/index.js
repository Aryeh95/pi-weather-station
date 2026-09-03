import React from "react";
import { createRoot } from "react-dom/client";
import App from "~/components/App";
import { AppContextProvider } from "~/AppContext";
import "~/styles";

// Browser hint for CSS-level performance opt-outs (see styles/main.css:
// Firefox pays dearly for backdrop blur over a moving map). A data
// attribute rather than a UA-sniffing class in React so it applies before
// the first paint and never re-renders anything.
if (typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent)) {
  document.documentElement.setAttribute("data-browser", "firefox");
}
import "~/i18n";

const root = createRoot(document.getElementById("root"));
root.render(
  <AppContextProvider>
    <App />
  </AppContextProvider>
);
