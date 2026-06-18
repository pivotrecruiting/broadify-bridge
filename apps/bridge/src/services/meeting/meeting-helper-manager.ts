import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MEETING_FRAMEBUS_NAME,
  DEFAULT_MEETING_VCAM_FRAME_PORT,
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
const MACOS_MEETING_HELPER_APP_NAME = "Broadify Bridge Meeting Helper.app";
const MACOS_MEETING_HELPER_EXECUTABLE_NAME = "BroadifyMeetingHelper";
const START_TIMEOUT_MS = 20000;
const STATUS_POLL_INTERVAL_MS = 2000;
const HELPER_PING_ATTEMPTS = 15;
const HELPER_PING_DELAY_MS = 100;
const MACOS_LAUNCH_SERVICES_HELPER_PING_ATTEMPTS = 80;
const CAMERA_PERMISSION_COMPLETION_POLL_ATTEMPTS = 120;
const CAMERA_PERMISSION_COMPLETION_POLL_DELAY_MS = 500;

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
  helper: MeetingHelperIdentityT;
  lastError: string | null;
};

export type MeetingHelperIdentityT = {
  path: string;
  appPath: string | null;
  bundleId: string | null;
  teamId: string | null;
  codeSignatureStatus: "not_checked" | "valid" | "invalid" | "missing";
  cameraEntitlementStatus: "not_checked" | "present" | "missing" | "invalid";
  tccIdentity: string | null;
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

function resolveMacosMeetingHelperExecutable(appPath: string): string {
  return join(appPath, "Contents", "MacOS", MACOS_MEETING_HELPER_EXECUTABLE_NAME);
}

function findMacosMeetingHelperAppPath(): string | null {
  const resourcesPath = process.resourcesPath;
  const moduleDir = getModuleDirname();
  const candidates = uniquePaths([
    ...(process.env.NODE_ENV === "production" && resourcesPath
      ? [join(resourcesPath, "native", "meeting-helper", MACOS_MEETING_HELPER_APP_NAME)]
      : []),
    join(process.cwd(), "apps/bridge/native/meeting-helper", MACOS_MEETING_HELPER_APP_NAME),
    join(process.cwd(), "native/meeting-helper", MACOS_MEETING_HELPER_APP_NAME),
    join(moduleDir, "../../../native/meeting-helper", MACOS_MEETING_HELPER_APP_NAME),
  ]);

  return candidates.find((candidate) => existsSync(resolveMacosMeetingHelperExecutable(candidate))) ?? null;
}

function readPlistValue(plistPath: string, key: string): string | null {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readCodesignTeamId(targetPath: string): string | null {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", targetPath], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
}

function inspectCodesignStatus(targetPath: string): MeetingHelperIdentityT["codeSignatureStatus"] {
  if (!existsSync(targetPath)) {
    return "missing";
  }
  if (platform() !== "darwin") {
    return "not_checked";
  }
  try {
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", targetPath], {
      stdio: "ignore",
    });
    return "valid";
  } catch {
    return "invalid";
  }
}

function inspectCameraEntitlementStatus(
  targetPath: string,
): MeetingHelperIdentityT["cameraEntitlementStatus"] {
  if (!existsSync(targetPath)) {
    return "missing";
  }
  if (platform() !== "darwin") {
    return "not_checked";
  }
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", targetPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "invalid";
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes("com.apple.security.device.camera") ? "present" : "missing";
}

function inspectMeetingHelperIdentity(helperPath: string): MeetingHelperIdentityT {
  if (platform() !== "darwin") {
    return {
      path: helperPath,
      appPath: null,
      bundleId: null,
      teamId: null,
      codeSignatureStatus: existsSync(helperPath) ? "not_checked" : "missing",
      cameraEntitlementStatus: existsSync(helperPath) ? "not_checked" : "missing",
      tccIdentity: null,
    };
  }

  const normalizedPath = resolve(helperPath);
  const marker = `${MACOS_MEETING_HELPER_APP_NAME}/Contents/MacOS/${MACOS_MEETING_HELPER_EXECUTABLE_NAME}`;
  const appPath = normalizedPath.endsWith(marker)
    ? normalizedPath.slice(0, -(`/Contents/MacOS/${MACOS_MEETING_HELPER_EXECUTABLE_NAME}`.length))
    : null;
  const infoPath = appPath ? join(appPath, "Contents", "Info.plist") : null;
  const bundleId = infoPath ? readPlistValue(infoPath, "CFBundleIdentifier") : null;

  return {
    path: helperPath,
    appPath,
    bundleId,
    teamId: readCodesignTeamId(helperPath),
    codeSignatureStatus: inspectCodesignStatus(helperPath),
    cameraEntitlementStatus: inspectCameraEntitlementStatus(helperPath),
    tccIdentity: bundleId ?? null,
  };
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

  if (platform() === "darwin") {
    const appPath = findMacosMeetingHelperAppPath();
    if (appPath) {
      return resolveMacosMeetingHelperExecutable(appPath);
    }
    if (process.env.NODE_ENV === "production" && resourcesPath) {
      return resolveMacosMeetingHelperExecutable(
        join(resourcesPath, "native", "meeting-helper", MACOS_MEETING_HELPER_APP_NAME),
      );
    }
  }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry control.ping because helper startup can briefly race with socket accept.
 */
async function waitForHelperPing(
  client: MeetingHelperClient,
  maxAttempts: number = HELPER_PING_ATTEMPTS,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await client.ping()) {
      return true;
    }
    if (attempt + 1 < maxAttempts) {
      await sleep(HELPER_PING_DELAY_MS);
    }
  }
  return false;
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
  private helperIdentity: MeetingHelperIdentityT | null = null;

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
      helper: this.helperIdentity ?? inspectMeetingHelperIdentity(resolveMeetingHelperPath()),
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
    const client = this.client;
    if (client) {
      try {
        await client.shutdown();
        await sleep(150);
      } catch {
        // Fall back to process termination below.
      }
    }
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
    this.helperIdentity = inspectMeetingHelperIdentity(helperPath);
    logger.info(
      `[Meeting] Helper identity: bundleId=${this.helperIdentity.bundleId ?? "none"} tccIdentity=${this.helperIdentity.tccIdentity ?? "none"} codeSignature=${this.helperIdentity.codeSignatureStatus} cameraEntitlement=${this.helperIdentity.cameraEntitlementStatus} teamId=${this.helperIdentity.teamId ?? "none"}`,
    );
    if (
      platform() === "darwin" &&
      this.helperIdentity.codeSignatureStatus !== "valid"
    ) {
      logger.warn(
        `[Meeting] Helper code signature is ${this.helperIdentity.codeSignatureStatus}; macOS camera permission prompts may be denied or hidden.`,
      );
      publishMeetingErrorEvent(
        "helper_codesign_invalid",
        "Meeting helper code signature is invalid; macOS camera permission cannot be requested reliably.",
      );
    }
    if (
      platform() === "darwin" &&
      this.helperIdentity.cameraEntitlementStatus !== "present"
    ) {
      logger.warn(
        `[Meeting] Helper camera entitlement is ${this.helperIdentity.cameraEntitlementStatus}; macOS may deny camera access without showing a permission prompt.`,
      );
      publishMeetingErrorEvent(
        "helper_camera_entitlement_missing",
        "Meeting helper is missing the macOS camera entitlement; camera permission cannot be requested reliably.",
      );
    }
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
        "--vcam-frame-port",
        String(DEFAULT_MEETING_VCAM_FRAME_PORT),
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
        MEETING_VCAM_FRAME_PORT: String(DEFAULT_MEETING_VCAM_FRAME_PORT),
        MEETING_CONTROL_SOCKET: controlSocketPath,
        MEETING_PREVIEW_PORT: String(port),
        MEETING_FRAME_WIDTH: String(width),
        MEETING_FRAME_HEIGHT: String(height),
        MEETING_FRAME_FPS: String(fps),
        MEETING_MODELS_DIR: modelsDir,
        MEETING_VCAM_NATIVE_AVAILABLE: isVcamExtensionAvailable() ? "1" : "0",
      };

      const useLaunchServices =
        platform() === "darwin" && this.helperIdentity.appPath !== null;
      const launchPath = useLaunchServices ? "/usr/bin/open" : helperPath;
      const launchArgs = useLaunchServices
        ? ["-W", "-n", this.helperIdentity.appPath as string, "--args", ...args]
        : args;

      logger.info(
        useLaunchServices
          ? `[Meeting] Opening helper app: ${this.helperIdentity.appPath} ${args.join(" ")}`
          : `[Meeting] Starting helper: ${helperPath} ${args.join(" ")}`,
      );
      const child = spawn(launchPath, launchArgs, {
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

      const client = new MeetingHelperClient(controlSocketPath);
      if (!useLaunchServices) {
        await this.waitForReady();
      }
      const healthy = await waitForHelperPing(
        client,
        useLaunchServices ? MACOS_LAUNCH_SERVICES_HELPER_PING_ATTEMPTS : HELPER_PING_ATTEMPTS,
      );
      if (!healthy) {
        this.lastError = "Meeting helper did not respond to control.ping";
        this.state = "error";
        publishMeetingErrorEvent("helper_ping_failed", this.lastError);
        logger.warn(
          `[Meeting] ${this.lastError} after ${HELPER_PING_ATTEMPTS} attempts`,
        );
        this.killProcess();
        return this.getStatus();
      }

      this.client = client;
      this.state = "running";
      this.startStatusPolling();
      this.requestCameraPermissionPreflight(client, logger);
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
      const parsed = JSON.parse(line) as {
        type?: string;
        code?: string;
        message?: string;
        camera_permission_status?: string;
      };
      if (parsed.type === "meeting_graphics_framebus") {
        logger.info(`[MeetingHelper] ${line}`);
      }
      if (parsed.type === "meeting_vcam_raw") {
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
      if (parsed.type === "camera_permission_completed") {
        const status = parsed.camera_permission_status || "unknown";
        logger.info(`[Meeting] Camera permission completion: ${status}`);
        publishMeetingStatusEvent("camera_permission_completed", {
          manager: this.getStatus(),
          engine: {
            camera_permission_status: status,
          },
        });
        if (status === "denied" || status === "restricted") {
          publishMeetingErrorEvent(
            "camera_permission_denied",
            "Camera permission was not granted.",
          );
        }
      }
    } catch {
      logger.debug?.(`[MeetingHelper] Ignored non-JSON stdout line: ${line}`);
    }
  }

  private requestCameraPermissionPreflight(
    client: MeetingHelperClient,
    logger: LoggerT,
  ): void {
    if (platform() !== "darwin") {
      return;
    }

    void client.requestCameraPermission()
      .then((result) => {
        const status =
          typeof result.camera_permission_status === "string"
            ? result.camera_permission_status
            : "unknown";
        logger.info(`[Meeting] Camera permission status: ${status}`);
        publishMeetingStatusEvent("camera_permission_preflight", {
          manager: this.getStatus(),
          engine: {
            camera_permission_status: status,
          },
        });
        if (status === "denied" || status === "restricted") {
          publishMeetingErrorEvent(
            "camera_permission_denied",
            "Camera permission was not granted.",
          );
        }
        if (status === "prompt_requested") {
          void this.pollCameraPermissionCompletion(client, logger);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[Meeting] Camera permission preflight failed: ${message}`);
      });
  }

  private async pollCameraPermissionCompletion(
    client: MeetingHelperClient,
    logger: LoggerT,
  ): Promise<void> {
    for (let attempt = 0; attempt < CAMERA_PERMISSION_COMPLETION_POLL_ATTEMPTS; attempt += 1) {
      await sleep(CAMERA_PERMISSION_COMPLETION_POLL_DELAY_MS);
      if (this.client !== client || this.state !== "running") {
        return;
      }
      try {
        const state = await client.getState();
        const status =
          typeof state.camera_permission_status === "string"
            ? state.camera_permission_status
            : "unknown";
        if (status === "prompt_requested" || status === "not_determined") {
          continue;
        }
        logger.info(`[Meeting] Camera permission completion: ${status}`);
        publishMeetingStatusEvent("camera_permission_completed", {
          manager: this.getStatus(),
          engine: {
            camera_permission_status: status,
          },
        });
        if (status === "denied" || status === "restricted") {
          publishMeetingErrorEvent(
            "camera_permission_denied",
            "Camera permission was not granted.",
          );
        }
        return;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[Meeting] Camera permission status poll failed: ${message}`);
        return;
      }
    }
    logger.warn("[Meeting] Camera permission prompt did not complete before timeout");
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
