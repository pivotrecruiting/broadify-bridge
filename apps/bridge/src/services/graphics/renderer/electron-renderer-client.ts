import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { GraphicsLayoutT } from "../graphics-schemas.js";
import { getBridgeContext, type LoggerLikeT } from "../../bridge-context.js";
import type {
  GraphicsFrameT,
  GraphicsRenderer,
  GraphicsRenderLayerInputT,
  GraphicsRendererConfigT,
  GraphicsTemplateBindingsT,
} from "./graphics-renderer.js";

const ELECTRON_BINARIES = {
  win32: "electron.cmd",
  default: "electron",
};

// IPC hard limits to prevent memory abuse or oversized frame payloads.
const MAX_IPC_HEADER_BYTES = 64 * 1024;
const MAX_IPC_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_IPC_BUFFER_BYTES = MAX_IPC_HEADER_BYTES + MAX_IPC_PAYLOAD_BYTES + 4;
const MAX_FRAME_DIMENSION = 8192;
const DEBUG_GRAPHICS = true;

function resolveElectronBinary(): string | null {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") {
    return process.execPath;
  }

  if (process.execPath.toLowerCase().includes("electron")) {
    return process.execPath;
  }

  const binaryName =
    process.platform === "win32"
      ? ELECTRON_BINARIES.win32
      : ELECTRON_BINARIES.default;

  const candidate = path.resolve(
    process.cwd(),
    "..",
    "..",
    "node_modules",
    ".bin",
    binaryName,
  );

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  return null;
}

function resolveRendererEntry(): string | null {
  const distEntry = path.resolve(
    process.cwd(),
    "dist",
    "services",
    "graphics",
    "renderer",
    "electron-renderer-entry.js",
  );
  if (fs.existsSync(distEntry)) {
    return distEntry;
  }

  return null;
}

/**
 * Electron-based offscreen renderer client.
 *
 * Spawns a separate Electron process and communicates over local TCP IPC.
 * A per-process token is used to authenticate IPC messages.
 */
export class ElectronRendererClient implements GraphicsRenderer {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private frameCallback: ((frame: GraphicsFrameT) => void) | null = null;
  private errorCallback: ((error: Error) => void) | null = null;
  private ipcServer: net.Server | null = null;
  private ipcSocket: net.Socket | null = null;
  private ipcBuffer = Buffer.alloc(0);
  // Token used to authenticate IPC messages with the renderer process.
  private ipcToken: string | null = null;
  private ipcAuthenticated = false;
  // Commands queued before IPC handshake is complete.
  private pendingCommands: Array<Record<string, unknown>> = [];
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private debugFirstFrameLogged = new Set<string>();
  private rendererConfigured = false;
  private sessionConfig: GraphicsRendererConfigT | null = null;
  private lastSentConfigKey: string | null = null;
  private configReadyPromise: Promise<void> | null = null;
  private configReadyResolver: (() => void) | null = null;
  private configReadyRejecter: ((error: Error) => void) | null = null;

  /**
   * Initialize the renderer process and IPC channel.
   *
   * @returns Promise resolved once the IPC handshake is complete.
   */
  async initialize(): Promise<void> {
    if (this.child) {
      return;
    }

    const electronBinary = resolveElectronBinary();
    if (!electronBinary) {
      throw new Error("Electron binary not found for graphics renderer");
    }

    const entry = resolveRendererEntry();
    if (!entry) {
      throw new Error("Electron renderer entry not found");
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    const ipcPort = await this.startIpcServer();
    this.ipcToken = randomBytes(16).toString("hex");

    this.logStructured(
      "info",
      { component: "graphics-renderer" },
      `[GraphicsRenderer] Spawning: ${electronBinary} --graphics-renderer --renderer-entry ${entry}`,
    );

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.BRIDGE_GRAPHICS_IPC_PORT = String(ipcPort);
    env.BRIDGE_GRAPHICS_IPC_TOKEN = this.ipcToken;

    this.child = spawn(
      electronBinary,
      [
        "--force-device-scale-factor=1",
        "--graphics-renderer",
        "--renderer-entry",
        entry,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );

    this.child.stdout?.on("data", (data) => {
      this.handleRendererOutput(data, "stdout");
    });

    this.child.stderr?.on("data", (data) => {
      this.handleRendererOutput(data, "stderr");
    });

    this.child.on("error", (error) => {
      if (this.readyRejecter) {
        this.readyRejecter(error);
        this.readyRejecter = null;
        this.readyResolver = null;
      }
      if (this.errorCallback) {
        this.errorCallback(error);
      }
    });

    this.child.on("exit", (code, signal) => {
      if (this.readyRejecter) {
        this.readyRejecter(
          new Error(
            `Graphics renderer exited before ready (code ${code}, signal ${signal})`,
          ),
        );
        this.readyRejecter = null;
        this.readyResolver = null;
      }
      if (this.errorCallback) {
        this.errorCallback(
          new Error(
            `Graphics renderer exited (code ${code ?? "unknown"}, signal ${
              signal ?? "unknown"
            })`
          )
        );
      }
      this.child = null;
    });

    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.child) {
          this.child.kill();
        }
        reject(new Error("Graphics renderer startup timed out"));
      }, 5000);

      this.readyPromise
        ?.then(() => clearTimeout(timeoutId))
        .catch(() => clearTimeout(timeoutId));
    });

    await Promise.race([this.readyPromise, timeoutPromise]);
  }

  /**
   * Configure the renderer session before creating layers.
   *
   * @param config Session configuration payload.
   */
  async configureSession(config: GraphicsRendererConfigT): Promise<void> {
    this.sessionConfig = config;
    await this.ensureReady();
    await this.ensureRendererConfigured();
  }

  /**
   * Provide asset map to the renderer process.
   *
   * @param assets Map of assetId to file path and mime type.
   */
  async setAssets(
    assets: Record<string, { filePath: string; mime: string }>,
  ): Promise<void> {
    if (!this.child) {
      return;
    }
    await this.readyPromise;
    this.sendCommand({ type: "set_assets", assets });
  }

  /**
   * Render or update a layer in the renderer process.
   *
   * @param input Render payload (HTML/CSS + layout).
   */
  async renderLayer(input: GraphicsRenderLayerInputT): Promise<void> {
    await this.ensureReady();
    await this.ensureRendererConfigured();
    this.sendCommand({
      type: "create_layer",
      layerId: input.layerId,
      html: input.html,
      css: input.css,
      values: input.values,
      bindings: input.bindings,
      layout: input.layout,
      backgroundMode: input.backgroundMode,
      width: input.width,
      height: input.height,
      fps: input.fps,
      zIndex: input.zIndex,
    });
  }

  /**
   * Update values for an existing layer.
   *
   * @param layerId Layer identifier.
   * @param values Values to merge into the template.
   * @param bindings Optional precomputed bindings.
   */
  async updateValues(
    layerId: string,
    values: Record<string, unknown>,
    bindings?: GraphicsTemplateBindingsT,
  ): Promise<void> {
    await this.ensureReady();
    this.sendCommand({ type: "update_values", layerId, values, bindings });
  }

  /**
   * Update layout for an existing layer.
   *
   * @param layerId Layer identifier.
   * @param layout Layout payload.
   */
  async updateLayout(
    layerId: string,
    layout: GraphicsLayoutT,
    zIndex?: number
  ): Promise<void> {
    await this.ensureReady();
    await this.ensureRendererConfigured();
    if (typeof zIndex === "number") {
      this.sendCommand({ type: "update_layout", layerId, layout, zIndex });
      return;
    }
    this.sendCommand({ type: "update_layout", layerId, layout });
  }

  /**
   * Remove a layer from the renderer process.
   *
   * @param layerId Layer identifier.
   */
  async removeLayer(layerId: string): Promise<void> {
    await this.ensureReady();
    this.sendCommand({ type: "remove_layer", layerId });
  }

  /**
   * Register a callback to receive rendered frames.
   *
   * @param callback Frame callback.
   */
  onFrame(callback: (frame: GraphicsFrameT) => void): void {
    this.frameCallback = callback;
  }

  /**
   * Register a callback for renderer errors.
   *
   * @param callback Error callback.
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  /**
   * Shutdown renderer process and IPC server.
   */
  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    const hasExited = () =>
      child.exitCode !== null || child.signalCode !== null;
    const awaitExit = () =>
      new Promise<void>((resolve) => {
        if (hasExited()) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });

    this.sendCommand({ type: "shutdown" });

    const gracefulTimeoutMs = 4000;
    const forceTimeoutMs = 2000;

    await Promise.race([
      awaitExit(),
      new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => resolve(), gracefulTimeoutMs);
        void awaitExit().then(() => clearTimeout(timeoutId));
      }),
    ]);

    if (!hasExited()) {
      child.kill("SIGTERM");
      await Promise.race([
        awaitExit(),
        new Promise<void>((resolve) => {
          const timeoutId = setTimeout(() => resolve(), forceTimeoutMs);
          void awaitExit().then(() => clearTimeout(timeoutId));
        }),
      ]);
    }

    if (!hasExited()) {
      child.kill("SIGKILL");
      await awaitExit();
    }

    this.child = null;
    this.ipcSocket?.destroy();
    this.ipcSocket = null;
    this.ipcAuthenticated = false;
    this.pendingCommands = [];
    this.ipcToken = null;
    if (this.configReadyRejecter) {
      this.configReadyRejecter(new Error("Renderer shutdown"));
    }
    this.configReadyResolver = null;
    this.configReadyRejecter = null;
    this.configReadyPromise = null;
    await this.stopIpcServer();
  }

  private async ensureReady(): Promise<void> {
    if (!this.child) {
      await this.initialize();
      return;
    }
    if (this.readyPromise) {
      await this.readyPromise;
    }
  }

  private async ensureRendererConfigured(): Promise<void> {
    if (!this.sessionConfig) {
      return;
    }
    const config = this.sessionConfig;
    const clearColor = config.clearColor
      ? `${config.clearColor.r},${config.clearColor.g},${config.clearColor.b},${config.clearColor.a}`
      : "none";
    const configKey = [
      config.width,
      config.height,
      config.fps,
      config.pixelFormat,
      config.framebusName,
      config.framebusSize,
      config.backgroundMode,
      clearColor,
    ].join("|");

    if (this.rendererConfigured && this.lastSentConfigKey === configKey) {
      return;
    }

    this.lastSentConfigKey = configKey;

    if (process.env.BRIDGE_GRAPHICS_RENDERER_SINGLE === "1") {
      if (!config.framebusName || config.framebusSize <= 0) {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer] FrameBus config missing; renderer_configure skipped"
        );
        return;
      }
    }

    if (this.configReadyRejecter) {
      this.configReadyRejecter(new Error("Renderer config superseded"));
    }
    this.configReadyPromise = new Promise((resolve, reject) => {
      this.configReadyResolver = resolve;
      this.configReadyRejecter = reject;
    });

    this.sendCommand({
      type: "renderer_configure",
      width: config.width,
      height: config.height,
      fps: config.fps,
      pixelFormat: config.pixelFormat,
      framebusName: config.framebusName,
      framebusSize: config.framebusSize,
      backgroundMode: config.backgroundMode,
      clearColor: config.clearColor,
    });
    this.rendererConfigured = false;

    if (this.configReadyPromise) {
      await this.configReadyPromise;
    }
  }

  /**
   * Start a local IPC server bound to localhost only.
   *
   * @returns Allocated port number for IPC server.
   */
  private async startIpcServer(): Promise<number> {
    if (this.ipcServer) {
      return 0;
    }

    this.ipcServer = net.createServer((socket) => {
      if (this.ipcSocket) {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Rejecting extra client",
        );
        socket.destroy();
        return;
      }
      this.ipcSocket = socket;
      this.ipcAuthenticated = false;
      this.ipcBuffer = Buffer.alloc(0);
      this.logStructured(
        "info",
        { component: "graphics-renderer" },
        "[GraphicsRenderer IPC] Client connected",
      );
      // IPC data is untrusted until the token handshake completes.
      socket.on("data", (data) => this.handleIpcData(data));
      socket.on("close", () => {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Client disconnected",
        );
        this.ipcSocket = null;
        this.ipcAuthenticated = false;
      });
      socket.on("error", (error) => {
        this.logStructured(
          "error",
          { component: "graphics-renderer" },
          `[GraphicsRenderer IPC] ${error.message}`,
        );
      });
    });

    return new Promise((resolve, reject) => {
      this.ipcServer?.listen(0, "127.0.0.1", () => {
        const address = this.ipcServer?.address();
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error("Failed to allocate IPC port"));
      });
    });
  }

  private async stopIpcServer(): Promise<void> {
    if (!this.ipcServer) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ipcServer?.close(() => resolve());
    });
    this.ipcServer = null;
  }

  private getLogger(): LoggerLikeT & { debug?: (msg: string) => void } {
    try {
      return getBridgeContext().logger;
    } catch {
      return console;
    }
  }

  private logStructured(
    level: "debug" | "info" | "warn" | "error",
    context: Record<string, unknown>,
    message: string,
  ): void {
    const logger = this.getLogger();
    const logFn =
      level === "debug"
        ? logger.debug || logger.info
        : level === "info"
          ? logger.info
          : level === "warn"
            ? logger.warn
            : logger.error;
    const contextSuffix =
      Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
    logFn.call(logger, `${message}${contextSuffix}`);
  }

  private handleRendererOutput(
    data: Buffer,
    stream: "stdout" | "stderr",
  ): void {
    const text = data.toString();
    if (stream === "stdout") {
      this.stdoutBuffer += text;
      this.flushRendererLines("stdout");
      return;
    }
    this.stderrBuffer += text;
    this.flushRendererLines("stderr");
  }

  private flushRendererLines(stream: "stdout" | "stderr"): void {
    let buffer = stream === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      this.logRendererLine(line, stream === "stderr" ? "warn" : "info");
      newlineIndex = buffer.indexOf("\n");
    }
    if (stream === "stdout") {
      this.stdoutBuffer = buffer;
    } else {
      this.stderrBuffer = buffer;
    }
  }

  private logRendererLine(
    line: string,
    fallbackLevel: "info" | "warn" | "error",
  ): void {
    if (!line) {
      return;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const levelValue = typeof parsed.level === "number" ? parsed.level : null;
      const msgValue = typeof parsed.msg === "string" ? parsed.msg : line;
      const rest = { ...parsed };
      delete rest.level;
      delete rest.msg;
      delete rest.time;
      delete rest.pid;
      delete rest.hostname;
      const context = { component: "graphics-renderer", ...rest };
      if (levelValue !== null) {
        if (levelValue >= 50) {
          this.logStructured("error", context, msgValue);
          return;
        }
        if (levelValue >= 40) {
          this.logStructured("warn", context, msgValue);
          return;
        }
        if (levelValue >= 30) {
          this.logStructured("info", context, msgValue);
          return;
        }
        this.logStructured("debug", context, msgValue);
        return;
      }
    } catch {
      // Fall through to text logging.
    }

    const context = { component: "graphics-renderer" };
    this.logStructured(fallbackLevel, context, line);
  }

  private handleIpcData(data: Buffer): void {
    this.ipcBuffer = Buffer.concat([this.ipcBuffer, data]);
    if (this.ipcBuffer.length > MAX_IPC_BUFFER_BYTES) {
      this.logStructured(
        "warn",
        { component: "graphics-renderer" },
        "[GraphicsRenderer IPC] Buffer size exceeded limit",
      );
      this.ipcBuffer = Buffer.alloc(0);
      this.ipcSocket?.destroy();
      return;
    }

    while (this.ipcBuffer.length >= 4) {
      const headerLength = this.ipcBuffer.readUInt32BE(0);
      if (headerLength === 0 || headerLength > MAX_IPC_HEADER_BYTES) {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Header length exceeds limit",
        );
        this.ipcBuffer = Buffer.alloc(0);
        this.ipcSocket?.destroy();
        return;
      }
      if (this.ipcBuffer.length < 4 + headerLength) {
        return;
      }

      const headerRaw = this.ipcBuffer.subarray(4, 4 + headerLength);
      let header: {
        type: string;
        bufferLength?: number;
        [key: string]: unknown;
      };
      try {
        header = JSON.parse(headerRaw.toString("utf-8")) as {
          type: string;
          bufferLength?: number;
          [key: string]: unknown;
        };
      } catch {
        this.ipcBuffer = Buffer.alloc(0);
        return;
      }

      const hasBufferLength = Object.prototype.hasOwnProperty.call(
        header,
        "bufferLength",
      );
      if (hasBufferLength && typeof header.bufferLength !== "number") {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Invalid buffer length type",
        );
        this.ipcBuffer = Buffer.alloc(0);
        this.ipcSocket?.destroy();
        return;
      }
      const bufferLength =
        typeof header.bufferLength === "number" ? header.bufferLength : 0;
      if (bufferLength < 0 || bufferLength > MAX_IPC_PAYLOAD_BYTES) {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Payload length exceeds limit",
        );
        this.ipcBuffer = Buffer.alloc(0);
        this.ipcSocket?.destroy();
        return;
      }
      const totalLength = 4 + headerLength + bufferLength;
      if (this.ipcBuffer.length < totalLength) {
        return;
      }

      let payloadBuffer: Buffer | null = null;
      if (bufferLength > 0) {
        payloadBuffer = this.ipcBuffer.subarray(4 + headerLength, totalLength);
      }

      this.ipcBuffer = this.ipcBuffer.subarray(totalLength);

      const messageToken = typeof header.token === "string" ? header.token : "";
      if (header.type === "hello") {
        if (this.ipcToken && messageToken === this.ipcToken) {
          this.ipcAuthenticated = true;
          this.logStructured(
            "info",
            { component: "graphics-renderer" },
            "[GraphicsRenderer IPC] Handshake complete",
          );
          this.flushPendingCommands();
          if (this.readyResolver) {
            this.readyResolver();
            this.readyResolver = null;
            this.readyRejecter = null;
          }
        } else {
          this.logStructured(
            "warn",
            { component: "graphics-renderer" },
            "[GraphicsRenderer IPC] Invalid token from client",
          );
          this.ipcSocket?.destroy();
        }
        continue;
      }

      // Drop messages without a matching token (prevents spoofed frames).
      if (this.ipcToken && messageToken !== this.ipcToken) {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Token mismatch on message",
        );
        continue;
      }

      if (!this.ipcAuthenticated) {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Ignoring message before handshake",
        );
        continue;
      }

      if (header.type === "ready") {
        this.rendererConfigured = true;
        if (this.configReadyResolver) {
          this.configReadyResolver();
        }
        this.configReadyResolver = null;
        this.configReadyRejecter = null;
        this.configReadyPromise = null;
      }

      if (header.type === "frame" && payloadBuffer && this.frameCallback) {
        const layerId = String(header.layerId || "");
        const width = Number(header.width || 0);
        const height = Number(header.height || 0);
        if (DEBUG_GRAPHICS && !this.debugFirstFrameLogged.has(layerId)) {
          this.debugFirstFrameLogged.add(layerId);
          this.logStructured(
            "debug",
            {
              component: "graphics-renderer",
              layerId,
              width,
              height,
              bufferLength: payloadBuffer.length,
              expectedLength: width * height * 4,
            },
            "[GraphicsRenderer IPC] Debug frame received",
          );
        }
        if (
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0 ||
          width > MAX_FRAME_DIMENSION ||
          height > MAX_FRAME_DIMENSION
        ) {
          this.logStructured(
            "warn",
            { component: "graphics-renderer" },
            "[GraphicsRenderer IPC] Invalid frame dimensions",
          );
          continue;
        }
        const expectedLength = width * height * 4;
        if (payloadBuffer.length !== expectedLength) {
          if (DEBUG_GRAPHICS) {
            this.logStructured(
              "warn",
              {
                component: "graphics-renderer",
                layerId,
                width,
                height,
                bufferLength: payloadBuffer.length,
                expectedLength,
              },
              "[GraphicsRenderer IPC] Debug buffer length mismatch",
            );
          }
          this.logStructured(
            "warn",
            { component: "graphics-renderer" },
            "[GraphicsRenderer IPC] Frame buffer length mismatch",
          );
          continue;
        }
        const frame: GraphicsFrameT = {
          layerId: String(header.layerId || ""),
          width,
          height,
          buffer: payloadBuffer,
          timestamp: Number(header.timestamp || Date.now()),
        };
        this.frameCallback(frame);
      }

      if (header.type === "error" && typeof header.message === "string") {
        const error = new Error(header.message);
        if (this.configReadyRejecter) {
          this.configReadyRejecter(error);
          this.configReadyResolver = null;
          this.configReadyRejecter = null;
          this.configReadyPromise = null;
        }
        if (this.errorCallback) {
          this.errorCallback(error);
        }
        this.logStructured(
          "error",
          { component: "graphics-renderer" },
          `[GraphicsRenderer] ${header.message}`,
        );
      }
    }
  }

  private sendCommand(message: Record<string, unknown>): void {
    const payload = this.ipcToken
      ? { ...message, token: this.ipcToken }
      : message;
    if (!this.ipcSocket || !this.ipcAuthenticated) {
      this.pendingCommands.push(payload);
      return;
    }

    const header = Buffer.from(JSON.stringify(payload), "utf-8");
    const headerLength = Buffer.alloc(4);
    headerLength.writeUInt32BE(header.length, 0);
    this.ipcSocket.write(Buffer.concat([headerLength, header]));
  }

  private flushPendingCommands(): void {
    if (!this.ipcSocket || !this.ipcAuthenticated) {
      return;
    }
    while (this.pendingCommands.length > 0) {
      const message = this.pendingCommands.shift();
      if (!message) {
        continue;
      }
      const header = Buffer.from(JSON.stringify(message), "utf-8");
      const headerLength = Buffer.alloc(4);
      headerLength.writeUInt32BE(header.length, 0);
      this.ipcSocket.write(Buffer.concat([headerLength, header]));
    }
  }
}
