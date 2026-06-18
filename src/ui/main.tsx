import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import * as Sentry from "@sentry/electron/renderer";

const rendererSafeMode = new URLSearchParams(window.location.search).has(
  "renderer_safe_mode",
);

if (!rendererSafeMode) {
  Sentry.init();
} else {
  console.warn("[Renderer] Sentry renderer init skipped in safe mode");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
