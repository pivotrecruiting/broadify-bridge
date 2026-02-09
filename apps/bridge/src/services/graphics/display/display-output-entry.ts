import { app, BrowserWindow, screen } from "electron";
import pino from "pino";
import {
  isFrameBusEnabled,
  loadFrameBusModule,
  type FrameBusModuleT,
  type FrameBusReaderT,
} from "../framebus/framebus-client.js";

const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  base: { component: "display-output" },
});

// Binary frame protocol from bridge -> helper (big-endian header + RGBA payload).
const FRAME_MAGIC = 0x42524746; // 'BRGF'
const FRAME_VERSION = 1;
const FRAME_TYPE_FRAME = 1;
const FRAME_TYPE_SHUTDOWN = 2;
const FRAME_HEADER_LENGTH = 28;
const MAX_FRAME_DIMENSION = 8192;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

const preloadPath = process.env.BRIDGE_DISPLAY_PRELOAD || "";
const targetName = process.env.BRIDGE_DISPLAY_MATCH_NAME || "";
// Currently logged for diagnostics; reserved for future port-type matching.
const targetPortType = process.env.BRIDGE_DISPLAY_MATCH_PORT_TYPE || "";
const targetWidth = Number(process.env.BRIDGE_DISPLAY_MATCH_WIDTH || "");
const targetHeight = Number(process.env.BRIDGE_DISPLAY_MATCH_HEIGHT || "");
const debugEnabled = process.env.BRIDGE_DISPLAY_DEBUG === "1";
const useFrameBus =
  process.env.BRIDGE_GRAPHICS_OUTPUT_HELPER_FRAMEBUS === "1" &&
  isFrameBusEnabled();
const frameBusName = process.env.BRIDGE_FRAMEBUS_NAME || "";
const frameBusFps = Number(process.env.BRIDGE_DISPLAY_FRAME_FPS || 0);

// Inline HTML avoids external file access and keeps the helper self-contained.
const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,height=device-height,initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #000;
      }
      #canvas {
        width: 100%;
        height: 100%;
        display: block;
        image-rendering: auto;
      }
      #debug-overlay {
        position: fixed;
        top: 12px;
        left: 12px;
        padding: 8px 10px;
        background: rgba(0, 0, 0, 0.6);
        color: #00ff6a;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace;
        z-index: 9999;
        white-space: pre;
        pointer-events: none;
      }
      #debug-overlay.hidden {
        display: none;
      }
    </style>
  </head>
  <body>
    <div id="debug-overlay" class="${debugEnabled ? "" : "hidden"}">Display Output Debug</div>
    <canvas id="canvas"></canvas>
    <script>
      (function () {
        const canvas = document.getElementById("canvas");
        const ctx = canvas.getContext("2d", { alpha: false });
        const offscreen = document.createElement("canvas");
        const offCtx = offscreen.getContext("2d", { alpha: false });
        const overlay = document.getElementById("debug-overlay");
        const debugEnabled = ${debugEnabled ? "true" : "false"};
        let frameCount = 0;
        let drawing = false;
        let pending = null;
        const api = window.displayOutput;
        const setOverlay = (lines) => {
          if (!debugEnabled || !overlay) return;
          overlay.textContent = lines.join("\\n");
        };

        const resize = () => {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
          setOverlay([
            "Display Output Debug",
            "Canvas: " + canvas.width + "x" + canvas.height,
          ]);
        };
        window.addEventListener("resize", resize);
        resize();

        if (!api || !api.onFrame) {
          setOverlay([
            "Display Output Debug",
            "Canvas: " + canvas.width + "x" + canvas.height,
            "Missing preload API",
          ]);
          console.error("[DisplayOutput] Missing preload API");
          return;
        }

        const drawFrame = (frame) => {
          if (!ctx || !offCtx) return;
          const width = frame.width;
          const height = frame.height;
          if (!width || !height) return;
          const buffer = frame.buffer;
          if (!buffer) return;
          if (offscreen.width !== width || offscreen.height !== height) {
            offscreen.width = width;
            offscreen.height = height;
          }
          const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
          offCtx.putImageData(imageData, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
          frameCount += 1;
          setOverlay([
            "Display Output Debug",
            "Canvas: " + canvas.width + "x" + canvas.height,
            "Frame: " + width + "x" + height,
            "Count: " + frameCount,
          ]);
        };

        // Draw on RAF to avoid queue buildup on slow displays.
        const schedule = (frame) => {
          if (drawing) {
            pending = frame;
            return;
          }
          drawing = true;
          window.requestAnimationFrame(() => {
            drawFrame(frame);
            drawing = false;
            if (pending) {
              const next = pending;
              pending = null;
              schedule(next);
            }
          });
        };

        api.onFrame((frame) => {
          schedule(frame);
        });
      })();
    </script>
  </body>
</html>`;

type FrameHeaderT = {
  magic: number;
  version: number;
  type: number;
  width: number;
  height: number;
  timestamp: bigint;
  bufferLength: number;
};

let windowRef: BrowserWindow | null = null;
let readySent = false;
let pendingFrame:
  | { width: number; height: number; buffer: Buffer; timestamp: number }
  | null = null;
let inputBuffer = Buffer.alloc(0);
let framesReceived = 0;
let firstFrameLogged = false;
let bytesReceived = 0;
let framesParsed = 0;
let lastByteLogAt = 0;
let frameBusModule: FrameBusModuleT | null = null;
let frameBusReader: FrameBusReaderT | null = null;
let frameBusInterval: NodeJS.Timeout | null = null;
let frameBusLastSeq = 0n;

// Electron display objects can vary by version; tolerate missing fields.
function getDisplayLabel(display: Electron.Display): string {
  const anyDisplay = display as { label?: string; name?: string };
  return (anyDisplay.label || anyDisplay.name || "").toString();
}

// Prefer external displays; optionally filter by name and exact resolution.
function selectTargetDisplay(): Electron.Display {
  const displays = screen.getAllDisplays();
  const externalDisplays = displays.filter((display) => {
    const internal = (display as { internal?: boolean }).internal;
    return internal === undefined ? true : !internal;
  });
  const candidates = externalDisplays.length > 0 ? externalDisplays : displays;

  const normalizedName = targetName.trim().toLowerCase();
  let matches = candidates;
  if (normalizedName) {
    matches = matches.filter((display) =>
      getDisplayLabel(display).toLowerCase().includes(normalizedName)
    );
  }
  if (Number.isFinite(targetWidth) && Number.isFinite(targetHeight)) {
    matches = matches.filter(
      (display) =>
        display.size.width === targetWidth &&
        display.size.height === targetHeight
    );
  }

  if (matches.length > 0) {
    return matches[0];
  }
  if (externalDisplays.length > 0) {
    return externalDisplays[0];
  }
  return screen.getPrimaryDisplay();
}

// Ready signal for the bridge adapter handshake.
function sendReady(): void {
  if (readySent) {
    return;
  }
  readySent = true;
  process.stdout.write("{\"type\":\"ready\"}\n");
}

// Buffer frames until the window is fully loaded.
function sendFrame(frame: {
  width: number;
  height: number;
  buffer: Buffer;
  timestamp: number;
}): void {
  if (!windowRef || windowRef.isDestroyed()) {
    pendingFrame = frame;
    return;
  }
  if (debugEnabled) {
    framesReceived += 1;
    if (!firstFrameLogged) {
      firstFrameLogged = true;
      logger.info(
        {
          frameWidth: frame.width,
          frameHeight: frame.height,
          canvasWidth: windowRef.getBounds().width,
          canvasHeight: windowRef.getBounds().height,
          framesReceived,
        },
        "[DisplayOutput] First frame received"
      );
    }
  }
  windowRef.webContents.send("display-frame", frame);
}

function startFrameBusReader(): void {
  if (!useFrameBus) {
    return;
  }
  if (!frameBusName) {
    logger.error("[DisplayOutput] FrameBus name missing");
    return;
  }
  if (frameBusReader) {
    return;
  }

  try {
    frameBusModule = loadFrameBusModule();
    if (!frameBusModule) {
      logger.error("[DisplayOutput] FrameBus module not loaded");
      return;
    }
    frameBusReader = frameBusModule.openReader({ name: frameBusName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[DisplayOutput] FrameBus open failed: ${message}`);
    return;
  }

  const intervalMs =
    frameBusFps > 0 ? Math.max(1, Math.round(1000 / frameBusFps)) : 16;

  frameBusInterval = setInterval(() => {
    if (!frameBusReader) {
      return;
    }
    const frame = frameBusReader.readLatest();
    if (!frame) {
      return;
    }
    if (frame.seq === frameBusLastSeq) {
      return;
    }
    frameBusLastSeq = frame.seq;

    const header = frameBusReader.header;
    const timestampMs = Number(frame.timestampNs / 1_000_000n);
    const buffer = Buffer.from(frame.buffer);
    sendFrame({
      width: header.width,
      height: header.height,
      buffer,
      timestamp: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    });
  }, intervalMs);
}

function stopFrameBusReader(): void {
  if (frameBusInterval) {
    clearInterval(frameBusInterval);
    frameBusInterval = null;
  }
  if (frameBusReader) {
    frameBusReader.close();
    frameBusReader = null;
  }
  frameBusModule = null;
  frameBusLastSeq = 0n;
}

// Parse the fixed-width header for each frame.
function parseHeader(buffer: Buffer): FrameHeaderT {
  return {
    magic: buffer.readUInt32BE(0),
    version: buffer.readUInt16BE(4),
    type: buffer.readUInt16BE(6),
    width: buffer.readUInt32BE(8),
    height: buffer.readUInt32BE(12),
    timestamp: buffer.readBigUInt64BE(16),
    bufferLength: buffer.readUInt32BE(24),
  };
}

// Security: validate headers, enforce size limits, and drop malformed frames.
function processInputBuffer(): void {
  while (inputBuffer.length >= FRAME_HEADER_LENGTH) {
    const header = parseHeader(inputBuffer.subarray(0, FRAME_HEADER_LENGTH));
    if (header.magic !== FRAME_MAGIC || header.version !== FRAME_VERSION) {
      logger.error(
        { magic: header.magic, version: header.version },
        "[DisplayOutput] Invalid frame header"
      );
      app.quit();
      return;
    }
    if (header.type === FRAME_TYPE_SHUTDOWN) {
      app.quit();
      return;
    }
    if (
      header.bufferLength > MAX_FRAME_BYTES ||
      header.width > MAX_FRAME_DIMENSION ||
      header.height > MAX_FRAME_DIMENSION
    ) {
      logger.warn("[DisplayOutput] Frame exceeds limits");
      inputBuffer = Buffer.alloc(0);
      return;
    }
    if (inputBuffer.length < FRAME_HEADER_LENGTH + header.bufferLength) {
      return;
    }
    if (header.type !== FRAME_TYPE_FRAME) {
      inputBuffer = inputBuffer.subarray(FRAME_HEADER_LENGTH + header.bufferLength);
      continue;
    }
    const expectedLength = header.width * header.height * 4;
    if (header.bufferLength !== expectedLength) {
      logger.warn(
        {
          expected: expectedLength,
          received: header.bufferLength,
        },
        "[DisplayOutput] Frame length mismatch"
      );
      inputBuffer = inputBuffer.subarray(FRAME_HEADER_LENGTH + header.bufferLength);
      continue;
    }
    const payloadStart = FRAME_HEADER_LENGTH;
    const payloadEnd = FRAME_HEADER_LENGTH + header.bufferLength;
    const payload = Buffer.from(inputBuffer.subarray(payloadStart, payloadEnd));
    inputBuffer = inputBuffer.subarray(payloadEnd);
    framesParsed += 1;
    if (debugEnabled && framesParsed === 1) {
      logger.info(
        {
          frameWidth: header.width,
          frameHeight: header.height,
          bufferLength: header.bufferLength,
        },
        "[DisplayOutput] First frame parsed from stdin"
      );
    }
    sendFrame({
      width: header.width,
      height: header.height,
      buffer: payload,
      timestamp: Number(header.timestamp),
    });
  }
}

if (!preloadPath) {
  logger.error("[DisplayOutput] Missing preload path");
  app.exit(1);
}

// Force 1:1 scaling so output resolution matches frame pixels.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.on("ready", () => {
  const display = selectTargetDisplay();
  logger.info(
    {
      targetName,
      targetPortType,
      displayId: display.id,
      displayBounds: display.bounds,
    },
    "[DisplayOutput] Selected display"
  );

  windowRef = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    show: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // Security: sandboxed renderer with a minimal preload surface.
      sandbox: true,
      devTools: false,
      backgroundThrottling: false,
    },
  });

  windowRef.setMenuBarVisibility(false);
  windowRef.setAlwaysOnTop(true, "screen-saver");
  // Security: block navigation and new windows in the helper renderer.
  windowRef.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  windowRef.webContents.on("did-finish-load", () => {
    if (debugEnabled) {
      logger.info("[DisplayOutput] Debug overlay enabled");
    }
    if (debugEnabled) {
      const win = windowRef;
      if (!win) {
        return;
      }
      win.webContents
        .executeJavaScript(
          "Boolean(window.displayOutput && window.displayOutput.onFrame)"
        )
        .then((hasApi) => {
          logger.info(
            { hasApi },
            "[DisplayOutput] Preload API availability"
          );
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            { error: message },
            "[DisplayOutput] Failed to check preload API"
          );
        });
    }
    sendReady();
    if (pendingFrame) {
      const frame = pendingFrame;
      pendingFrame = null;
      sendFrame(frame);
    }
    if (useFrameBus) {
      startFrameBusReader();
    }
  });

  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});

app.on("window-all-closed", () => {
  stopFrameBusReader();
  app.quit();
});

if (!useFrameBus) {
  // Stream raw frame data from stdin (bridge adapter process).
  process.stdin.on("data", (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    if (debugEnabled) {
      bytesReceived += chunk.length;
      const now = Date.now();
      if (now - lastByteLogAt > 1000) {
        lastByteLogAt = now;
        logger.info(
          {
            bytesReceived,
            bufferLength: inputBuffer.length,
          },
          "[DisplayOutput] Stdin bytes received"
        );
      }
    }
    processInputBuffer();
  });
}
