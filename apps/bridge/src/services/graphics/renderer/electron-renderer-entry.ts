import { app, BrowserWindow, protocol } from "electron";
import net from "node:net";
import pino from "pino";
import { getStandardAnimationCss } from "./animation-css.js";

const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  base: { component: "graphics-renderer" },
});

// IPC hard limits to avoid oversized payloads and memory pressure.
const MAX_IPC_HEADER_BYTES = 64 * 1024;
const MAX_IPC_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_IPC_BUFFER_BYTES = MAX_IPC_HEADER_BYTES + MAX_IPC_PAYLOAD_BYTES + 4;
const MAX_FRAME_DIMENSION = 8192;
const DEBUG_GRAPHICS = true;
// Design baseline for templates (format-agnostic rendering).
const BASE_RENDER_WIDTH = 1920;
const BASE_RENDER_HEIGHT = 1080;

app.commandLine.appendSwitch("force-device-scale-factor", "1");

const layers = new Map<
  string,
  {
    window: BrowserWindow;
    width: number;
    height: number;
  }
>();

const assetMap = new Map<string, { filePath: string; mime: string }>();
let paintCount = 0;
let ipcSocket: net.Socket | null = null;
let canSend = true;
let ipcBuffer = Buffer.alloc(0);
const ipcToken = process.env.BRIDGE_GRAPHICS_IPC_TOKEN || "";
let isAppReady = false;
let isIpcConnected = false;
let readySent = false;
const debugFirstPaintLogged = new Set<string>();
const debugMismatchLogged = new Set<string>();
const debugEmptyLogged = new Set<string>();
const debugSampleLogged = new Set<string>();
const debugDomLogged = new Set<string>();
let perfLastLogAt = Date.now();
let perfPaintCount = 0;
let perfSentCount = 0;
let perfDroppedCount = 0;
let backpressureStartAt: number | null = null;
let backpressureTotalMs = 0;

function logPerfIfNeeded(): void {
  const now = Date.now();
  const intervalMs = now - perfLastLogAt;
  if (intervalMs < 1000) {
    return;
  }
  const paintPerSec = Math.round((perfPaintCount * 1000) / intervalMs);
  const sentPerSec = Math.round((perfSentCount * 1000) / intervalMs);
  const droppedPerSec = Math.round((perfDroppedCount * 1000) / intervalMs);
  const backpressureActiveMs =
    backpressureStartAt !== null ? now - backpressureStartAt : 0;
  logger.info(
    {
      paintPerSec,
      sentPerSec,
      droppedPerSec,
      backpressureMs: backpressureTotalMs + backpressureActiveMs,
      ipcConnected: isIpcConnected,
    },
    "[GraphicsRenderer] Perf",
  );
  perfLastLogAt = now;
  perfPaintCount = 0;
  perfSentCount = 0;
  perfDroppedCount = 0;
  backpressureTotalMs = 0;
}

// Register a custom asset:// protocol for local graphics assets.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

/**
 * Send an IPC message to the bridge process.
 *
 * Includes a token for authentication and enforces payload limits.
 */
function sendIpcMessage(
  message: { type: string; [key: string]: unknown },
  buffer?: Buffer,
): void {
  if (!ipcSocket || !canSend) {
    if (message.type === "frame" && canSend === false) {
      perfDroppedCount += 1;
      logPerfIfNeeded();
    }
    return;
  }

  if (buffer && buffer.length > MAX_IPC_PAYLOAD_BYTES) {
    logger.warn("[GraphicsRenderer] IPC payload exceeds limit");
    return;
  }

  const payload = {
    ...message,
    token: ipcToken || undefined,
    bufferLength: buffer ? buffer.length : 0,
  };
  const header = Buffer.from(JSON.stringify(payload), "utf-8");
  if (header.length > MAX_IPC_HEADER_BYTES) {
    logger.warn("[GraphicsRenderer] IPC header exceeds limit");
    return;
  }
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);

  const chunks = buffer
    ? [headerLength, header, buffer]
    : [headerLength, header];
  const ok = ipcSocket.write(Buffer.concat(chunks));
  if (!ok) {
    canSend = false;
    if (backpressureStartAt === null) {
      backpressureStartAt = Date.now();
    }
  }
  if (message.type === "frame") {
    perfSentCount += 1;
    logPerfIfNeeded();
  }
}

function maybeSendReady(): void {
  if (readySent || !isAppReady || !isIpcConnected) {
    return;
  }
  readySent = true;
  sendIpcMessage({ type: "ready" });
}

function bgraToRgba(buffer: Buffer): Buffer {
  for (let i = 0; i < buffer.length; i += 4) {
    const blue = buffer[i];
    buffer[i] = buffer[i + 2];
    buffer[i + 2] = blue;
  }
  return buffer;
}

function sampleRgbaBuffer(
  buffer: Buffer,
  width: number,
  height: number,
): Array<{ name: string; x: number; y: number; rgba: number[] | null }> {
  const maxX = Math.max(0, width - 1);
  const maxY = Math.max(0, height - 1);
  const positions = [
    { name: "topLeft", x: 0, y: 0 },
    { name: "center", x: Math.floor(width / 2), y: Math.floor(height / 2) },
    { name: "bottomRight", x: maxX, y: maxY },
  ];

  return positions.map((pos) => {
    const index = (pos.y * width + pos.x) * 4;
    if (index < 0 || index + 3 >= buffer.length) {
      return { ...pos, rgba: null };
    }
    return {
      ...pos,
      rgba: [
        buffer[index],
        buffer[index + 1],
        buffer[index + 2],
        buffer[index + 3],
      ],
    };
  });
}

async function logDomStateOnce(
  window: BrowserWindow,
  layerId: string,
  layout: { x: number; y: number; scale: number },
): Promise<void> {
  if (!DEBUG_GRAPHICS || debugDomLogged.has(layerId)) {
    return;
  }
  debugDomLogged.add(layerId);
  try {
    const layoutJson = JSON.stringify(layout);
    const domState = await window.webContents.executeJavaScript(
      `(() => {
        const layout = ${layoutJson};
        const container = document.getElementById("graphic-container");
        const root = document.getElementById("graphic-root");
        const rootElement =
          (root && root.querySelector('[data-root="graphic"]')) || root;
        const rectToJson = (rect) => rect
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
        const getStyle = (el) => {
          if (!el) return null;
          const style = getComputedStyle(el);
          return {
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            transform: style.transform,
          };
        };
        return {
          layout,
          containerRect: rectToJson(container?.getBoundingClientRect()),
          rootRect: rectToJson(root?.getBoundingClientRect()),
          elementRect: rectToJson(rootElement?.getBoundingClientRect()),
          hasElement: Boolean(rootElement),
          hasContent: Boolean(
            rootElement &&
              (rootElement.children.length > 0 ||
                (rootElement.textContent || "").trim().length > 0),
          ),
          rootHtmlLength: root?.innerHTML?.length || 0,
          elementStyle: getStyle(rootElement),
        };
      })()`,
      true,
    );
    logger.info(
      {
        layerId,
        ...domState,
      },
      "[GraphicsRenderer] Debug DOM state",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { layerId, message },
      "[GraphicsRenderer] Debug DOM state failed",
    );
  }
}

async function logDomStateWithDelay(
  window: BrowserWindow,
  layerId: string,
  layout: { x: number; y: number; scale: number },
  delayMs: number,
): Promise<void> {
  if (!DEBUG_GRAPHICS || debugDomLogged.has(`${layerId}-delayed`)) {
    return;
  }
  debugDomLogged.add(`${layerId}-delayed`);
  const layoutJson = JSON.stringify(layout);
  setTimeout(() => {
    void (async () => {
      try {
        const domState = await window.webContents.executeJavaScript(
          `(() => {
            const layout = ${layoutJson};
            const container = document.getElementById("graphic-container");
            const root = document.getElementById("graphic-root");
            const rootElement =
              (root && root.querySelector('[data-root="graphic"]')) || root;
            const rectToJson = (rect) => rect
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null;
            const getStyle = (el) => {
              if (!el) return null;
              const style = getComputedStyle(el);
              return {
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                transform: style.transform,
              };
            };
            return {
              layout,
              containerRect: rectToJson(container?.getBoundingClientRect()),
              rootRect: rectToJson(root?.getBoundingClientRect()),
              elementRect: rectToJson(rootElement?.getBoundingClientRect()),
              hasElement: Boolean(rootElement),
              hasContent: Boolean(
                rootElement &&
                  (rootElement.children.length > 0 ||
                    (rootElement.textContent || "").trim().length > 0),
              ),
              rootHtmlLength: root?.innerHTML?.length || 0,
              elementStyle: getStyle(rootElement),
            };
          })()`,
          true,
        );
        logger.info(
          {
            layerId,
            delayMs,
            ...domState,
          },
          "[GraphicsRenderer] Debug DOM state (delayed)",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          { layerId, message },
          "[GraphicsRenderer] Debug DOM state (delayed) failed",
        );
      }
    })();
  }, delayMs);
}

/**
 * Build a self-contained HTML document for the offscreen renderer.
 *
 * @param options Template html/css and runtime values.
 * @returns Serialized HTML document string.
 */
function buildHtmlDocument(options: {
  html: string;
  css: string;
  values: Record<string, unknown>;
  bindings?: {
    cssVariables?: Record<string, string>;
    textContent?: Record<string, string>;
    textTypes?: Record<string, string>;
    animationClass?: string;
  };
  backgroundColor: string;
  layout: { x: number; y: number; scale: number };
}): string {
  const { html, css, values, bindings, backgroundColor, layout } = options;
  const resolvedBindings = {
    cssVariables: bindings?.cssVariables ?? {},
    textContent: bindings?.textContent ?? {},
    textTypes: bindings?.textTypes ?? {},
    animationClass: bindings?.animationClass ?? "anim-ease-out",
  };
  const cssVariableLines = Object.entries(resolvedBindings.cssVariables)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");

  const safeValues = JSON.stringify(values || {});
  const safeBindings = JSON.stringify(resolvedBindings);
  const template = JSON.stringify(html);
  const layoutJson = JSON.stringify(layout);

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
        background: ${backgroundColor};
      }
      #graphic-container {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      #graphic-root {
        position: absolute;
        left: 0;
        top: 0;
        width: ${BASE_RENDER_WIDTH}px;
        height: ${BASE_RENDER_HEIGHT}px;
        transform-origin: top left;
      }
      :root {
${cssVariableLines}
      }
      ${getStandardAnimationCss()}
      ${css}
    </style>
  </head>
  <body>
    <div id="graphic-container">
      <div id="graphic-root"></div>
    </div>
    <script>
      const template = ${template};
      const hasPlaceholders = template.includes("{{");
      const initialBindings = ${safeBindings};
      const root = document.getElementById("graphic-root");
      const cssVarsRoot = document.documentElement;
      const escapeHtml = (value) => {
        const str = value === undefined || value === null ? "" : String(value);
        return str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      };
      const renderTemplate = (values) => {
        // Regex needs escaped braces for literal matching
        // eslint-disable-next-line no-useless-escape
        return template.replace(/{{\\s*([\\w.-]+)\\s*}}/g, (match, key) => {
          const value = key.split(".").reduce((acc, part) => {
            if (acc && typeof acc === "object" && part in acc) {
              return acc[part];
            }
            return undefined;
          }, values);
          return escapeHtml(value);
        });
      };
      const getRootElement = () => {
        return root.querySelector('[data-root="graphic"]') || root;
      };
      const applyAnimationClass = (element, animationClass) => {
        if (!element) return;
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
      const applyCssVariables = (vars) => {
        if (!vars || !cssVarsRoot) return;
        Object.entries(vars).forEach(([key, value]) => {
          if (!key.startsWith("--")) return;
          cssVarsRoot.style.setProperty(key, String(value));
        });
      };
      const applyTextContent = (textContent, textTypes) => {
        if (!textContent) return;
        const rootElement = getRootElement();
        if (!rootElement) return;
        Object.entries(textContent).forEach(([key, value]) => {
          const target = rootElement.querySelector('[data-bid="' + key + '"]');
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
      window.__applyValues = (values, bindings) => {
        const merged = Object.assign({}, window.__currentValues || {}, values || {});
        window.__currentValues = merged;
        if (hasPlaceholders) {
          root.innerHTML = renderTemplate(merged);
        }
        const resolved = Object.assign({}, initialBindings, bindings || {});
        window.__currentBindings = resolved;
        const rootElement = getRootElement();
        applyAnimationClass(rootElement, resolved.animationClass);
        applyTextContent(resolved.textContent, resolved.textTypes);
        applyCssVariables(resolved.cssVariables);
      };
      window.__updateLayout = (layout) => {
        const x = Number(layout?.x || 0);
        const y = Number(layout?.y || 0);
        const scale = Number(layout?.scale || 1);
        root.style.transform =
          "translate(" + x + "px, " + y + "px) scale(" + scale + ")";
      };
      window.__currentValues = ${safeValues};
      window.__currentBindings = initialBindings;
      if (!hasPlaceholders) {
        root.innerHTML = template;
      }
      window.__updateLayout(${layoutJson});
      window.__applyValues(window.__currentValues, initialBindings);
    </script>
  </body>
</html>`;
}

function resolveBackgroundColor(mode: string): string {
  if (mode === "green") return "#00FF00";
  if (mode === "black") return "#000000";
  if (mode === "white") return "#FFFFFF";
  return "transparent";
}

function registerAssetProtocol(): void {
  protocol.registerFileProtocol("asset", (request, callback) => {
    try {
      const assetId = request.url.replace("asset://", "");
      const asset = assetMap.get(assetId);
      if (!asset) {
        callback({ error: -6 });
        return;
      }
      callback({ path: asset.filePath, mimeType: asset.mime });
    } catch {
      callback({ error: -2 });
    }
  });
}

/**
 * Create a new offscreen layer window and start rendering frames.
 *
 * @param message Layer creation payload.
 */
async function createLayer(message: {
  layerId: string;
  html: string;
  css: string;
  values: Record<string, unknown>;
  bindings?: {
    cssVariables?: Record<string, string>;
    textContent?: Record<string, string>;
    textTypes?: Record<string, string>;
    animationClass?: string;
  };
  layout: { x: number; y: number; scale: number };
  backgroundMode: string;
  width: number;
  height: number;
  fps: number;
}): Promise<void> {
  const existing = layers.get(message.layerId);
  if (existing) {
    existing.window.destroy();
    layers.delete(message.layerId);
  }

  const window = new BrowserWindow({
    width: message.width,
    height: message.height,
    show: false,
    transparent: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (DEBUG_GRAPHICS) {
    const [contentWidth, contentHeight] = window.getContentSize();
    logger.info(
      {
        layerId: message.layerId,
        width: message.width,
        height: message.height,
        contentWidth,
        contentHeight,
        fps: message.fps,
        backgroundMode: message.backgroundMode,
      },
      "[GraphicsRenderer] Debug layer created",
    );
  }

  window.webContents.setFrameRate(message.fps);
  window.webContents.on("paint", (_event, _dirty, image) => {
    if (paintCount === 0) {
      logger.info("[GraphicsRenderer] First paint received");
    }
    paintCount += 1;
    perfPaintCount += 1;
    logPerfIfNeeded();
    const imageSize = image.getSize();
    if (image.isEmpty() || imageSize.width === 0 || imageSize.height === 0) {
      if (DEBUG_GRAPHICS && !debugEmptyLogged.has(message.layerId)) {
        debugEmptyLogged.add(message.layerId);
        logger.warn(
          {
            layerId: message.layerId,
            messageWidth: message.width,
            messageHeight: message.height,
            imageWidth: imageSize.width,
            imageHeight: imageSize.height,
            dirtyRect: _dirty,
          },
          "[GraphicsRenderer] Debug empty paint frame",
        );
      }
      return;
    }
    const buffer = bgraToRgba(image.toBitmap());
    if (DEBUG_GRAPHICS && !debugFirstPaintLogged.has(message.layerId)) {
      debugFirstPaintLogged.add(message.layerId);
      const scaleX = message.width > 0 ? imageSize.width / message.width : 0;
      const scaleY = message.height > 0 ? imageSize.height / message.height : 0;
      logger.info(
        {
          layerId: message.layerId,
          messageWidth: message.width,
          messageHeight: message.height,
          imageWidth: imageSize.width,
          imageHeight: imageSize.height,
          bufferLength: buffer.length,
          expectedMessageLength: message.width * message.height * 4,
          expectedImageLength: imageSize.width * imageSize.height * 4,
          dirtyRect: _dirty,
          scaleX,
          scaleY,
        },
        "[GraphicsRenderer] Debug first paint",
      );
    }
    if (
      message.width > MAX_FRAME_DIMENSION ||
      message.height > MAX_FRAME_DIMENSION
    ) {
      logger.warn("[GraphicsRenderer] Frame dimensions exceed limit");
      return;
    }
    const expectedLength = message.width * message.height * 4;
    if (buffer.length !== expectedLength) {
      if (DEBUG_GRAPHICS && !debugMismatchLogged.has(message.layerId)) {
        debugMismatchLogged.add(message.layerId);
        const dirtyExpectedLength =
          _dirty &&
          typeof _dirty.width === "number" &&
          typeof _dirty.height === "number"
            ? _dirty.width * _dirty.height * 4
            : null;
        logger.warn(
          {
            layerId: message.layerId,
            messageWidth: message.width,
            messageHeight: message.height,
            imageWidth: imageSize.width,
            imageHeight: imageSize.height,
            bufferLength: buffer.length,
            expectedMessageLength: expectedLength,
            expectedImageLength: imageSize.width * imageSize.height * 4,
            dirtyRect: _dirty,
            dirtyExpectedLength,
          },
          "[GraphicsRenderer] Debug buffer length mismatch",
        );
      }
      logger.warn("[GraphicsRenderer] Frame buffer length mismatch");
      return;
    }
    if (DEBUG_GRAPHICS && !debugSampleLogged.has(message.layerId)) {
      debugSampleLogged.add(message.layerId);
      const samples = sampleRgbaBuffer(buffer, message.width, message.height);
      logger.info(
        {
          layerId: message.layerId,
          width: message.width,
          height: message.height,
          samples,
        },
        "[GraphicsRenderer] Debug pixel samples",
      );
    }
    if (buffer.length > MAX_IPC_PAYLOAD_BYTES) {
      logger.warn("[GraphicsRenderer] Frame buffer exceeds payload limit");
      return;
    }
    sendIpcMessage(
      {
        type: "frame",
        layerId: message.layerId,
        width: message.width,
        height: message.height,
        timestamp: Date.now(),
      },
      buffer,
    );
  });

  const html = buildHtmlDocument({
    html: message.html,
    css: message.css,
    values: message.values,
    bindings: message.bindings,
    backgroundColor: resolveBackgroundColor(message.backgroundMode),
    layout: message.layout,
  });

  window.webContents.once("did-finish-load", () => {
    window.webContents.startPainting();
    window.webContents.invalidate();
    const isPainting = window.webContents.isPainting();
    logger.info(`[GraphicsRenderer] isPainting: ${isPainting}`);
    if (DEBUG_GRAPHICS) {
      logger.info(
        {
          layerId: message.layerId,
          zoomFactor: window.webContents.getZoomFactor(),
          zoomLevel: window.webContents.getZoomLevel(),
        },
        "[GraphicsRenderer] Debug zoom",
      );
    }
    void logDomStateOnce(window, message.layerId, message.layout);
    void logDomStateWithDelay(window, message.layerId, message.layout, 200);
  });

  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );

  layers.set(message.layerId, {
    window,
    width: message.width,
    height: message.height,
  });
}

/**
 * Update template values and bindings for an existing layer.
 *
 * @param message Update payload.
 */
async function updateValues(message: {
  layerId: string;
  values: Record<string, unknown>;
  bindings?: {
    cssVariables?: Record<string, string>;
    textContent?: Record<string, string>;
    textTypes?: Record<string, string>;
    animationClass?: string;
  };
}): Promise<void> {
  const layer = layers.get(message.layerId);
  if (!layer) {
    return;
  }

  await layer.window.webContents.executeJavaScript(
    `window.__applyValues(${JSON.stringify(
      message.values || {},
    )}, ${JSON.stringify(message.bindings || {})});`,
    true,
  );
}

/**
 * Update layout transform for an existing layer.
 *
 * @param message Update payload.
 */
async function updateLayout(message: {
  layerId: string;
  layout: { x: number; y: number; scale: number };
}): Promise<void> {
  const layer = layers.get(message.layerId);
  if (!layer) {
    return;
  }

  await layer.window.webContents.executeJavaScript(
    `window.__updateLayout(${JSON.stringify(message.layout)});`,
    true,
  );
}

/**
 * Remove a layer and destroy its offscreen window.
 *
 * @param message Remove payload.
 */
async function removeLayer(message: { layerId: string }): Promise<void> {
  const layer = layers.get(message.layerId);
  if (!layer) {
    return;
  }
  layer.window.destroy();
  layers.delete(message.layerId);
}

/**
 * Handle inbound IPC messages from the bridge process.
 *
 * @param message Parsed IPC header payload.
 */
async function handleMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== "object") {
    return;
  }

  const msg = message as { type?: string; [key: string]: unknown };

  if (msg.type === "set_assets") {
    assetMap.clear();
    for (const [assetId, data] of Object.entries(
      (msg.assets as Record<string, unknown>) || {},
    )) {
      assetMap.set(assetId, data as { filePath: string; mime: string });
    }
    return;
  }

  if (msg.type === "create_layer") {
    await createLayer(
      msg as {
        layerId: string;
        html: string;
        css: string;
        values: Record<string, unknown>;
        bindings?: {
          cssVariables?: Record<string, string>;
          textContent?: Record<string, string>;
          textTypes?: Record<string, string>;
          animationClass?: string;
        };
        layout: { x: number; y: number; scale: number };
        backgroundMode: string;
        width: number;
        height: number;
        fps: number;
      },
    );
    return;
  }

  if (msg.type === "update_values") {
    await updateValues(
      msg as {
        layerId: string;
        values: Record<string, unknown>;
        bindings?: {
          cssVariables?: Record<string, string>;
          textContent?: Record<string, string>;
          textTypes?: Record<string, string>;
          animationClass?: string;
        };
      },
    );
    return;
  }

  if (msg.type === "update_layout") {
    await updateLayout(
      msg as {
        layerId: string;
        layout: { x: number; y: number; scale: number };
      },
    );
    return;
  }

  if (msg.type === "remove_layer") {
    await removeLayer(msg as { layerId: string });
    return;
  }

  if (msg.type === "shutdown") {
    for (const layer of layers.values()) {
      layer.window.destroy();
    }
    layers.clear();
    app.quit();
  }
}

app.on("ready", () => {
  if (process.platform === "darwin" && app.dock) {
    // Hide Dock icon for the headless renderer process.
    app.dock.hide();
  }
  logger.info("[GraphicsRenderer] Electron renderer ready");
  registerAssetProtocol();
  isAppReady = true;
  maybeSendReady();
});

app.on("window-all-closed", () => {});

/**
 * Connect to the bridge IPC server and start processing messages.
 */
function connectIpcSocket(): void {
  const port = Number(process.env.BRIDGE_GRAPHICS_IPC_PORT || 0);
  if (!port) {
    return;
  }

  // IPC is local-only; token handshake prevents spoofed commands.
  ipcSocket = net.createConnection({ host: "127.0.0.1", port }, () => {
    logger.info("[GraphicsRenderer] IPC socket connected");
    isIpcConnected = true;
    sendIpcMessage({ type: "hello" });
    maybeSendReady();
  });

  ipcSocket.on("data", (data) => {
    ipcBuffer = Buffer.concat([ipcBuffer, data]);
    if (ipcBuffer.length > MAX_IPC_BUFFER_BYTES) {
      logger.warn("[GraphicsRenderer] IPC buffer exceeds limit");
      ipcBuffer = Buffer.alloc(0);
      ipcSocket?.destroy();
      return;
    }
    while (ipcBuffer.length >= 4) {
      const headerLength = ipcBuffer.readUInt32BE(0);
      if (headerLength === 0 || headerLength > MAX_IPC_HEADER_BYTES) {
        logger.warn("[GraphicsRenderer] IPC header length exceeds limit");
        ipcBuffer = Buffer.alloc(0);
        ipcSocket?.destroy();
        return;
      }
      if (ipcBuffer.length < 4 + headerLength) {
        return;
      }
      const headerRaw = ipcBuffer.subarray(4, 4 + headerLength);
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(headerRaw.toString("utf-8")) as Record<
          string,
          unknown
        >;
      } catch {
        ipcBuffer = Buffer.alloc(0);
        return;
      }

      const hasBufferLength = Object.prototype.hasOwnProperty.call(
        header,
        "bufferLength",
      );
      if (hasBufferLength && typeof header.bufferLength !== "number") {
        logger.warn("[GraphicsRenderer] IPC buffer length type invalid");
        ipcBuffer = Buffer.alloc(0);
        ipcSocket?.destroy();
        return;
      }
      const bufferLength =
        typeof header.bufferLength === "number" ? header.bufferLength : 0;
      if (bufferLength < 0 || bufferLength > MAX_IPC_PAYLOAD_BYTES) {
        logger.warn("[GraphicsRenderer] IPC payload exceeds limit");
        ipcBuffer = Buffer.alloc(0);
        ipcSocket?.destroy();
        return;
      }
      const totalLength = 4 + headerLength + bufferLength;
      if (ipcBuffer.length < totalLength) {
        return;
      }

      ipcBuffer = ipcBuffer.subarray(totalLength);
      if (bufferLength > 0) {
        logger.warn("[GraphicsRenderer] Unexpected IPC payload");
        continue;
      }
      const messageToken = typeof header.token === "string" ? header.token : "";
      if (ipcToken && messageToken !== ipcToken) {
        logger.warn("[GraphicsRenderer] IPC token mismatch");
        ipcSocket?.destroy();
        return;
      }
      void handleMessage(header).catch((error: unknown) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        sendIpcMessage({ type: "error", message: errorMessage });
      });
    }
  });

  ipcSocket.on("drain", () => {
    canSend = true;
    if (backpressureStartAt !== null) {
      backpressureTotalMs += Date.now() - backpressureStartAt;
      backpressureStartAt = null;
    }
  });

  ipcSocket.on("error", (error) => {
    logger.error(`[GraphicsRenderer] IPC socket error: ${error.message}`);
  });

  ipcSocket.on("close", () => {
    logger.warn("[GraphicsRenderer] IPC socket closed");
    ipcSocket = null;
    isIpcConnected = false;
    readySent = false;
  });
}

connectIpcSocket();

process.on("uncaughtException", (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error(`[GraphicsRenderer] Uncaught exception: ${errorMessage}`);
  sendIpcMessage({ type: "error", message: errorMessage });
});

process.on("unhandledRejection", (reason) => {
  const errorMessage =
    reason instanceof Error ? reason.message : String(reason);
  logger.error(`[GraphicsRenderer] Unhandled rejection: ${errorMessage}`);
  sendIpcMessage({ type: "error", message: errorMessage });
});
