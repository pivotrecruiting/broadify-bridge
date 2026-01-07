import { app, BrowserWindow, protocol } from "electron";
import net from "node:net";

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

function sendMessage(message: unknown): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function sendIpcMessage(message: { type: string; [key: string]: unknown }, buffer?: Buffer): void {
  if (!ipcSocket || !canSend) {
    return;
  }

  const payload = {
    ...message,
    bufferLength: buffer ? buffer.length : 0,
  };
  const header = Buffer.from(JSON.stringify(payload), "utf-8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(header.length, 0);

  const chunks = buffer ? [headerLength, header, buffer] : [headerLength, header];
  const ok = ipcSocket.write(Buffer.concat(chunks));
  if (!ok) {
    canSend = false;
  }
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
  backgroundColor: string;
  layout: { x: number; y: number; scale: number };
}): string {
  const { html, css, values, backgroundColor, layout } = options;

  const safeValues = JSON.stringify(values || {});
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
      ${css}
    </style>
  </head>
  <body>
    <div id="graphic-container">
      <div id="graphic-root"></div>
    </div>
    <script>
      const template = ${template};
      const root = document.getElementById("graphic-root");
      const escapeHtml = (value) => {
        const str = value === undefined || value === null ? "" : String(value);
        return str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\"/g, "&quot;")
          .replace(/'/g, "&#39;");
      };
      const renderTemplate = (values) => {
        return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => {
          const value = key.split(".").reduce((acc, part) => {
            if (acc && typeof acc === "object" && part in acc) {
              return acc[part];
            }
            return undefined;
          }, values);
          return escapeHtml(value);
        });
      };
      window.__applyValues = (values) => {
        const merged = Object.assign({}, window.__currentValues || {}, values || {});
        window.__currentValues = merged;
        root.innerHTML = renderTemplate(merged);
      };
      window.__updateLayout = (layout) => {
        const x = Number(layout?.x || 0);
        const y = Number(layout?.y || 0);
        const scale = Number(layout?.scale || 1);
        root.style.transform =
          "translate(" + x + "px, " + y + "px) scale(" + scale + ")";
      };
      window.__currentValues = ${safeValues};
      window.__updateLayout(${layoutJson});
      window.__applyValues(window.__currentValues);
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
    sendMessage({
      type: "frame",
      layerId: message.layerId,
      width: message.width,
      height: message.height,
      buffer,
      timestamp: Date.now(),
    });
  });

  const html = buildHtmlDocument({
    html: message.html,
    css: message.css,
    values: message.values,
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

  sendMessage({ type: "layer_ready", layerId: message.layerId });
}

async function updateValues(message: {
  layerId: string;
  values: Record<string, unknown>;
}): Promise<void> {
  const layer = layers.get(message.layerId);
  if (!layer) {
    return;
  }

  await layer.window.webContents.executeJavaScript(
    `window.__applyValues(${JSON.stringify(message.values || {})});`,
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

async function handleMessage(message: any): Promise<void> {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "set_assets") {
    assetMap.clear();
    for (const [assetId, data] of Object.entries(message.assets || {})) {
      assetMap.set(assetId, data as { filePath: string; mime: string });
    }
    return;
  }

  if (message.type === "create_layer") {
    await createLayer(message);
    return;
  }

  if (message.type === "update_values") {
    await updateValues(message);
    return;
  }

  if (message.type === "update_layout") {
    await updateLayout(message);
    return;
  }

  if (message.type === "remove_layer") {
    await removeLayer(message);
    return;
  }

  if (message.type === "shutdown") {
    for (const layer of layers.values()) {
      layer.window.destroy();
    }
    layers.clear();
    app.quit();
  }
}

app.on("ready", () => {
  console.log("[GraphicsRenderer] Electron renderer ready");
  console.log(
    `[GraphicsRenderer] IPC available: ${typeof process.send === "function"}`
  );
  registerAssetProtocol();
  sendMessage({ type: "ready" });
});

app.on("window-all-closed", () => {});

process.on("message", (message) => {
  handleMessage(message).catch((error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendMessage({ type: "error", message: errorMessage });
  });
});

function connectIpcSocket(): void {
  const port = Number(process.env.BRIDGE_GRAPHICS_IPC_PORT || 0);
  if (!port) {
    return;
  }

  ipcSocket = net.createConnection({ host: "127.0.0.1", port }, () => {
    console.log("[GraphicsRenderer] IPC socket connected");
    sendIpcMessage({ type: "ready" });
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
      void handleMessage(header);
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
  });
}

connectIpcSocket();

process.on("uncaughtException", (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`[GraphicsRenderer] Uncaught exception: ${errorMessage}`);
  sendMessage({ type: "error", message: errorMessage });
});

process.on("unhandledRejection", (reason) => {
  const errorMessage =
    reason instanceof Error ? reason.message : String(reason);
  console.error(`[GraphicsRenderer] Unhandled rejection: ${errorMessage}`);
  sendMessage({ type: "error", message: errorMessage });
});
