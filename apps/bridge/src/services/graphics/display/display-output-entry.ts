import { app, BrowserWindow, screen } from "electron";
import pino from "pino";

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
    </style>
  </head>
  <body>
    <canvas id="canvas"></canvas>
    <script>
      (function () {
        const api = window.displayOutput;
        if (!api || !api.onFrame) {
          console.error("[DisplayOutput] Missing preload API");
          return;
        }
        const canvas = document.getElementById("canvas");
        const ctx = canvas.getContext("2d", { alpha: false });
        const offscreen = document.createElement("canvas");
        const offCtx = offscreen.getContext("2d", { alpha: false });
        let drawing = false;
        let pending = null;

        const resize = () => {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
        };
        window.addEventListener("resize", resize);
        resize();

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
  windowRef.webContents.send("display-frame", frame);
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
    sendReady();
    if (pendingFrame) {
      const frame = pendingFrame;
      pendingFrame = null;
      sendFrame(frame);
    }
  });

  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});

app.on("window-all-closed", () => {
  app.quit();
});

// Stream raw frame data from stdin (bridge adapter process).
process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processInputBuffer();
});
