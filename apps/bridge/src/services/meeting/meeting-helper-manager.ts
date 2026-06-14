import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MEETING_FRAMEBUS_NAME,
  getVcamHelperStatus,
  isVcamExtensionAvailable,
  type VcamHelperStatusT,
} from "../../modules/vcam/vcam-helper.js";
import { getBridgeContext } from "../bridge-context.js";
import { MeetingHelperClient } from "./meeting-helper-client.js";
import {
  publishMeetingErrorEvent,
  publishMeetingStatusEvent,
} from "./meeting-event-publisher.js";

const HELPER_PATH_ENV = "BRIDGE_MEETING_HELPER_PATH";
const CONTROL_SOCKET_ENV = "BRIDGE_MEETING_CONTROL_SOCKET";
const FRAMEBUS_NAME_ENV = "BRIDGE_MEETING_FRAMEBUS_NAME";
const MODELS_DIR_ENV = "BRIDGE_MEETING_MODELS_DIR";
const START_TIMEOUT_MS = 20000;
const STATUS_POLL_INTERVAL_MS = 2000;

export type MeetingHelperLifecycleStateT =
  | "stopped"
  | "starting"
  | "running"
  | "error";

export type MeetingHelperStartOptionsT = {
  width?: number;
  height?: number;
  fps?: number;
};

export type MeetingHelperManagerStatusT = {
  state: MeetingHelperLifecycleStateT;
  port: number | null;
  pid: number | null;
  framebusName: string;
  previewPath: string;
  virtualCamera: VcamHelperStatusT;
  lastError: string | null;
};

type LoggerT = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type ReadyEventT = {
  type: "ready";
  framebus?: string;
  preview_port?: number;
  control_socket?: string;
};

const getLogger = (): LoggerT => {
  try {
    return getBridgeContext().logger;
  } catch {
    return {
      debug: (msg: string) => console.debug(msg),
      info: (msg: string) => console.info(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
  }
};

let testHelperPathOverride: string | null = null;

function getModuleDirname(): string {
  try {
    const url = (0, eval)("import.meta.url") as string;
    return dirname(fileURLToPath(url));
  } catch {
    return "/tmp";
  }
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * Resolve the native meeting-helper binary path.
 */
export function resolveMeetingHelperPath(): string {
  if (testHelperPathOverride !== null) {
    return testHelperPathOverride;
  }
  const envPath = process.env[HELPER_PATH_ENV];
  if (envPath) {
    return envPath;
  }

  const binaryName = platform() === "win32" ? "meeting-helper.exe" : "meeting-helper";
  const moduleDir = getModuleDirname();
  const resourcesPath = process.resourcesPath;

  if (process.env.NODE_ENV === "production" && resourcesPath) {
    return join(resourcesPath, "native", "meeting-helper", binaryName);
  }

  const candidates = uniquePaths([
    join(process.cwd(), "apps/bridge/native/meeting-helper", binaryName),
    join(process.cwd(), "native/meeting-helper", binaryName),
    join(moduleDir, "../../../native/meeting-helper", binaryName),
  ]);

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function resolveMeetingModelsDir(helperPath: string = resolveMeetingHelperPath()): string {
  const envPath = process.env[MODELS_DIR_ENV];
  if (envPath) {
    return envPath;
  }
  const resourcesPath = process.resourcesPath;
  if (process.env.NODE_ENV === "production" && resourcesPath) {
    return join(resourcesPath, "native", "meeting-helper", "models");
  }
  return join(dirname(helperPath), "models");
}

/**
 * Test-only path override for resolveMeetingHelperPath.
 *
 * @internal
 */
export function __setMeetingHelperPathForTesting(path: string | null): void {
  testHelperPathOverride = path;
}

/**
 * Find a free localhost TCP port for the MJPEG preview server.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to allocate port")));
      }
    });
  });
}

function resolveControlSocketPath(): string {
  const envPath = process.env[CONTROL_SOCKET_ENV];
  if (envPath) {
    return envPath;
  }
  const suffix = `${process.pid}-${Date.now()}`;
  if (platform() === "win32") {
    return `\\\\.\\pipe\\broadify-meeting-${suffix}`;
  }
  return join(tmpdir(), `broadify-meeting-${suffix}.sock`);
}

/**
 * Native Meeting Helper Manager.
 *
 * Spawns and supervises the C++ meeting-helper process, keeps FrameBus as the
 * data plane and exposes the stable meeting_* relay contract through JSON-RPC.
 */
export class MeetingHelperManager {
  private state: MeetingHelperLifecycleStateT = "stopped";
  private process: ChildProcess | null = null;
  private client: MeetingHelperClient | null = null;
  private port: number | null = null;
  private lastError: string | null = null;
  private statusPollTimer: NodeJS.Timeout | null = null;
  private lastPublishedStatus: string | null = null;
  private startPromise: Promise<MeetingHelperManagerStatusT> | null = null;
  private stdoutBuffer = "";
  private readyResolver: ((event: ReadyEventT) => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;

  getClient(): MeetingHelperClient | null {
    return this.client;
  }

  getFramebusName(): string {
    return process.env[FRAMEBUS_NAME_ENV] || DEFAULT_MEETING_FRAMEBUS_NAME;
  }

  getStatus(): MeetingHelperManagerStatusT {
    return {
      state: this.state,
      port: this.port,
      pid: this.process?.pid ?? null,
      framebusName: this.getFramebusName(),
      previewPath: "/preview.mjpg",
      virtualCamera: getVcamHelperStatus({ framebusName: this.getFramebusName() }),
      lastError: this.lastError,
    };
  }

  isRunning(): boolean {
    return this.state === "running" && this.client !== null;
  }

  async start(
    options: MeetingHelperStartOptionsT = {},
  ): Promise<MeetingHelperManagerStatusT> {
    if (this.state === "running") {
      return this.getStatus();
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal(options).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<MeetingHelperManagerStatusT> {
    this.stopStatusPolling();
    this.killProcess();
    this.client = null;
    this.port = null;
    this.state = "stopped";
    await this.publishStatus("engine_stopped", true);
    return this.getStatus();
  }

  async getFullStatus(): Promise<Record<string, unknown>> {
    const manager = this.getStatus();
    if (!this.client || this.state !== "running") {
      return { manager, engine: null };
    }
    try {
      const [engineState, framebus] = await Promise.all([
        this.client.getState(),
        this.client.framebusStatus(),
      ]);
      return { manager, engine: engineState, framebus };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { manager, engine: null, engineError: message };
    }
  }

  private async startInternal(
    options: MeetingHelperStartOptionsT,
  ): Promise<MeetingHelperManagerStatusT> {
    const logger = getLogger();
    const helperPath = resolveMeetingHelperPath();
    const modelsDir = resolveMeetingModelsDir(helperPath);
    if (!existsSync(helperPath)) {
      this.state = "error";
      this.lastError = `Meeting helper not found at ${helperPath}`;
      publishMeetingErrorEvent("helper_missing", this.lastError);
      return this.getStatus();
    }

    this.state = "starting";
    this.lastError = null;
    this.stdoutBuffer = "";

    try {
      const port = await findFreePort();
      const controlSocketPath = resolveControlSocketPath();
      this.port = port;

      const width = options.width ?? 1280;
      const height = options.height ?? 720;
      const fps = options.fps ?? 30;
      const args = [
        "--run",
        "--preview-port",
        String(port),
        "--control-socket",
        controlSocketPath,
        "--framebus-name",
        this.getFramebusName(),
        "--width",
        String(width),
        "--height",
        String(height),
        "--fps",
        String(fps),
        "--models-dir",
        modelsDir,
      ];

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MEETING_FRAMEBUS_NAME: this.getFramebusName(),
        MEETING_CONTROL_SOCKET: controlSocketPath,
        MEETING_PREVIEW_PORT: String(port),
        MEETING_FRAME_WIDTH: String(width),
        MEETING_FRAME_HEIGHT: String(height),
        MEETING_FRAME_FPS: String(fps),
        MEETING_MODELS_DIR: modelsDir,
        MEETING_VCAM_NATIVE_AVAILABLE: isVcamExtensionAvailable() ? "1" : "0",
      };

      logger.info(`[Meeting] Starting helper: ${helperPath} ${args.join(" ")}`);
      const child = spawn(helperPath, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.process = child;

      child.stdout?.on("data", (chunk: Buffer) => {
        this.handleStdoutChunk(chunk, logger);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        logger.debug?.(`[MeetingHelper] ${chunk.toString().trimEnd()}`);
      });
      child.on("exit", (code, signal) => {
        logger.info(
          `[Meeting] Helper exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        );
        this.handleProcessExit(code);
      });
      child.on("error", (error) => {
        this.lastError = error.message;
        this.state = "error";
        publishMeetingErrorEvent("spawn_failed", error.message);
        this.readyRejecter?.(error);
      });

      await this.waitForReady();
      const client = new MeetingHelperClient(controlSocketPath);
      const healthy = await client.ping();
      if (!healthy) {
        this.lastError = "Meeting helper did not respond to control.ping";
        this.state = "error";
        publishMeetingErrorEvent("helper_ping_failed", this.lastError);
        this.killProcess();
        return this.getStatus();
      }

      this.client = client;
      this.state = "running";
      this.startStatusPolling();
      await this.publishStatus("engine_started", true);
      return this.getStatus();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.state = "error";
      publishMeetingErrorEvent("start_failed", message);
      this.killProcess();
      return this.getStatus();
    }
  }

  private waitForReady(): Promise<ReadyEventT> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolver = null;
        this.readyRejecter = null;
        reject(new Error("Meeting helper did not emit ready in time"));
      }, START_TIMEOUT_MS);

      this.readyResolver = (event) => {
        clearTimeout(timeout);
        this.readyResolver = null;
        this.readyRejecter = null;
        resolve(event);
      };
      this.readyRejecter = (error) => {
        clearTimeout(timeout);
        this.readyResolver = null;
        this.readyRejecter = null;
        reject(error);
      };
    });
  }

  private handleStdoutChunk(chunk: Buffer, logger: LoggerT): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleStdoutLine(line, logger);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string, logger: LoggerT): void {
    logger.debug?.(`[MeetingHelper] ${line}`);
    try {
      const parsed = JSON.parse(line) as { type?: string; code?: string; message?: string };
      if (parsed.type === "meeting_graphics_framebus") {
        logger.info(`[MeetingHelper] ${line}`);
      }
      if (parsed.type === "ready") {
        this.readyResolver?.(parsed as ReadyEventT);
      }
      if (parsed.type === "error") {
        const code = parsed.code || "helper_error";
        const message = parsed.message || "Meeting helper reported an error";
        this.lastError = message;
        publishMeetingErrorEvent(code, message);
      }
    } catch {
      logger.debug?.(`[MeetingHelper] Ignored non-JSON stdout line: ${line}`);
    }
  }

  private startStatusPolling(): void {
    this.stopStatusPolling();
    this.statusPollTimer = setInterval(() => {
      void this.publishStatus("status_poll", false);
    }, STATUS_POLL_INTERVAL_MS);
  }

  private stopStatusPolling(): void {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  private async publishStatus(reason: string, force: boolean): Promise<void> {
    const status = await this.getFullStatus();
    const serialized = JSON.stringify(status);
    if (!force && serialized === this.lastPublishedStatus) {
      return;
    }
    this.lastPublishedStatus = serialized;
    publishMeetingStatusEvent(reason, status);
  }

  private handleProcessExit(code: number | null): void {
    this.stopStatusPolling();
    this.process = null;
    this.client = null;
    this.readyRejecter?.(new Error(`Meeting helper exited with code ${code}`));
    const wasRunning = this.state === "running";
    if (this.state !== "stopped") {
      this.state = code === 0 || code === null ? "stopped" : "error";
      if (this.state === "error") {
        this.lastError = `Meeting helper exited with code ${code}`;
      }
    }
    if (wasRunning) {
      void this.publishStatus("engine_exited", true);
    }
  }

  private killProcess(): void {
    if (!this.process) {
      return;
    }
    const child = this.process;
    this.process = null;
    try {
      child.kill("SIGTERM");
      const forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }, 3000);
      child.once("exit", () => clearTimeout(forceKillTimer));
    } catch {
      // Process already exited.
    }
  }
}

export const meetingHelperManager = new MeetingHelperManager();
