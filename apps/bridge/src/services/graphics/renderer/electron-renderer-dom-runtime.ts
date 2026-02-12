import { getStandardAnimationCss } from "./animation-css.js";

// Design baseline for templates (format-agnostic rendering).
const BASE_RENDER_WIDTH = 1920;
const BASE_RENDER_HEIGHT = 1080;

/**
 * Build the single offscreen renderer HTML runtime document.
 *
 * @returns HTML payload loaded into the hidden Electron BrowserWindow.
 */
export function buildSingleWindowDocument(): string {
  const standardCss = JSON.stringify(getStandardAnimationCss());
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }
      #graphics-background {
        position: absolute;
        inset: 0;
        background: transparent;
      }
      #graphics-root {
        position: absolute;
        inset: 0;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="graphics-background"></div>
    <div id="graphics-root"></div>
    <script>
      const BASE_WIDTH = ${BASE_RENDER_WIDTH};
      const BASE_HEIGHT = ${BASE_RENDER_HEIGHT};
      const STANDARD_CSS = ${standardCss};
      const layers = new Map();

      const escapeHtml = (value) => {
        const str = value === undefined || value === null ? "" : String(value);
        return str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      };

      const renderTemplate = (template, values) => {
        // eslint-disable-next-line no-useless-escape
        return template.replace(/{{\\s*([\\w.-]+)\\s*}}/g, (_match, key) => {
          const value = key.split(".").reduce((acc, part) => {
            if (acc && typeof acc === "object" && part in acc) {
              return acc[part];
            }
            return undefined;
          }, values);
          return escapeHtml(value);
        });
      };

      const getRootElement = (root) => {
        return (root && root.querySelector('[data-root="graphic"]')) || root;
      };

      const applyAnimationClass = (element, animationClass) => {
        if (!element) return;
        if (!element.classList.contains("root")) {
          element.classList.add("root");
        }
        const classes = String(element.className || "")
          .split(/\\s+/)
          .filter((entry) => entry.length > 0);
        const nextClasses = classes.filter(
          (entry) => !entry.startsWith("anim-") && entry !== "state-enter" && entry !== "state-exit"
        );
        if (animationClass) {
          nextClasses.push(animationClass);
        }
        if (!nextClasses.includes("state-enter")) {
          nextClasses.push("state-enter");
        }
        element.className = nextClasses.join(" ");
      };

      const applyCssVariables = (host, vars) => {
        if (!host || !vars) return;
        Object.entries(vars).forEach(([key, value]) => {
          if (!key.startsWith("--")) return;
          host.style.setProperty(key, String(value));
        });
      };

      const applyTextContent = (root, textContent, textTypes) => {
        if (!root || !textContent) return;
        Object.entries(textContent).forEach(([key, value]) => {
          const target = root.querySelector('[data-bid="' + key + '"]');
          if (!target) return;
          const contentType = textTypes ? textTypes[key] : undefined;
          if (contentType === "list") {
            const items = String(value || "")
              .split("\\n")
              .map((item) => item.trim())
              .filter(Boolean);
            target.innerHTML = items.map((item) => "<li>" + escapeHtml(item) + "</li>").join("");
            return;
          }
          target.textContent = String(value ?? "");
        });
      };

      const applyLayout = (host, layout) => {
        if (!host) return;
        const x = Number(layout?.x || 0);
        const y = Number(layout?.y || 0);
        const scale = Number(layout?.scale || 1);
        host.style.transform = "translate(" + x + "px, " + y + "px) scale(" + scale + ")";
      };

      const resolveBackgroundColor = (mode) => {
        if (mode === "green") return "#00FF00";
        if (mode === "black") return "#000000";
        if (mode === "white") return "#FFFFFF";
        return "transparent";
      };

      const resolveClearColor = (color) => {
        if (!color || typeof color !== "object") return null;
        const r = Math.max(0, Math.min(255, Number(color.r)));
        const g = Math.max(0, Math.min(255, Number(color.g)));
        const b = Math.max(0, Math.min(255, Number(color.b)));
        const a = Math.max(0, Math.min(1, Number(color.a)));
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) {
          return null;
        }
        return "rgba(" + r + "," + g + "," + b + "," + a + ")";
      };

      const setBackground = (mode) => {
        const background = document.getElementById("graphics-background");
        if (!background) return;
        background.style.background = resolveBackgroundColor(mode);
      };
      window.__setBackground = setBackground;

      const setClearColor = (color) => {
        const background = document.getElementById("graphics-background");
        if (!background) return;
        const resolved = resolveClearColor(color);
        if (resolved) {
          background.style.background = resolved;
        }
      };
      window.__setClearColor = setClearColor;

      window.__createLayer = (payload) => {
        const root = document.getElementById("graphics-root");
        if (!root || !payload || !payload.layerId) return;
        let host = root.querySelector('[data-layer-id="' + payload.layerId + '"]');
        if (!host) {
          host = document.createElement("div");
          host.dataset.layerId = payload.layerId;
          host.style.position = "absolute";
          host.style.left = "0";
          host.style.top = "0";
          root.appendChild(host);
        }
        host.style.width = BASE_WIDTH + "px";
        host.style.height = BASE_HEIGHT + "px";
        host.style.transformOrigin = "top left";
        if (payload.zIndex !== undefined && payload.zIndex !== null) {
          host.style.zIndex = String(payload.zIndex);
        }

        let shadow = host.shadowRoot;
        if (!shadow) {
          shadow = host.attachShadow({ mode: "closed" });
        }
        shadow.innerHTML = "";

        const style = document.createElement("style");
        style.textContent = STANDARD_CSS + "\\n" + String(payload.css || "");
        shadow.appendChild(style);

        const container = document.createElement("div");
        container.id = "graphic-root";
        container.style.width = BASE_WIDTH + "px";
        container.style.height = BASE_HEIGHT + "px";
        shadow.appendChild(container);

        const template = String(payload.html || "");
        const hasPlaceholders = template.includes("{{");
        if (!hasPlaceholders) {
          container.innerHTML = template;
        }

        const layerState = {
          host,
          shadow,
          container,
          template,
          hasPlaceholders,
          values: payload.values || {},
          bindings: payload.bindings || {},
        };
        layers.set(payload.layerId, layerState);

        if (payload.backgroundMode) {
          setBackground(payload.backgroundMode);
        }

        window.__updateValues(payload.layerId, payload.values || {}, payload.bindings || {});
        window.__updateLayout(payload.layerId, payload.layout || { x: 0, y: 0, scale: 1 }, payload.zIndex);
      };

      window.__updateValues = (layerId, values, bindings) => {
        const layer = layers.get(layerId);
        if (!layer) return;
        const nextValues = Object.assign({}, layer.values || {}, values || {});
        layer.values = nextValues;
        const nextBindings = Object.assign({}, layer.bindings || {}, bindings || {});
        layer.bindings = nextBindings;

        const container = layer.container;
        if (layer.hasPlaceholders) {
          container.innerHTML = renderTemplate(layer.template, nextValues);
        }

        const rootElement = getRootElement(container);
        applyAnimationClass(rootElement, nextBindings.animationClass);
        applyTextContent(rootElement, nextBindings.textContent, nextBindings.textTypes);
        applyCssVariables(layer.host, nextBindings.cssVariables);
      };

      window.__updateLayout = (layerId, layout, zIndex) => {
        const layer = layers.get(layerId);
        if (!layer) return;
        if (zIndex !== undefined && zIndex !== null) {
          layer.host.style.zIndex = String(zIndex);
        }
        applyLayout(layer.host, layout);
      };

      window.__removeLayer = (layerId) => {
        const layer = layers.get(layerId);
        if (!layer) return;
        layer.host.remove();
        layers.delete(layerId);
      };
    </script>
  </body>
</html>`;
}
