import { app, BrowserWindow, screen } from "electron";
import pino from "pino";
import {
  loadFrameBusModule,
  type FrameBusModuleT,
  type FrameBusReaderT,
} from "../framebus/framebus-client.js";

const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  base: { component: "display-output" },
});

const FRAMEBUS_OPEN_RETRY_MS = 200;
const FRAMEBUS_OPEN_RETRY_COUNT = 10;

const preloadPath = process.env.BRIDGE_DISPLAY_PRELOAD || "";
const targetName = process.env.BRIDGE_DISPLAY_MATCH_NAME || "";
// Currently logged for diagnostics; reserved for future port-type matching.
const targetPortType = process.env.BRIDGE_DISPLAY_MATCH_PORT_TYPE || "";
const targetWidth = Number(process.env.BRIDGE_DISPLAY_MATCH_WIDTH || "");
const targetHeight = Number(process.env.BRIDGE_DISPLAY_MATCH_HEIGHT || "");
const debugEnabled = process.env.BRIDGE_DISPLAY_DEBUG === "1";
const force2d = process.env.BRIDGE_DISPLAY_FORCE_2D === "1";
const disableGpu = process.env.BRIDGE_DISPLAY_DISABLE_GPU === "1";
const frameBusName = process.env.BRIDGE_FRAMEBUS_NAME || "";
const frameBusWidth = Number(
  process.env.BRIDGE_FRAME_WIDTH || process.env.BRIDGE_DISPLAY_FRAME_WIDTH || 0
);
const frameBusHeight = Number(
  process.env.BRIDGE_FRAME_HEIGHT || process.env.BRIDGE_DISPLAY_FRAME_HEIGHT || 0
);
const frameBusFps = Number(
  process.env.BRIDGE_FRAME_FPS || process.env.BRIDGE_DISPLAY_FRAME_FPS || 0
);
const frameBusPixelFormat = Number(
  process.env.BRIDGE_FRAME_PIXEL_FORMAT ||
    process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT ||
    0
);
const frameBusSize = Number(process.env.BRIDGE_FRAMEBUS_SIZE || 0);

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
        const overlay = document.getElementById("debug-overlay");
        const debugEnabled = ${debugEnabled ? "true" : "false"};
        const force2d = ${force2d ? "true" : "false"};
        let frameCount = 0;
        let drawing = false;
        let pending = null;
        let rendererLabel = "Canvas2D";
        const api = window.displayOutput;
        const setOverlay = (lines) => {
          if (!debugEnabled || !overlay) return;
          overlay.textContent = lines.join("\\n");
        };

        const gl =
          canvas.getContext("webgl2", { alpha: false }) ||
          canvas.getContext("webgl", { alpha: false });
        let ctx = null;
        let offscreen = null;
        let offCtx = null;
        let program = null;
        let positionBuffer = null;
        let texCoordBuffer = null;
        let texture = null;
        let texWidth = 0;
        let texHeight = 0;

        const initWebGL = () => {
          if (force2d) return false;
          if (!gl) return false;
          const vsSource =
            "attribute vec2 aPosition;" +
            "attribute vec2 aTexCoord;" +
            "varying vec2 vTexCoord;" +
            "void main(){ vTexCoord = aTexCoord; gl_Position = vec4(aPosition,0.0,1.0); }";
          const fsSource =
            "precision mediump float;" +
            "varying vec2 vTexCoord;" +
            "uniform sampler2D uTexture;" +
            "void main(){ gl_FragColor = texture2D(uTexture, vTexCoord); }";

          const compile = (type, source) => {
            const shader = gl.createShader(type);
            if (!shader) return null;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
              console.error("[DisplayOutput] Shader compile failed", gl.getShaderInfoLog(shader));
              gl.deleteShader(shader);
              return null;
            }
            return shader;
          };

          const vs = compile(gl.VERTEX_SHADER, vsSource);
          const fs = compile(gl.FRAGMENT_SHADER, fsSource);
          if (!vs || !fs) return false;

          program = gl.createProgram();
          if (!program) return false;
          gl.attachShader(program, vs);
          gl.attachShader(program, fs);
          gl.linkProgram(program);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("[DisplayOutput] Program link failed", gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            program = null;
            return false;
          }

          gl.useProgram(program);

          positionBuffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([
              -1, -1,
               1, -1,
              -1,  1,
              -1,  1,
               1, -1,
               1,  1,
            ]),
            gl.STATIC_DRAW
          );

          texCoordBuffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([
              0, 1,
              1, 1,
              0, 0,
              0, 0,
              1, 1,
              1, 0,
            ]),
            gl.STATIC_DRAW
          );

          const positionLoc = gl.getAttribLocation(program, "aPosition");
          gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
          gl.enableVertexAttribArray(positionLoc);
          gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

          const texCoordLoc = gl.getAttribLocation(program, "aTexCoord");
          gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
          gl.enableVertexAttribArray(texCoordLoc);
          gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);

          texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

          const samplerLoc = gl.getUniformLocation(program, "uTexture");
          gl.uniform1i(samplerLoc, 0);
          gl.clearColor(0, 0, 0, 1);

          rendererLabel = "WebGL";
          return true;
        };

        const init2D = () => {
          ctx = canvas.getContext("2d", { alpha: false });
          offscreen = document.createElement("canvas");
          offCtx = offscreen.getContext("2d", { alpha: false });
          rendererLabel = "Canvas2D";
        };

        if (!initWebGL()) {
          init2D();
        }

        const resize = () => {
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
          if (gl) {
            gl.viewport(0, 0, canvas.width, canvas.height);
          }
          setOverlay([
            "Display Output Debug",
            "Canvas: " + canvas.width + "x" + canvas.height,
            "Renderer: " + rendererLabel,
            force2d ? "Mode: Force2D" : "Mode: Auto",
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
          const width = frame.width;
          const height = frame.height;
          if (!width || !height) return;
          const buffer = frame.buffer;
          if (!buffer) return;
          const expectedLength = width * height * 4;
          if (buffer.length !== expectedLength) {
            console.warn(
              "[DisplayOutput] Frame buffer length mismatch",
              buffer.length,
              expectedLength
            );
            return;
          }
          if (gl && program && texture) {
            const data = new Uint8Array(buffer);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            if (texWidth !== width || texHeight !== height) {
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                width,
                height,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                data
              );
              texWidth = width;
              texHeight = height;
            } else {
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                width,
                height,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                data
              );
            }
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
          } else if (ctx && offCtx && offscreen) {
            if (offscreen.width !== width || offscreen.height !== height) {
              offscreen.width = width;
              offscreen.height = height;
            }
            const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
            offCtx.putImageData(imageData, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
          }
          frameCount += 1;
          setOverlay([
            "Display Output Debug",
            "Canvas: " + canvas.width + "x" + canvas.height,
            "Frame: " + width + "x" + height,
            "Renderer: " + rendererLabel,
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

let windowRef: BrowserWindow | null = null;
let readySent = false;
let pendingFrame:
  | { width: number; height: number; buffer: Buffer; timestamp: number }
  | null = null;
let framesReceived = 0;
let firstFrameLogged = false;
let perfFrames = 0;
let perfDrops = 0;
let perfRepeats = 0;
let perfLatencyTotalMs = 0;
let perfLatencyMaxMs = 0;
let perfLastLogAt = Date.now();
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
  const now = Date.now();
  if (Number.isFinite(frame.timestamp)) {
    const latency = Math.max(0, now - frame.timestamp);
    perfLatencyTotalMs += latency;
    if (latency > perfLatencyMaxMs) {
      perfLatencyMaxMs = latency;
    }
  }
  perfFrames += 1;
  logPerfIfNeeded();
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

function logPerfIfNeeded(): void {
  const now = Date.now();
  const elapsedMs = now - perfLastLogAt;
  if (elapsedMs < 1000) {
    return;
  }
  const fps = Math.round((perfFrames * 1000) / elapsedMs);
  const latencyAvg =
    perfFrames > 0 ? Math.round(perfLatencyTotalMs / perfFrames) : 0;
  logger.info(
    {
      fps,
      drops: perfDrops,
      repeats: perfRepeats,
      latencyMsAvg: latencyAvg,
      latencyMsMax: perfLatencyMaxMs,
      mode: "framebus",
    },
    "[DisplayOutput] Perf"
  );
  perfFrames = 0;
  perfDrops = 0;
  perfRepeats = 0;
  perfLatencyTotalMs = 0;
  perfLatencyMaxMs = 0;
  perfLastLogAt = now;
}

function startFrameBusReader(): boolean {
  if (!frameBusName) {
    logger.error("[DisplayOutput] FrameBus name missing");
    return false;
  }
  if (frameBusReader) {
    return true;
  }

  try {
    frameBusModule = loadFrameBusModule();
    if (!frameBusModule) {
      logger.error("[DisplayOutput] FrameBus module not loaded");
      return false;
    }
    frameBusReader = frameBusModule.openReader({ name: frameBusName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[DisplayOutput] FrameBus open failed: ${message}`);
    return false;
  }

  const header = frameBusReader.header;
  if (frameBusWidth > 0 && header.width !== frameBusWidth) {
    logger.error(
      `[DisplayOutput] FrameBus width mismatch (expected ${frameBusWidth}, got ${header.width})`
    );
    stopFrameBusReader();
    return false;
  }
  if (frameBusHeight > 0 && header.height !== frameBusHeight) {
    logger.error(
      `[DisplayOutput] FrameBus height mismatch (expected ${frameBusHeight}, got ${header.height})`
    );
    stopFrameBusReader();
    return false;
  }
  if (frameBusFps > 0 && header.fps !== frameBusFps) {
    logger.error(
      `[DisplayOutput] FrameBus fps mismatch (expected ${frameBusFps}, got ${header.fps})`
    );
    stopFrameBusReader();
    return false;
  }
  if (header.pixelFormat !== 1) {
    logger.error(
      `[DisplayOutput] FrameBus pixel format mismatch (expected RGBA8, got ${header.pixelFormat})`
    );
    stopFrameBusReader();
    return false;
  }
  if (frameBusPixelFormat > 0 && frameBusPixelFormat !== header.pixelFormat) {
    logger.error(
      `[DisplayOutput] FrameBus pixel format mismatch (expected ${frameBusPixelFormat}, got ${header.pixelFormat})`
    );
    stopFrameBusReader();
    return false;
  }
  if (frameBusSize > 0) {
    const expectedSize = header.headerSize + header.slotStride * header.slotCount;
    if (expectedSize !== frameBusSize) {
      logger.error(
        `[DisplayOutput] FrameBus size mismatch (expected ${frameBusSize}, got ${expectedSize})`
      );
      stopFrameBusReader();
      return false;
    }
  }

  const intervalTarget = frameBusFps > 0 ? frameBusFps : header.fps;
  const intervalMs =
    intervalTarget > 0 ? Math.max(1, Math.round(1000 / intervalTarget)) : 16;

  frameBusInterval = setInterval(() => {
    if (!frameBusReader) {
      return;
    }
    const frame = frameBusReader.readLatest();
    if (!frame) {
      return;
    }
    if (frame.seq === frameBusLastSeq) {
      perfRepeats += 1;
      logPerfIfNeeded();
      return;
    }
    if (frameBusLastSeq > 0n && frame.seq > frameBusLastSeq + 1n) {
      perfDrops += Number(frame.seq - frameBusLastSeq - 1n);
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

  return true;
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

if (!preloadPath) {
  logger.error("[DisplayOutput] Missing preload path");
  app.exit(1);
}

// Force 1:1 scaling so output resolution matches frame pixels.
app.commandLine.appendSwitch("force-device-scale-factor", "1");
if (disableGpu) {
  // Security: disable GPU only for debugging to avoid driver crashes.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}

app.on("ready", () => {
  logger.info(
    { force2d, disableGpu },
    "[DisplayOutput] Renderer mode"
  );
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
    startFrameBusReaderWithRetry(0);
    if (pendingFrame) {
      const frame = pendingFrame;
      pendingFrame = null;
      sendFrame(frame);
    }
  });

  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});

app.on("window-all-closed", () => {
  stopFrameBusReader();
  app.quit();
});

function startFrameBusReaderWithRetry(attempt: number): void {
  const started = startFrameBusReader();
  if (started) {
    sendReady();
    return;
  }
  if (attempt >= FRAMEBUS_OPEN_RETRY_COUNT) {
    app.quit();
    return;
  }
  setTimeout(() => {
    startFrameBusReaderWithRetry(attempt + 1);
  }, FRAMEBUS_OPEN_RETRY_MS);
}

