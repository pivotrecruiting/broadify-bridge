import { app, BrowserWindow, protocol } from "electron";
import net from "node:net";
import { getStandardAnimationCss } from "./animation-css.js";

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

function sendIpcMessage(
  message: { type: string; [key: string]: unknown },
  buffer?: Buffer
): void {
  if (!ipcSocket || !canSend) {
    return;
  }

  const payload = {
    ...message,
    token: ipcToken || undefined,
    bufferLength: buffer ? buffer.length : 0,
  };
  const header = Buffer.from(JSON.stringify(payload), "utf-8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);

  const chunks = buffer
    ? [headerLength, header, buffer]
    : [headerLength, header];
  const ok = ipcSocket.write(Buffer.concat(chunks));
  if (!ok) {
    canSend = false;
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

  window.webContents.setFrameRate(message.fps);
  window.webContents.on("paint", (_event, _dirty, image) => {
    if (paintCount === 0) {
      console.log("[GraphicsRenderer] First paint received");
    }
    paintCount += 1;
    const buffer = bgraToRgba(image.toBitmap());
    sendIpcMessage(
      {
        type: "frame",
        layerId: message.layerId,
        width: message.width,
        height: message.height,
        timestamp: Date.now(),
      },
      buffer
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
    console.log(`[GraphicsRenderer] isPainting: ${isPainting}`);
  });

  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
  );

  layers.set(message.layerId, {
    window,
    width: message.width,
    height: message.height,
  });
}

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
      message.values || {}
    )}, ${JSON.stringify(message.bindings || {})});`,
    true
  );
}

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
    true
  );
}

async function removeLayer(message: { layerId: string }): Promise<void> {
  const layer = layers.get(message.layerId);
  if (!layer) {
    return;
  }
  layer.window.destroy();
  layers.delete(message.layerId);
}

async function handleMessage(message: unknown): Promise<void> {
  if (!message || typeof message !== "object") {
    return;
  }

  const msg = message as { type?: string; [key: string]: unknown };

  if (msg.type === "set_assets") {
    assetMap.clear();
    for (const [assetId, data] of Object.entries(
      (msg.assets as Record<string, unknown>) || {}
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
      }
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
      }
    );
    return;
  }

  if (msg.type === "update_layout") {
    await updateLayout(
      msg as {
        layerId: string;
        layout: { x: number; y: number; scale: number };
      }
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
  console.log("[GraphicsRenderer] Electron renderer ready");
  registerAssetProtocol();
  isAppReady = true;
  maybeSendReady();
});

app.on("window-all-closed", () => {});

function connectIpcSocket(): void {
  const port = Number(process.env.BRIDGE_GRAPHICS_IPC_PORT || 0);
  if (!port) {
    return;
  }

  ipcSocket = net.createConnection({ host: "127.0.0.1", port }, () => {
    console.log("[GraphicsRenderer] IPC socket connected");
    isIpcConnected = true;
    sendIpcMessage({ type: "hello" });
    maybeSendReady();
  });

  ipcSocket.on("data", (data) => {
    ipcBuffer = Buffer.concat([ipcBuffer, data]);
    while (ipcBuffer.length >= 4) {
      const headerLength = ipcBuffer.readUInt32BE(0);
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

      ipcBuffer = ipcBuffer.subarray(4 + headerLength);
      const messageToken =
        typeof header.token === "string" ? header.token : "";
      if (ipcToken && messageToken !== ipcToken) {
        console.warn("[GraphicsRenderer] IPC token mismatch");
        ipcSocket?.destroy();
        return;
      }
      void handleMessage(header).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        sendIpcMessage({ type: "error", message: errorMessage });
      });
    }
  });

  ipcSocket.on("drain", () => {
    canSend = true;
  });

  ipcSocket.on("error", (error) => {
    console.error(`[GraphicsRenderer] IPC socket error: ${error.message}`);
  });

  ipcSocket.on("close", () => {
    console.warn("[GraphicsRenderer] IPC socket closed");
    ipcSocket = null;
    isIpcConnected = false;
    readySent = false;
  });
}

connectIpcSocket();

process.on("uncaughtException", (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`[GraphicsRenderer] Uncaught exception: ${errorMessage}`);
  sendIpcMessage({ type: "error", message: errorMessage });
});

process.on("unhandledRejection", (reason) => {
  const errorMessage =
    reason instanceof Error ? reason.message : String(reason);
  console.error(`[GraphicsRenderer] Unhandled rejection: ${errorMessage}`);
  sendIpcMessage({ type: "error", message: errorMessage });
});
