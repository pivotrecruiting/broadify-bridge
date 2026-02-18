import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import type { GraphicsLayoutT } from "../graphics-schemas.js";
import { getBridgeContext, type LoggerLikeT } from "../../bridge-context.js";
import {
  decodeNextIpcPacket,
  encodeIpcPacket,
  isIpcBufferWithinLimit,
  appendIpcBuffer,
  type IpcBufferT,
} from "./renderer-ipc-framing.js";
import {
  drainLines,
  parseRendererLogLine,
} from "./renderer-log-parser.js";
import {
  describeBinary,
  resolveElectronBinary,
  resolveRendererEntry,
} from "./electron-renderer-launch.js";
import type {
  GraphicsRenderer,
  GraphicsRenderLayerInputT,
  GraphicsRendererConfigT,
  GraphicsTemplateBindingsT,
} from "./graphics-renderer.js";

type RendererAssetMapT = Record<string, { filePath: string; mime: string }>;

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
  private errorCallback: ((error: Error) => void) | null = null;
  private ipcServer: net.Server | null = null;
  private ipcSocket: net.Socket | null = null;
  private ipcBuffer: IpcBufferT = Buffer.alloc(0);
  private ipcPort: number | null = null;
  private ipcServerReady: Promise<number> | null = null;
  // Token used to authenticate IPC messages with the renderer process.
  private ipcToken: string | null = null;
  private ipcAuthenticated = false;
  // Commands queued before IPC handshake is complete.
  private pendingCommands: Array<Record<string, unknown>> = [];
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private rendererConfigured = false;
  private sessionConfig: GraphicsRendererConfigT | null = null;
  private lastSentConfigKey: string | null = null;
  private configReadyPromise: Promise<void> | null = null;
  private configReadyResolver: (() => void) | null = null;
  private configReadyRejecter: ((error: Error) => void) | null = null;
  private isShuttingDown = false;
  private latestAssets: RendererAssetMapT | null = null;
  private launchWithGpuDisabled =
    process.env.BRIDGE_GRAPHICS_DISABLE_GPU === "1";
  private gpuFallbackAttempted = this.launchWithGpuDisabled;
  private recoveringWithGpuFallback = false;

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

    this.logStructured(
      "info",
      {
        component: "graphics-renderer",
        nodeEnv: process.env.NODE_ENV || "",
        cwd: process.cwd(),
        execPath: process.execPath,
        resourcesPath: process.resourcesPath || "",
      },
      "[GraphicsRenderer] Runtime context",
    );
    this.logStructured(
      "info",
      { component: "graphics-renderer" },
      `[GraphicsRenderer] Binary resolved: ${describeBinary(electronBinary)}`,
    );
    this.logStructured(
      "info",
      { component: "graphics-renderer" },
      `[GraphicsRenderer] Entry resolved: ${describeBinary(entry)}`,
    );

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
    if (this.launchWithGpuDisabled) {
      env.BRIDGE_GRAPHICS_DISABLE_GPU = "1";
    }
    env.BRIDGE_GRAPHICS_IPC_PORT = String(ipcPort);
    env.BRIDGE_GRAPHICS_IPC_TOKEN = this.ipcToken;
    this.logStructured(
      "info",
      {
        component: "graphics-renderer",
        ipcPort,
        ipcTokenSet: Boolean(this.ipcToken),
        electronRunAsNode: env.ELECTRON_RUN_AS_NODE === "1",
        gpuDisabled: env.BRIDGE_GRAPHICS_DISABLE_GPU === "1",
      },
      "[GraphicsRenderer] IPC environment prepared",
    );

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
      const exitedBeforeReady = Boolean(this.readyRejecter);
      if (this.readyRejecter) {
        this.readyRejecter(
          new Error(
            `Graphics renderer exited before ready (code ${code}, signal ${signal})`,
          ),
        );
        this.readyRejecter = null;
        this.readyResolver = null;
      }

      const exitError = this.createRendererExitError(code, signal);
      const attemptGpuFallback =
        !this.isShuttingDown &&
        this.shouldAttemptGpuFallback(signal, exitedBeforeReady);

      this.resetRuntimeStateAfterExit(exitError);

      if (attemptGpuFallback) {
        this.launchWithGpuDisabled = true;
        this.gpuFallbackAttempted = true;
        this.recoveringWithGpuFallback = true;
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer] Renderer crashed with SIGSEGV; retrying once with GPU disabled",
        );
        void this.recoverWithGpuFallback();
        return;
      }

      if (!this.isShuttingDown && this.errorCallback) {
        this.errorCallback(exitError);
      }
    });

    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.child) {
          this.readyRejecter = null;
          this.readyResolver = null;
          this.child.kill();
        }
        reject(new Error("Graphics renderer startup timed out"));
      }, 12000);

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
    assets: RendererAssetMapT,
  ): Promise<void> {
    this.latestAssets = assets;
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

    this.isShuttingDown = true;
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
    this.isShuttingDown = false;
    await this.stopIpcServer();
  }

  private createRendererExitError(
    code: number | null,
    signal: NodeJS.Signals | null
  ): Error {
    return new Error(
      `Graphics renderer exited (code ${code ?? "unknown"}, signal ${
        signal ?? "unknown"
      })`
    );
  }

  private shouldAttemptGpuFallback(
    signal: NodeJS.Signals | null,
    exitedBeforeReady: boolean
  ): boolean {
    if (exitedBeforeReady) {
      return false;
    }
    if (this.recoveringWithGpuFallback || this.gpuFallbackAttempted) {
      return false;
    }
    if (process.env.NODE_ENV !== "production") {
      return false;
    }
    if (this.launchWithGpuDisabled) {
      return false;
    }
    if (process.env.BRIDGE_GRAPHICS_AUTO_GPU_FALLBACK === "0") {
      return false;
    }
    return signal === "SIGSEGV";
  }

  private resetRuntimeStateAfterExit(exitError: Error): void {
    this.child = null;
    this.rendererConfigured = false;
    this.lastSentConfigKey = null;
    this.ipcSocket?.destroy();
    this.ipcSocket = null;
    this.ipcAuthenticated = false;
    this.ipcBuffer = Buffer.alloc(0);
    this.pendingCommands = [];

    if (this.configReadyRejecter) {
      this.configReadyRejecter(exitError);
    }
    this.configReadyResolver = null;
    this.configReadyRejecter = null;
    this.configReadyPromise = null;
  }

  private async recoverWithGpuFallback(): Promise<void> {
    try {
      await this.initialize();
      if (this.latestAssets) {
        await this.setAssets(this.latestAssets);
      }
      if (this.sessionConfig) {
        await this.configureSession(this.sessionConfig);
      }
      this.logStructured(
        "info",
        { component: "graphics-renderer" },
        "[GraphicsRenderer] GPU fallback renderer restart completed",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoveryError = new Error(
        `Graphics renderer GPU fallback restart failed: ${message}`
      );
      this.logStructured(
        "error",
        { component: "graphics-renderer" },
        `[GraphicsRenderer] ${recoveryError.message}`,
      );
      if (this.errorCallback) {
        this.errorCallback(recoveryError);
      }
    } finally {
      this.recoveringWithGpuFallback = false;
    }
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
      config.framebusSlotCount,
      config.framebusSize,
      config.backgroundMode,
      clearColor,
    ].join("|");

    if (this.rendererConfigured && this.lastSentConfigKey === configKey) {
      return;
    }

    this.lastSentConfigKey = configKey;

    if (!config.framebusName || config.framebusSize <= 0) {
      this.logStructured(
        "warn",
        { component: "graphics-renderer" },
        "[GraphicsRenderer] FrameBus config missing; renderer_configure skipped"
      );
      return;
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
      framebusSlotCount: config.framebusSlotCount,
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
    if (this.ipcServerReady) {
      return this.ipcServerReady;
    }
    if (this.ipcServer) {
      if (this.ipcPort) {
        return this.ipcPort;
      }
      throw new Error("IPC server already started without a port");
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

    this.ipcServerReady = new Promise((resolve, reject) => {
      this.ipcServer?.once("error", (error) => {
        this.ipcServerReady = null;
        reject(error);
      });
      this.ipcServer?.listen(0, "127.0.0.1", () => {
        const address = this.ipcServer?.address();
        if (typeof address === "object" && address?.port) {
          this.ipcPort = address.port;
          this.logStructured(
            "info",
            { component: "graphics-renderer", port: address.port },
            "[GraphicsRenderer IPC] Server listening",
          );
          resolve(address.port);
          return;
        }
        this.ipcServerReady = null;
        reject(new Error("Failed to allocate IPC port"));
      });
    });
    return this.ipcServerReady;
  }

  private async stopIpcServer(): Promise<void> {
    if (!this.ipcServer) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ipcServer?.close(() => resolve());
    });
    this.ipcServer = null;
    this.ipcPort = null;
    this.ipcServerReady = null;
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
      this.flushRendererStream("stdout");
      return;
    }
    this.stderrBuffer += text;
    this.flushRendererStream("stderr");
  }

  private flushRendererStream(stream: "stdout" | "stderr"): void {
    const buffer = stream === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
    const { lines, remainder } = drainLines(buffer);
    if (stream === "stdout") {
      this.stdoutBuffer = remainder;
    } else {
      this.stderrBuffer = remainder;
    }
    for (const line of lines) {
      const parsed = parseRendererLogLine(
        line,
        stream === "stderr" ? "warn" : "info"
      );
      this.logStructured(
        parsed.level,
        { component: "graphics-renderer", ...parsed.context },
        parsed.message
      );
    }
  }

  private handleIpcData(data: Buffer): void {
    this.ipcBuffer = appendIpcBuffer(this.ipcBuffer, data);
    if (!isIpcBufferWithinLimit(this.ipcBuffer)) {
      this.logStructured(
        "warn",
        { component: "graphics-renderer" },
        "[GraphicsRenderer IPC] Buffer size exceeded limit",
      );
      this.ipcBuffer = Buffer.alloc(0);
      this.ipcSocket?.destroy();
      return;
    }

    while (true) {
      const decoded = decodeNextIpcPacket(this.ipcBuffer);
      if (decoded.kind === "incomplete") {
        return;
      }
      if (decoded.kind === "invalid") {
        const reasonMessage =
          decoded.reason === "header_length_exceeds_limit"
            ? "[GraphicsRenderer IPC] Header length exceeds limit"
            : decoded.reason === "invalid_buffer_length_type"
              ? "[GraphicsRenderer IPC] Invalid buffer length type"
              : decoded.reason === "payload_length_exceeds_limit"
                ? "[GraphicsRenderer IPC] Payload length exceeds limit"
                : "[GraphicsRenderer IPC] Invalid message framing";
        this.logStructured("warn", { component: "graphics-renderer" }, reasonMessage);
        this.ipcBuffer = Buffer.alloc(0);
        this.ipcSocket?.destroy();
        return;
      }

      this.ipcBuffer = decoded.remaining;
      const header = decoded.header;
      const messageType = typeof header.type === "string" ? header.type : "";
      const messageToken = typeof header.token === "string" ? header.token : "";
      if (messageType === "hello") {
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

      if (decoded.payload.length > 0) {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Unexpected binary payload; ignored",
        );
        continue;
      }

      if (messageType === "ready") {
        this.rendererConfigured = true;
        if (this.configReadyResolver) {
          this.configReadyResolver();
        }
        this.configReadyResolver = null;
        this.configReadyRejecter = null;
        this.configReadyPromise = null;
      }

      // Frame payloads over IPC were removed. Data plane is FrameBus only.
      if (messageType === "frame") {
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          "[GraphicsRenderer IPC] Unexpected frame payload; ignored",
        );
        continue;
      }

      if (messageType === "error" && typeof header.message === "string") {
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
    try {
      this.ipcSocket.write(encodeIpcPacket(payload));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.logStructured(
        "warn",
        { component: "graphics-renderer" },
        `[GraphicsRenderer IPC] Failed to encode command: ${messageText}`,
      );
    }
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
      try {
        this.ipcSocket.write(encodeIpcPacket(message));
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        this.logStructured(
          "warn",
          { component: "graphics-renderer" },
          `[GraphicsRenderer IPC] Failed to flush command: ${messageText}`,
        );
      }
    }
  }
}
