import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import * as Sentry from "@sentry/electron";

Sentry.init({
  dsn: "https://a534ee90c276b99d94aec4c22e6fc8c3@o4510578425135104.ingest.de.sentry.io/4510578677645392",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
