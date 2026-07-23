import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
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
  GraphicsRendererLifecycleStateT,
  GraphicsTemplateBindingsT,
} from "./graphics-renderer.js";

type RendererAssetMapT = Record<string, { filePath: string; mime: string }>;

const GRAPHICS_RENDERER_PROFILE_DIR = "graphics-renderer-profile";
const VOLATILE_RENDERER_CACHE_PATHS = [
  "GPUCache",
  "Code Cache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
];
const RECOVERY_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECOVERY_ATTEMPTS = 2;
const IPC_SERVER_CLOSE_TIMEOUT_MS = 500;
const CONFIG_READY_TIMEOUT_MS = 15_000;

type RendererReadyAckT = {
  type: "ready";
  configId?: string;
  width?: number;
  height?: number;
  fps?: number;
  pixelFormat?: number;
  framebusName?: string;
  framebusSize?: number;
  framebusSlotCount?: number;
  rendererConfigGeneration?: number;
};

const normalizeFrameBusNameForCompare = (name: string): string =>
  name
    .trim()
    .replace(/^\/+/, "")
    .replace(/^(?:local|global)\\+/i, "");

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
  private ipcServerStopPromise: Promise<void> | null = null;
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
  private pendingConfigId: string | null = null;
  private configReadyPromise: Promise<void> | null = null;
  private configReadyResolver: (() => void) | null = null;
  private configReadyRejecter: ((error: Error) => void) | null = null;
  private configReadyTimeout: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private latestAssets: RendererAssetMapT | null = null;
  private latestLayers = new Map<string, GraphicsRenderLayerInputT>();
  private launchWithGpuDisabled =
    process.env.BRIDGE_GRAPHICS_DISABLE_GPU === "1";
  private gpuFallbackAttempted = this.launchWithGpuDisabled;
  private recovering = false;
  private lifecycleState: GraphicsRendererLifecycleStateT = "ready";
  private recoveryAttemptTimes: number[] = [];

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
        userDataDir: this.resolveRendererUserDataDir(),
        lifecycleState: this.lifecycleState,
      },
      "[GraphicsRenderer] Runtime context",
    );
    this.logRendererCacheDiagnostics();
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
    env.BRIDGE_PARENT_PID = String(process.pid);
    if (this.launchWithGpuDisabled) {
      env.BRIDGE_GRAPHICS_DISABLE_GPU = "1";
    }
    env.BRIDGE_GRAPHICS_USER_DATA_DIR = this.resolveRendererUserDataDir();
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
        userDataDir: env.BRIDGE_GRAPHICS_USER_DATA_DIR,
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
      const shouldRecover =
        !this.isShuttingDown && this.shouldAttemptRecovery(code, signal, exitedBeforeReady);

      const ipcServerStopped = this.resetRuntimeStateAfterExit(exitError);

      if (shouldRecover) {
        void this.recoverRenderer("process_exit", exitError, ipcServerStopped);
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
    this.latestLayers.set(input.layerId, { ...input });
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
    const cached = this.latestLayers.get(layerId);
    if (cached) {
      this.latestLayers.set(layerId, {
        ...cached,
        values: { ...cached.values, ...values },
        bindings,
      });
    }
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
    const cached = this.latestLayers.get(layerId);
    if (cached) {
      this.latestLayers.set(layerId, {
        ...cached,
        layout,
        zIndex: typeof zIndex === "number" ? zIndex : cached.zIndex,
      });
    }
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
    this.latestLayers.delete(layerId);
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

  getLifecycleState(): GraphicsRendererLifecycleStateT {
    return this.lifecycleState;
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
    this.latestLayers.clear();
    this.ipcToken = null;
    if (this.configReadyRejecter) {
      this.configReadyRejecter(new Error("Renderer shutdown"));
    }
    this.clearConfigReadyTimeout();
    this.configReadyResolver = null;
    this.configReadyRejecter = null;
    this.configReadyPromise = null;
    this.pendingConfigId = null;
    this.isShuttingDown = false;
    this.lifecycleState = "ready";
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

  private shouldAttemptRecovery(
    code: number | null,
    signal: NodeJS.Signals | null,
    exitedBeforeReady: boolean
  ): boolean {
    if (exitedBeforeReady) {
      return false;
    }
    if (this.recovering) {
      return false;
    }
    if (code === 0 && !signal) {
      return false;
    }
    if (!signal) {
      return true;
    }
    return signal !== "SIGTERM" && signal !== "SIGKILL";
  }

  private resetRuntimeStateAfterExit(exitError: Error): Promise<void> {
    this.child = null;
    this.readyPromise = null;
    this.readyResolver = null;
    this.readyRejecter = null;
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
    this.clearConfigReadyTimeout();
    this.configReadyResolver = null;
    this.configReadyRejecter = null;
    this.configReadyPromise = null;
    this.pendingConfigId = null;

    return this.stopIpcServer();
  }

  private async recoverRenderer(
    reason: string,
    cause: Error,
    ipcServerStopped: Promise<void> = Promise.resolve()
  ): Promise<void> {
    const attempt = this.registerRecoveryAttempt();
    const recoveryId = randomBytes(8).toString("hex");
    if (attempt === null) {
      this.lifecycleState = "degraded";
      this.logStructured(
        "error",
        {
          component: "graphics-renderer",
          recoveryId,
          reason,
          lifecycleState: this.lifecycleState,
          maxAttempts: MAX_RECOVERY_ATTEMPTS,
          windowMs: RECOVERY_WINDOW_MS,
        },
        `[GraphicsRenderer] Recovery limit reached; entering degraded mode: ${cause.message}`,
      );
      if (this.errorCallback) {
        this.errorCallback(
          new Error(`Graphics renderer degraded after repeated failures: ${cause.message}`)
        );
      }
      return;
    }

    this.recovering = true;
    const shouldUseGpuFallback =
      attempt >= 2 &&
      !this.gpuFallbackAttempted &&
      !this.launchWithGpuDisabled &&
      process.env.BRIDGE_GRAPHICS_AUTO_GPU_FALLBACK !== "0";
    if (shouldUseGpuFallback) {
      this.launchWithGpuDisabled = true;
      this.gpuFallbackAttempted = true;
      this.lifecycleState = "gpu_fallback";
    } else {
      this.lifecycleState = "recovering";
    }

    this.logStructured(
      "warn",
      {
        component: "graphics-renderer",
        recoveryId,
        reason,
        attempt,
        gpuDisabled: this.launchWithGpuDisabled,
        lifecycleState: this.lifecycleState,
      },
      `[GraphicsRenderer] Recovery starting: ${cause.message}`,
    );

    try {
      await ipcServerStopped;
      const cleanupResult = await this.cleanupRendererCaches();
      this.logStructured(
        "info",
        {
          component: "graphics-renderer",
          recoveryId,
          reason,
          attempt,
          cleanupPaths: cleanupResult.paths,
          cleanupErrors: cleanupResult.errors,
        },
        "[GraphicsRenderer] Recovery cache cleanup complete",
      );
      await this.initialize();
      if (this.latestAssets) {
        await this.setAssets(this.latestAssets);
      }
      if (this.sessionConfig) {
        await this.configureSession(this.sessionConfig);
      }
      await this.replayLatestLayers();
      this.lifecycleState = this.launchWithGpuDisabled ? "gpu_fallback" : "ready";
      this.logStructured(
        "info",
        {
          component: "graphics-renderer",
          recoveryId,
          reason,
          attempt,
          gpuDisabled: this.launchWithGpuDisabled,
          restartResult: "success",
          lifecycleState: this.lifecycleState,
        },
        "[GraphicsRenderer] Recovery restart completed",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoveryError = new Error(
        `Graphics renderer recovery restart failed: ${message}`
      );
      this.logStructured(
        "error",
        {
          component: "graphics-renderer",
          recoveryId,
          reason,
          attempt,
          gpuDisabled: this.launchWithGpuDisabled,
          restartResult: "failed",
          lifecycleState: this.lifecycleState,
        },
        `[GraphicsRenderer] ${recoveryError.message}`,
      );
      if (attempt < MAX_RECOVERY_ATTEMPTS) {
        this.recovering = false;
        void this.recoverRenderer("recovery_restart_failed", recoveryError);
        return;
      }
      if (this.errorCallback) {
        this.lifecycleState = "degraded";
        this.errorCallback(recoveryError);
      }
    } finally {
      this.recovering = false;
    }
  }

  private registerRecoveryAttempt(): number | null {
    const now = Date.now();
    this.recoveryAttemptTimes = this.recoveryAttemptTimes.filter(
      (time) => now - time < RECOVERY_WINDOW_MS
    );
    if (this.recoveryAttemptTimes.length >= MAX_RECOVERY_ATTEMPTS) {
      return null;
    }
    this.recoveryAttemptTimes.push(now);
    return this.recoveryAttemptTimes.length;
  }

  private async replayLatestLayers(): Promise<void> {
    const layers = Array.from(this.latestLayers.values());
    for (const layer of layers) {
      await this.renderLayer(layer);
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
    this.clearConfigReadyTimeout();
    const configId = randomBytes(8).toString("hex");
    this.pendingConfigId = configId;
    this.configReadyPromise = new Promise((resolve, reject) => {
      this.configReadyResolver = resolve;
      this.configReadyRejecter = reject;
    });
    this.configReadyTimeout = setTimeout(() => {
      if (!this.configReadyRejecter) {
        return;
      }
      const error = new Error("Renderer config ready timed out");
      this.configReadyRejecter(error);
      this.configReadyResolver = null;
      this.configReadyRejecter = null;
      this.configReadyPromise = null;
      this.pendingConfigId = null;
      this.configReadyTimeout = null;
    }, CONFIG_READY_TIMEOUT_MS);

    this.logStructured(
      "info",
      {
        component: "graphics-renderer",
        width: config.width,
        height: config.height,
        fps: config.fps,
        pixelFormat: config.pixelFormat,
        framebusName: config.framebusName,
        framebusSlotCount: config.framebusSlotCount,
        framebusSize: config.framebusSize,
        backgroundMode: config.backgroundMode,
        clearColor: config.clearColor,
      },
      "[GraphicsRenderer] Sending renderer_configure",
    );

    this.sendCommand({
      type: "renderer_configure",
      configId,
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

  private clearConfigReadyTimeout(): void {
    if (!this.configReadyTimeout) {
      return;
    }
    clearTimeout(this.configReadyTimeout);
    this.configReadyTimeout = null;
  }

  private isReadyAckForCurrentConfig(ack: RendererReadyAckT): boolean {
    const config = this.sessionConfig;
    if (!config || !this.pendingConfigId) {
      this.logStructured(
        "warn",
        { component: "graphics-renderer" },
        "[GraphicsRenderer IPC] Ignoring ready without pending renderer_configure",
      );
      return false;
    }

    const expectedFrameBusName = config.framebusName.trim();
    const actualFrameBusName = ack.framebusName?.trim() ?? "";
    const normalizedExpectedFrameBusName =
      normalizeFrameBusNameForCompare(expectedFrameBusName);
    const normalizedActualFrameBusName =
      normalizeFrameBusNameForCompare(actualFrameBusName);
    const mismatches: string[] = [];

    if (ack.configId !== this.pendingConfigId) {
      mismatches.push("configId");
    }
    if (ack.width !== config.width) {
      mismatches.push("width");
    }
    if (ack.height !== config.height) {
      mismatches.push("height");
    }
    if (ack.fps !== config.fps) {
      mismatches.push("fps");
    }
    if (ack.pixelFormat !== config.pixelFormat) {
      mismatches.push("pixelFormat");
    }
    if (normalizedActualFrameBusName !== normalizedExpectedFrameBusName) {
      mismatches.push("framebusName");
    }
    if (ack.framebusSlotCount !== config.framebusSlotCount) {
      mismatches.push("framebusSlotCount");
    }
    if (ack.framebusSize !== config.framebusSize) {
      mismatches.push("framebusSize");
    }

    if (mismatches.length === 0) {
      return true;
    }

    this.logStructured(
      "warn",
      {
        component: "graphics-renderer",
        mismatches,
        expectedConfigId: this.pendingConfigId,
        actualConfigId: ack.configId ?? null,
        expectedFrameBusName,
        actualFrameBusName,
        expectedFrameBusSlotCount: config.framebusSlotCount,
        actualFrameBusSlotCount: ack.framebusSlotCount ?? null,
        expectedFrameBusSize: config.framebusSize,
        actualFrameBusSize: ack.framebusSize ?? null,
        rendererConfigGeneration: ack.rendererConfigGeneration ?? null,
      },
      "[GraphicsRenderer IPC] Ignoring renderer ready for non-current config",
    );
    return false;
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
    if (this.ipcServerStopPromise) {
      await this.ipcServerStopPromise;
      return;
    }
    if (!this.ipcServer) {
      return;
    }
    this.ipcServerStopPromise = new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve();
      };
      const timeoutId = setTimeout(finish, IPC_SERVER_CLOSE_TIMEOUT_MS);
      this.ipcServer?.close(() => {
        clearTimeout(timeoutId);
        finish();
      });
    });
    await this.ipcServerStopPromise;
    this.ipcServer = null;
    this.ipcPort = null;
    this.ipcServerReady = null;
    this.ipcServerStopPromise = null;
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
        const readyAck: RendererReadyAckT = {
          type: "ready",
          configId: typeof header.configId === "string" ? header.configId : undefined,
          width: typeof header.width === "number" ? header.width : undefined,
          height: typeof header.height === "number" ? header.height : undefined,
          fps: typeof header.fps === "number" ? header.fps : undefined,
          pixelFormat:
            typeof header.pixelFormat === "number" ? header.pixelFormat : undefined,
          framebusName:
            typeof header.framebusName === "string" ? header.framebusName : undefined,
          framebusSize:
            typeof header.framebusSize === "number" ? header.framebusSize : undefined,
          framebusSlotCount:
            typeof header.framebusSlotCount === "number"
              ? header.framebusSlotCount
              : undefined,
          rendererConfigGeneration:
            typeof header.rendererConfigGeneration === "number"
              ? header.rendererConfigGeneration
              : undefined,
        };
        if (!this.isReadyAckForCurrentConfig(readyAck)) {
          continue;
        }
        this.rendererConfigured = true;
        this.pendingConfigId = null;
        this.clearConfigReadyTimeout();
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

  private resolveRendererUserDataDir(): string {
    try {
      return path.join(getBridgeContext().userDataDir, GRAPHICS_RENDERER_PROFILE_DIR);
    } catch {
      return path.join(process.cwd(), ".bridge-data", GRAPHICS_RENDERER_PROFILE_DIR);
    }
  }

  private resolveRendererCachePaths(): string[] {
    const userDataDir = this.resolveRendererUserDataDir();
    return VOLATILE_RENDERER_CACHE_PATHS.map((relativePath) =>
      path.join(userDataDir, relativePath)
    );
  }

  private async cleanupRendererCaches(): Promise<{
    paths: string[];
    errors: string[];
  }> {
    const paths = this.resolveRendererCachePaths();
    const errors: string[] = [];
    try {
      await fs.mkdir(this.resolveRendererUserDataDir(), { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${this.resolveRendererUserDataDir()}: ${message}`);
    }
    for (const cachePath of paths) {
      try {
        await fs.rm(cachePath, { recursive: true, force: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${cachePath}: ${message}`);
      }
    }
    return { paths, errors };
  }

  private async inspectPath(targetPath: string): Promise<{
    path: string;
    exists: boolean;
    size?: number;
  }> {
    try {
      const stat = await fs.stat(targetPath);
      return { path: targetPath, exists: true, size: stat.size };
    } catch {
      return { path: targetPath, exists: false };
    }
  }

  private voidLogPromise(promise: Promise<void>): void {
    void promise;
  }

  private logRendererCacheDiagnostics(): void {
    this.voidLogPromise((async () => {
      const cachePaths = await Promise.all(
        this.resolveRendererCachePaths().map((cachePath) => this.inspectPath(cachePath))
      );
      this.logStructured(
        "info",
        {
          component: "graphics-renderer",
          userDataDir: this.resolveRendererUserDataDir(),
          cachePaths,
        },
        "[GraphicsRenderer] Cache diagnostics",
      );
    })());
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
