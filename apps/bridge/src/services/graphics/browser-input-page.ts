import { getStandardAnimationCss } from "./renderer/animation-css.js";

/**
 * Build the HTML document served to the vMix browser input.
 *
 * The page fetches its initial snapshot from the bridge and subscribes to a
 * local WebSocket for subsequent updates.
 */
export function buildBrowserInputPageHtml(): string {
  const standardCss = JSON.stringify(getStandardAnimationCss());

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <title>Broadify Browser Input</title>
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
      const STANDARD_CSS = ${standardCss};
      const SNAPSHOT_URL = "/graphics/browser-input/state";
      const WS_PATH = "/graphics/browser-input/ws";
      const layers = new Map();
      let reconnectTimer = null;

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

      const applyAnimationState = (element, animationClass, isExit) => {
        if (!element) return;
        if (!element.classList.contains("root")) {
          element.classList.add("root");
        }
        const classes = String(element.className || "")
          .split(/\\s+/)
          .filter((entry) => entry.length > 0);
        const currentAnimationClass = classes.find((entry) =>
          entry.startsWith("anim-"),
        );
        const nextClasses = classes.filter(
          (entry) =>
            !entry.startsWith("anim-") &&
            entry !== "state-enter" &&
            entry !== "state-exit",
        );
        const nextAnimationClass =
          animationClass || currentAnimationClass || "anim-ease-out";
        if (nextAnimationClass) {
          nextClasses.push(nextAnimationClass);
        }
        if (isExit) {
          if (!nextClasses.includes("state-exit")) {
            nextClasses.push("state-exit");
          }
        } else if (!nextClasses.includes("state-enter")) {
          nextClasses.push("state-enter");
        }
        element.className = nextClasses.join(" ");
      };

      const parseAnimationTimeValues = (value) => {
        return String(value || "")
          .split(",")
          .map((entry) => String(entry || "").trim())
          .map((entry) => {
            if (!entry) {
              return 0;
            }
            if (entry.endsWith("ms")) {
              return Number.parseFloat(entry);
            }
            if (entry.endsWith("s")) {
              return Number.parseFloat(entry) * 1000;
            }
            const numericValue = Number.parseFloat(entry);
            return Number.isFinite(numericValue) ? numericValue : 0;
          })
          .map((valueInMs) => Number.isFinite(valueInMs) ? valueInMs : 0);
      };

      const getAnimatedElements = (rootElement) => {
        if (!rootElement) {
          return [];
        }
        const result = [];
        if (rootElement.matches && rootElement.matches("[data-animate]")) {
          result.push(rootElement);
        }
        if (rootElement.querySelectorAll) {
          rootElement.querySelectorAll("[data-animate]").forEach((node) => {
            result.push(node);
          });
        }
        return result;
      };

      const getExitDurationMs = (rootElement) => {
        const animatedElements = getAnimatedElements(rootElement);
        if (!animatedElements.length) {
          return 0;
        }
        let maxDuration = 0;
        animatedElements.forEach((element) => {
          const computedStyle = getComputedStyle(element);
          if (!computedStyle || computedStyle.animationName === "none") {
            return;
          }
          const names = String(computedStyle.animationName || "")
            .split(",")
            .map((entry) => String(entry || "").trim())
            .filter((entry) => entry && entry !== "none");
          if (!names.length) {
            return;
          }
          const durations = parseAnimationTimeValues(
            computedStyle.animationDuration,
          );
          const delays = parseAnimationTimeValues(
            computedStyle.animationDelay,
          );

          for (let index = 0; index < names.length; index += 1) {
            const duration = durations[index] ?? 0;
            const delay = delays[index] ?? 0;
            const totalMs = duration + delay;
            if (Number.isFinite(totalMs)) {
              maxDuration = Math.max(maxDuration, totalMs);
            }
          }
        });
        return maxDuration;
      };

      const waitForNextFrame = () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => resolve(undefined));
        });

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
            target.innerHTML = items
              .map((item) => "<li>" + escapeHtml(item) + "</li>")
              .join("");
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
        host.style.transform =
          "translate(" + x + "px, " + y + "px) scale(" + scale + ")";
      };

      const resolveBackgroundColor = (mode) => {
        if (mode === "green") return "#00FF00";
        if (mode === "black") return "#000000";
        if (mode === "white") return "#FFFFFF";
        return "transparent";
      };

      const setBackground = (mode) => {
        const background = document.getElementById("graphics-background");
        if (!background) return;
        background.style.background = resolveBackgroundColor(mode);
      };

      const createOrUpdateLayer = (payload) => {
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
        host.style.width = "1920px";
        host.style.height = "1080px";
        host.style.transformOrigin = "top left";
        host.style.zIndex = String(payload.zIndex ?? 0);

        let shadow = host.shadowRoot;
        if (!shadow) {
          shadow = host.attachShadow({ mode: "open" });
        }
        shadow.innerHTML = "";

        const style = document.createElement("style");
        style.textContent = STANDARD_CSS + "\\n" + String(payload.css || "");
        shadow.appendChild(style);

        const container = document.createElement("div");
        container.id = "graphic-root";
        container.style.width = "1920px";
        container.style.height = "1080px";
        shadow.appendChild(container);

        const template = String(payload.html || "");
        const hasPlaceholders = template.includes("{{");
        if (!hasPlaceholders) {
          container.innerHTML = template;
        }

        const layerState = {
          host,
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

        updateLayerValues(payload.layerId, payload.values || {}, payload.bindings || {});
        updateLayerLayout(payload.layerId, payload.layout || { x: 0, y: 0, scale: 1 }, payload.zIndex);
      };

      const updateLayerValues = (layerId, values, bindings) => {
        const layer = layers.get(layerId);
        if (!layer) return;
        const nextValues = Object.assign({}, layer.values || {}, values || {});
        const nextBindings = Object.assign({}, layer.bindings || {}, bindings || {});
        layer.values = nextValues;
        layer.bindings = nextBindings;

        if (layer.hasPlaceholders) {
          layer.container.innerHTML = renderTemplate(layer.template, nextValues);
        }

        const rootElement = getRootElement(layer.container);
        applyAnimationState(rootElement, nextBindings.animationClass, false);
        applyTextContent(rootElement, nextBindings.textContent, nextBindings.textTypes);
        applyCssVariables(layer.host, nextBindings.cssVariables);
      };

      const updateLayerLayout = (layerId, layout, zIndex) => {
        const layer = layers.get(layerId);
        if (!layer) return;
        if (zIndex !== undefined && zIndex !== null) {
          layer.host.style.zIndex = String(zIndex);
        }
        applyLayout(layer.host, layout);
      };

      const removeLayer = async (layerId) => {
        const layer = layers.get(layerId);
        const host =
          layer?.host || document.querySelector('[data-layer-id="' + layerId + '"]');
        if (!host) {
          layers.delete(layerId);
          return;
        }

        const rootElement = getRootElement(layer?.container || null);
        const shouldAnimate = getAnimatedElements(rootElement).length > 0;
        if (rootElement) {
          applyAnimationState(rootElement, layer?.bindings?.animationClass, true);
        }

        if (shouldAnimate) {
          const exitMs = getExitDurationMs(rootElement);
          if (exitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, exitMs));
          } else {
            await waitForNextFrame();
          }
        }

        host.remove();
        layers.delete(layerId);
      };

      const applySnapshot = async (snapshot) => {
        document.title =
          snapshot?.recommendedInputName || "Broadify Browser Input";

        const nextLayers = Array.isArray(snapshot?.layers) ? snapshot.layers : [];
        const nextLayerIds = new Set(nextLayers.map((layer) => layer.layerId));
        const currentLayerIds = Array.from(layers.keys());

        for (const layerId of currentLayerIds) {
          if (!nextLayerIds.has(layerId)) {
            await removeLayer(layerId);
          }
        }

        if (nextLayers.length === 0) {
          setBackground("transparent");
        }

        nextLayers.forEach((layer) => {
          createOrUpdateLayer(layer);
        });
      };

      const getWsUrl = () => {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        return protocol + "//" + location.host + WS_PATH;
      };

      const connectWebSocket = () => {
        const socket = new WebSocket(getWsUrl());

        socket.addEventListener("message", async (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === "browser_input.snapshot") {
              await applySnapshot(payload.snapshot);
            }
          } catch (_error) {
            return;
          }
        });

        socket.addEventListener("close", () => {
          if (reconnectTimer !== null) {
            return;
          }
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connectWebSocket();
          }, 1000);
        });

        socket.addEventListener("error", () => {
          socket.close();
        });
      };

      const loadInitialSnapshot = async () => {
        try {
          const response = await fetch(SNAPSHOT_URL, { cache: "no-store" });
          if (!response.ok) {
            return;
          }
          const snapshot = await response.json();
          await applySnapshot(snapshot);
        } catch (_error) {
          return;
        }
      };

      void loadInitialSnapshot().finally(() => {
        connectWebSocket();
      });
    </script>
  </body>
</html>`;
}
