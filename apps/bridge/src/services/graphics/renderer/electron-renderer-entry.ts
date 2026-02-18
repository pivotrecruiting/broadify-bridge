import { app, BrowserWindow, protocol } from "electron";
import net from "node:net";
import pino from "pino";
import {
  loadFrameBusModule,
  type FrameBusModuleT,
  type FrameBusWriterT,
} from "../framebus/framebus-client.js";
import { buildSingleWindowDocument } from "./electron-renderer-dom-runtime.js";
import { RendererConfigureSchema } from "./renderer-config-schema.js";
import {
  appendIpcBuffer,
  decodeNextIpcPacket,
  encodeIpcPacket,
  type IpcBufferT,
  isIpcBufferWithinLimit,
} from "./renderer-ipc-framing.js";

const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  base: { component: "graphics-renderer" },
});

const FRAMEBUS_HEADER_SIZE = 128;
const DEBUG_GRAPHICS = process.env.BRIDGE_GRAPHICS_DEBUG === "1";
const LOG_PERF = process.env.BRIDGE_LOG_PERF === "1" || DEBUG_GRAPHICS;
const disableGpu = process.env.BRIDGE_GRAPHICS_DISABLE_GPU === "1";
let frameBusName = process.env.BRIDGE_FRAMEBUS_NAME || "";
let frameBusSlotCount = 0;
let frameBusPixelFormat = Number(
  process.env.BRIDGE_FRAME_PIXEL_FORMAT ||
    process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT ||
    1,
);
const frameBusForceRecreate = true; // IMMER TRUE LASSEN!

logger.info(
  {
    nodeEnv: process.env.NODE_ENV || "",
    cwd: process.cwd(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath || "",
    ipcPortSet: Boolean(process.env.BRIDGE_GRAPHICS_IPC_PORT),
    ipcTokenSet: Boolean(process.env.BRIDGE_GRAPHICS_IPC_TOKEN),
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === "1",
  },
  "[GraphicsRenderer] Startup context",
);

app.commandLine.appendSwitch("force-device-scale-factor", "1");
if (disableGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

const assetMap = new Map<string, { filePath: string; mime: string }>();
let paintCount = 0;
let ipcSocket: net.Socket | null = null;
let canSend = true;
let ipcBuffer: IpcBufferT = Buffer.alloc(0);
const ipcToken = process.env.BRIDGE_GRAPHICS_IPC_TOKEN || "";
let isAppReady = false;
let isIpcConnected = false;
let readySent = false;
const debugEmptyLogged = new Set<string>();
const debugFrameBusLogged = new Set<string>();
let perfLastLogAt = Date.now();
let perfPaintCount = 0;
let perfSentCount = 0;
let perfDroppedCount = 0;
let perfLatencyTotalMs = 0;
let perfLatencyMaxMs = 0;
let backpressureStartAt: number | null = null;
let backpressureTotalMs = 0;
let rendererConfigReady = false;
let rendererConfig: {
  width: number;
  height: number;
  fps: number;
  pixelFormat: number;
  framebusName: string;
  framebusSlotCount: number;
  framebusSize: number;
  backgroundMode: string;
  clearColor?: { r: number; g: number; b: number; a: number };
} | null = null;
let rendererBackgroundMode = "transparent";
let rendererClearColor: { r: number; g: number; b: number; a: number } | null =
  null;

let singleWindow: BrowserWindow | null = null;
let singleWindowReady: Promise<void> | null = null;
let singleWindowFormat: { width: number; height: number; fps: number } | null =
  null;
let frameBusModule: FrameBusModuleT | null = null;
let frameBusWriter: FrameBusWriterT | null = null;
let frameBusInitAttempted = false;

function logPerfIfNeeded(): void {
  if (!LOG_PERF) {
    return;
  }
  const now = Date.now();
  const intervalMs = now - perfLastLogAt;
  if (intervalMs < 1000) {
    return;
  }
  const paintPerSec = Math.round((perfPaintCount * 1000) / intervalMs);
  const sentPerSec = Math.round((perfSentCount * 1000) / intervalMs);
  const droppedPerSec = Math.round((perfDroppedCount * 1000) / intervalMs);
  const latencyAvg =
    perfSentCount > 0 ? Math.round(perfLatencyTotalMs / perfSentCount) : 0;
  const backpressureActiveMs =
    backpressureStartAt !== null ? now - backpressureStartAt : 0;
  logger.info(
    {
      paintPerSec,
      sentPerSec,
      droppedPerSec,
      latencyMsAvg: latencyAvg,
      latencyMsMax: Math.round(perfLatencyMaxMs),
      backpressureMs: backpressureTotalMs + backpressureActiveMs,
      ipcConnected: isIpcConnected,
    },
    "[GraphicsRenderer] Perf",
  );
  perfLastLogAt = now;
  perfPaintCount = 0;
  perfSentCount = 0;
  perfDroppedCount = 0;
  perfLatencyTotalMs = 0;
  perfLatencyMaxMs = 0;
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

  const payload = {
    ...message,
    token: ipcToken || undefined,
    bufferLength: buffer ? buffer.length : 0,
  };
  let packet: Buffer;
  try {
    packet = encodeIpcPacket(payload, buffer);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (messageText === "ipc_header_exceeds_limit") {
      logger.warn("[GraphicsRenderer] IPC header exceeds limit");
      return;
    }
    if (messageText === "ipc_payload_exceeds_limit") {
      logger.warn("[GraphicsRenderer] IPC payload exceeds limit");
      return;
    }
    logger.warn(
      { message: messageText },
      "[GraphicsRenderer] IPC encode failed",
    );
    return;
  }

  const ok = ipcSocket.write(packet);
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
  if (readySent || !isAppReady || !isIpcConnected || !rendererConfigReady) {
    return;
  }
  readySent = true;
  sendIpcMessage({
    type: "ready",
    width: rendererConfig?.width,
    height: rendererConfig?.height,
    fps: rendererConfig?.fps,
    pixelFormat: rendererConfig?.pixelFormat,
    framebusName: rendererConfig?.framebusName,
  });
}

function bgraToRgba(buffer: Buffer): Buffer {
  for (let i = 0; i < buffer.length; i += 4) {
    const blue = buffer[i];
    buffer[i] = buffer[i + 2];
    buffer[i + 2] = blue;
  }
  return buffer;
}

function logFrameBusOnce(key: string, message: string): void {
  if (debugFrameBusLogged.has(key)) {
    return;
  }
  debugFrameBusLogged.add(key);
  logger.warn(message);
}

function ensureFrameBusWriter(
  width: number,
  height: number,
  fps: number,
): boolean {
  if (frameBusWriter) {
    const header = frameBusWriter.header;
    const desiredPixelFormat = Number.isFinite(frameBusPixelFormat)
      ? frameBusPixelFormat
      : 1;
    const matches =
      header.width === width &&
      header.height === height &&
      header.fps === fps &&
      header.slotCount === frameBusSlotCount &&
      header.pixelFormat === desiredPixelFormat;
    if (matches) {
      return true;
    }
    try {
      frameBusWriter.close();
    } catch {
      // Ignore close failures; writer will be recreated.
    }
    frameBusWriter = null;
    frameBusInitAttempted = false;
  }
  if (frameBusInitAttempted) {
    return false;
  }

  if (!frameBusName) {
    logFrameBusOnce(
      "missing-name",
      "[GraphicsRenderer] FrameBus name missing (BRIDGE_FRAMEBUS_NAME)",
    );
    return false;
  }
  if (!Number.isFinite(frameBusSlotCount) || frameBusSlotCount < 2) {
    logFrameBusOnce(
      "invalid-slot",
      "[GraphicsRenderer] FrameBus slotCount missing or invalid",
    );
    return false;
  }

  try {
    frameBusInitAttempted = true;
    frameBusModule = loadFrameBusModule();
    if (!frameBusModule) {
      logFrameBusOnce(
        "module-null",
        "[GraphicsRenderer] FrameBus module not loaded",
      );
      return false;
    }
    frameBusWriter = frameBusModule.createWriter({
      name: frameBusName,
      width,
      height,
      fps,
      pixelFormat: Number.isFinite(frameBusPixelFormat)
        ? (frameBusPixelFormat as 1 | 2 | 3)
        : 1,
      slotCount: frameBusSlotCount,
      forceRecreate: frameBusForceRecreate,
    });
    logger.info(
      {
        name: frameBusWriter.name,
        size: frameBusWriter.size,
        header: frameBusWriter.header,
      },
      "[GraphicsRenderer] FrameBus writer initialized",
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFrameBusOnce(
      "init-failed",
      `[GraphicsRenderer] FrameBus init failed: ${message}`,
    );
    return false;
  }
}

function applyRendererConfig(message: unknown): void {
  const parsed = RendererConfigureSchema.safeParse(message);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues },
      "[GraphicsRenderer] Invalid renderer_configure payload",
    );
    return;
  }

  const config = parsed.data;
  rendererConfig = {
    width: config.width,
    height: config.height,
    fps: config.fps,
    pixelFormat: config.pixelFormat,
    framebusName: config.framebusName,
    framebusSlotCount: config.framebusSlotCount,
    framebusSize: config.framebusSize,
    backgroundMode: config.backgroundMode,
    clearColor: config.clearColor,
  };
  rendererBackgroundMode = config.backgroundMode;
  rendererClearColor = config.clearColor ?? null;

  if (config.framebusName && config.framebusName.trim()) {
    frameBusName = config.framebusName.trim();
  }
  if (config.framebusSlotCount > 0) {
    frameBusSlotCount = config.framebusSlotCount;
  } else if (config.framebusSize > 0) {
    const frameSize = config.width * config.height * 4;
    const slotBytes = config.framebusSize - FRAMEBUS_HEADER_SIZE;
    if (frameSize <= 0) {
      logFrameBusOnce(
        "slotcount",
        "[GraphicsRenderer] FrameBus frame size invalid",
      );
      frameBusSlotCount = 0;
    } else {
      const slotCount = Math.floor(slotBytes / frameSize);
      if (slotCount < 2) {
        logFrameBusOnce(
          "slotcount",
          "[GraphicsRenderer] FrameBus size invalid for slot count calculation",
        );
        frameBusSlotCount = 0;
      } else {
        if (slotBytes % frameSize !== 0) {
          logFrameBusOnce(
            "slotcount-padding",
            "[GraphicsRenderer] FrameBus size includes padding; slot count derived from floor()",
          );
        }
        frameBusSlotCount = slotCount;
      }
    }
  } else {
    frameBusSlotCount = 0;
  }
  if (config.pixelFormat > 0) {
    frameBusPixelFormat = config.pixelFormat;
  }

  const frameBusReady = ensureFrameBusWriter(
    config.width,
    config.height,
    config.fps,
  );

  readySent = false;
  rendererConfigReady = frameBusReady;
  if (!rendererConfigReady) {
    sendIpcMessage({
      type: "error",
      message: "FrameBus writer not ready",
    });
    return;
  }
  if (singleWindow) {
    void singleWindow.webContents
      .executeJavaScript(
        rendererClearColor
          ? `window.__setClearColor && window.__setClearColor(${JSON.stringify(
              rendererClearColor,
            )});`
          : `window.__setBackground && window.__setBackground(${JSON.stringify(
              rendererBackgroundMode,
            )});`,
        true,
      )
      .catch(() => null);
  }
  maybeSendReady();
}

async function ensureSingleWindow(
  width: number,
  height: number,
  fps: number,
  backgroundMode: string,
): Promise<BrowserWindow> {
  if (singleWindow && singleWindowFormat) {
    if (
      singleWindowFormat.width !== width ||
      singleWindowFormat.height !== height ||
      singleWindowFormat.fps !== fps
    ) {
      logger.warn(
        {
          existing: singleWindowFormat,
          next: { width, height, fps },
        },
        "[GraphicsRenderer] Single renderer format mismatch",
      );
    }
    return singleWindow;
  }

  if (!singleWindow) {
    singleWindow = new BrowserWindow({
      width,
      height,
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

    singleWindowFormat = { width, height, fps };

    singleWindow.webContents.setFrameRate(fps);
    singleWindow.webContents.on("paint", (_event, _dirty, image) => {
      const frameStartAt = Date.now();
      if (paintCount === 0) {
        logger.info("[GraphicsRenderer] First paint received");
      }
      paintCount += 1;
      perfPaintCount += 1;

      const imageSize = image.getSize();
      if (image.isEmpty() || imageSize.width === 0 || imageSize.height === 0) {
        if (DEBUG_GRAPHICS && !debugEmptyLogged.has("single")) {
          debugEmptyLogged.add("single");
          logger.warn(
            {
              width,
              height,
              imageWidth: imageSize.width,
              imageHeight: imageSize.height,
              dirtyRect: _dirty,
            },
            "[GraphicsRenderer] Debug empty paint frame (single)",
          );
        }
        return;
      }

      const buffer = bgraToRgba(image.toBitmap());
      if (buffer.length !== width * height * 4) {
        logger.warn("[GraphicsRenderer] Frame buffer length mismatch (single)");
        return;
      }

      ensureFrameBusWriter(width, height, fps);
      if (!frameBusWriter) {
        perfDroppedCount += 1;
        logPerfIfNeeded();
        return;
      }

      try {
        frameBusWriter.writeFrame(buffer, BigInt(Date.now()) * 1_000_000n);
        perfSentCount += 1;
        const latencyMs = Date.now() - frameStartAt;
        perfLatencyTotalMs += latencyMs;
        if (latencyMs > perfLatencyMaxMs) {
          perfLatencyMaxMs = latencyMs;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          { message },
          "[GraphicsRenderer] FrameBus write failed (single)",
        );
      }
      logPerfIfNeeded();
    });

    singleWindowReady = new Promise((resolve) => {
      singleWindow?.webContents.once("did-finish-load", () => {
        singleWindow?.webContents.startPainting();
        singleWindow?.webContents.invalidate();
        const isPainting = singleWindow?.webContents.isPainting();
        logger.info(`[GraphicsRenderer] isPainting: ${isPainting}`);
        resolve();
      });
    });

    const html = buildSingleWindowDocument();
    await singleWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
  }

  if (singleWindowReady) {
    await singleWindowReady;
  }

  const sessionBackgroundMode = rendererBackgroundMode || backgroundMode;
  if (rendererClearColor) {
    try {
      await singleWindow.webContents.executeJavaScript(
        `window.__setClearColor && window.__setClearColor(${JSON.stringify(
          rendererClearColor,
        )});`,
        true,
      );
    } catch {
      // No-op; background set via create_layer.
    }
  } else if (sessionBackgroundMode) {
    try {
      await singleWindow.webContents.executeJavaScript(
        `window.__setBackground && window.__setBackground(${JSON.stringify(
          sessionBackgroundMode,
        )});`,
        true,
      );
    } catch {
      // No-op; background set via create_layer.
    }
  }

  return singleWindow;
}

/**
 * Force an offscreen repaint after a control-plane DOM mutation.
 *
 * Some Chromium offscreen scenarios may delay paint dispatch for non-animated
 * DOM updates. Triggering invalidate ensures the next frame is emitted.
 */
function requestSingleWindowRepaint(): void {
  if (!singleWindow || singleWindow.isDestroyed()) {
    return;
  }
  try {
    singleWindow.webContents.invalidate();
  } catch {
    // No-op; repaint is best-effort and should never break command processing.
  }
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
 * Create or replace a layer inside the single offscreen renderer window.
 *
 * Legacy multi-window rendering was removed.
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
  zIndex?: number;
}): Promise<void> {
  const window = await ensureSingleWindow(
    message.width,
    message.height,
    message.fps,
    message.backgroundMode,
  );

  const payload = {
    layerId: message.layerId,
    html: message.html,
    css: message.css,
    values: message.values,
    bindings: message.bindings,
    layout: message.layout,
    backgroundMode: message.backgroundMode,
    zIndex: message.zIndex,
  };

  await window.webContents.executeJavaScript(
    `window.__createLayer(${JSON.stringify(payload)});`,
    true,
  );
  requestSingleWindowRepaint();
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
  if (!singleWindow) {
    return;
  }
  await singleWindow.webContents.executeJavaScript(
    `window.__updateValues(${JSON.stringify(message.layerId)}, ${JSON.stringify(
      message.values || {},
    )}, ${JSON.stringify(message.bindings || {})});`,
    true,
  );
  requestSingleWindowRepaint();
}

/**
 * Update layout transform for an existing layer.
 *
 * @param message Update payload.
 */
async function updateLayout(message: {
  layerId: string;
  layout: { x: number; y: number; scale: number };
  zIndex?: number;
}): Promise<void> {
  if (!singleWindow) {
    return;
  }
  const zIndexValue =
    typeof message.zIndex === "number" ? message.zIndex : null;
  await singleWindow.webContents.executeJavaScript(
    `window.__updateLayout(${JSON.stringify(message.layerId)}, ${JSON.stringify(
      message.layout,
    )}, ${JSON.stringify(zIndexValue)});`,
    true,
  );
  requestSingleWindowRepaint();
}

/**
 * Remove a layer and destroy its offscreen window.
 *
 * @param message Remove payload.
 */
async function removeLayer(message: { layerId: string }): Promise<void> {
  if (!singleWindow) {
    return;
  }
  await singleWindow.webContents.executeJavaScript(
    `window.__removeLayer(${JSON.stringify(message.layerId)});`,
    true,
  );
  requestSingleWindowRepaint();
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

  if (msg.type === "renderer_configure") {
    const {
      type: _type,
      token: _token,
      ...rest
    } = msg as Record<string, unknown>;
    applyRendererConfig(rest);
    return;
  }

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
        zIndex?: number;
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
        zIndex?: number;
      },
    );
    return;
  }

  if (msg.type === "remove_layer") {
    await removeLayer(msg as { layerId: string });
    return;
  }

  if (msg.type === "shutdown") {
    if (singleWindow) {
      singleWindow.destroy();
      singleWindow = null;
    }
    if (frameBusWriter) {
      frameBusWriter.close();
      frameBusWriter = null;
    }
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
    logger.error(
      {
        rawPortValue: process.env.BRIDGE_GRAPHICS_IPC_PORT || "",
      },
      "[GraphicsRenderer] Missing/invalid IPC port (BRIDGE_GRAPHICS_IPC_PORT)",
    );
    return;
  }
  if (!ipcToken) {
    logger.warn(
      "[GraphicsRenderer] IPC token missing (BRIDGE_GRAPHICS_IPC_TOKEN)",
    );
  }
  logger.info({ port }, "[GraphicsRenderer] Connecting IPC socket");

  // IPC is local-only; token handshake prevents spoofed commands.
  ipcSocket = net.createConnection({ host: "127.0.0.1", port }, () => {
    logger.info("[GraphicsRenderer] IPC socket connected");
    isIpcConnected = true;
    sendIpcMessage({ type: "hello" });
    maybeSendReady();
  });

  ipcSocket.on("data", (data) => {
    ipcBuffer = appendIpcBuffer(ipcBuffer, data);
    if (!isIpcBufferWithinLimit(ipcBuffer)) {
      logger.warn("[GraphicsRenderer] IPC buffer exceeds limit");
      ipcBuffer = Buffer.alloc(0);
      ipcSocket?.destroy();
      return;
    }
    while (true) {
      const decoded = decodeNextIpcPacket(ipcBuffer);
      if (decoded.kind === "incomplete") {
        return;
      }
      if (decoded.kind === "invalid") {
        const reasonMessage =
          decoded.reason === "header_length_exceeds_limit"
            ? "[GraphicsRenderer] IPC header length exceeds limit"
            : decoded.reason === "invalid_buffer_length_type"
              ? "[GraphicsRenderer] IPC buffer length type invalid"
              : decoded.reason === "payload_length_exceeds_limit"
                ? "[GraphicsRenderer] IPC payload exceeds limit"
                : "[GraphicsRenderer] IPC invalid message framing";
        logger.warn(reasonMessage);
        ipcBuffer = Buffer.alloc(0);
        ipcSocket?.destroy();
        return;
      }

      ipcBuffer = decoded.remaining;
      if (decoded.payload.length > 0) {
        logger.warn("[GraphicsRenderer] Unexpected IPC payload");
        continue;
      }
      const header = decoded.header as Record<string, unknown>;
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
    logger.error(
      { port, message: error.message },
      "[GraphicsRenderer] IPC socket error",
    );
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
