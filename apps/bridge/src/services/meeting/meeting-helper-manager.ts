import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
import { streamDeckManager } from "../streamdeck/stream-deck-manager.js";
import {
  HELPER_NOT_REACHABLE_CODE,
  MeetingHelperClient,
  MeetingHelperRequestError,
} from "./meeting-helper-client.js";
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
// Consecutive connect-level RPC failures (helper_not_reachable) of the 2 s
// status poll before a still-running helper process is treated as crashed
// (its control channel is gone for good, e.g. the Windows pipe thread died).
const HELPER_CONTROL_CHANNEL_LOST_THRESHOLD = 5;
const MACOS_LAUNCH_SERVICES_HELPER_PING_ATTEMPTS = 80;
const CAMERA_PERMISSION_COMPLETION_POLL_ATTEMPTS = 120;
const CAMERA_PERMISSION_COMPLETION_POLL_DELAY_MS = 500;
const STALE_HELPER_PORT_RELEASE_TIMEOUT_MS = 1000;
// Bounded self-healing after a helper crash: without it, camera, keyer,
// virtual camera and program output stay dead while the bridge looks healthy.
const HELPER_RESTART_MAX_ATTEMPTS = 3;
const HELPER_RESTART_BASE_DELAY_MS = 1000;
// A helper that stayed up this long is considered healthy again; the attempt
// counter resets so one crash per day never exhausts the limit.
const HELPER_RESTART_HEALTHY_UPTIME_MS = 60_000;
const MEETING_HELPER_FORWARDED_ENV_KEYS = [
  "BROADIFY_MEETING_AUTO_DEGRADE",
  "BROADIFY_MEETING_COREML_UNITS",
  "BROADIFY_MEETING_EMPTY_SUBJECT",
  "BROADIFY_MEETING_FUSED_POSTPROCESS",
  "BROADIFY_MEETING_GPU_COMPOSITOR",
  "BROADIFY_MEETING_GPU_COMPOSITOR_D3D11",
  "BROADIFY_MEETING_GPU_EMA",
  "BROADIFY_MEETING_GPU_EPSILON",
  "BROADIFY_MEETING_GPU_GUIDED",
  "BROADIFY_MEETING_GPU_PIPELINE",
  "BROADIFY_MEETING_GPU_RADIUS",
  "BROADIFY_MEETING_GPU_REFINE",
  "BROADIFY_MEETING_GPU_REFINE_WIDTH",
  "BROADIFY_MEETING_GUIDED_EPSILON",
  "BROADIFY_MEETING_GUIDED_RADIUS",
  "BROADIFY_MEETING_GUIDED_REFINE",
  "BROADIFY_MEETING_KEYER_BACKEND",
  "BROADIFY_MEETING_KEYER_CADENCE",
  "BROADIFY_MEETING_KEYER_DML_LEGACY",
  "BROADIFY_MEETING_KEYER_MAX_INFERENCE_MS",
  "BROADIFY_MEETING_KEYER_OPENVINO",
  "BROADIFY_MEETING_KEYER_PERFORMANCE",
  "BROADIFY_MEETING_OPENVINO_DEVICE",
  "BROADIFY_MEETING_WARM_HANDOVER",
] as const;
const MEETING_HELPER_ENV_VALUE_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

type MeetingHelperLifecycleStateT =
  | "stopped"
  | "starting"
  | "running"
  | "error";

type MeetingHelperStartOptionsT = {
  width?: number;
  height?: number;
  fps?: number;
};

/** Camera RPCs replayed after a crash restart, in this order. */
const RESTORABLE_CAMERA_METHOD_ORDER = [
  "cameraOpenSet",
  "cameraStart",
  "cameraSelect",
  "cameraProgramSelect",
  "cameraPipSet",
  "cameraAutoDirector",
] as const;

export type RestorableCameraMethodT =
  (typeof RESTORABLE_CAMERA_METHOD_ORDER)[number];

type MeetingHelperManagerStatusT = {
  state: MeetingHelperLifecycleStateT;
  port: number | null;
  pid: number | null;
  framebusName: string;
  previewPath: string;
  virtualCamera: VcamHelperStatusT;
  helper: MeetingHelperIdentityT;
  lastError: string | null;
};

type EntitlementStatusT = "not_checked" | "present" | "missing" | "invalid";

type MeetingHelperIdentityT = {
  path: string;
  appPath: string | null;
  bundleId: string | null;
  teamId: string | null;
  codeSignatureStatus: "not_checked" | "valid" | "invalid" | "missing";
  cameraEntitlementStatus: EntitlementStatusT;
  microphoneEntitlementStatus: EntitlementStatusT;
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

export function resolveMeetingHelperForwardedEnvArgs(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [];
  for (const key of MEETING_HELPER_FORWARDED_ENV_KEYS) {
    const value = environment[key];
    if (
      typeof value === "string" &&
      MEETING_HELPER_ENV_VALUE_PATTERN.test(value)
    ) {
      args.push("--env", `${key}=${value}`);
    }
  }
  return args;
}

function meetingHelperArgsForLog(args: string[]): string {
  return args
    .map((value, index) => {
      if (index > 0 && args[index - 1] === "--env") {
        const separator = value.indexOf("=");
        const key = separator >= 0 ? value.slice(0, separator) : "invalid";
        return `${key}=<redacted>`;
      }
      return value;
    })
    .join(" ");
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

// Both device entitlements are read from a single codesign spawn: under
// hardened runtime a missing key means macOS denies the device silently, so
// the statuses feed startup warnings.
export function inspectDeviceEntitlementStatuses(targetPath: string): {
  camera: EntitlementStatusT;
  microphone: EntitlementStatusT;
} {
  if (!existsSync(targetPath)) {
    return { camera: "missing", microphone: "missing" };
  }
  if (platform() !== "darwin") {
    return { camera: "not_checked", microphone: "not_checked" };
  }
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", targetPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { camera: "invalid", microphone: "invalid" };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const statusOf = (key: string): EntitlementStatusT =>
    output.includes(key) ? "present" : "missing";
  return {
    camera: statusOf("com.apple.security.device.camera"),
    microphone: statusOf("com.apple.security.device.audio-input"),
  };
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
      microphoneEntitlementStatus: existsSync(helperPath) ? "not_checked" : "missing",
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

  const deviceEntitlements = inspectDeviceEntitlementStatuses(helperPath);
  return {
    path: helperPath,
    appPath,
    bundleId,
    teamId: readCodesignTeamId(helperPath),
    codeSignatureStatus: inspectCodesignStatus(helperPath),
    cameraEntitlementStatus: deviceEntitlements.camera,
    microphoneEntitlementStatus: deviceEntitlements.microphone,
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
  const bundleMarker = ".app/Contents/MacOS/";
  const bundleIndex = helperPath.indexOf(bundleMarker);
  if (bundleIndex !== -1) {
    const bundlePath = helperPath.slice(0, bundleIndex) + ".app";
    return join(dirname(bundlePath), "models");
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

function listTcpListenPids(port: number): number[] {
  if (platform() !== "darwin") {
    return [];
  }
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return output
      .split(/\s+/)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function isMeetingHelperProcess(pid: number): boolean {
  if (platform() !== "darwin") {
    return false;
  }
  try {
    const output = execFileSync("lsof", ["-p", String(pid), "-a", "-d", "txt"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      output.includes(MACOS_MEETING_HELPER_APP_NAME) ||
      output.includes(MACOS_MEETING_HELPER_EXECUTABLE_NAME)
    );
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Release stale native meeting helpers that still own the fixed VCam raw port.
 */
export async function releaseStaleMeetingHelperVcamPort(
  port: number,
  logger: LoggerT = getLogger(),
): Promise<void> {
  const pids = listTcpListenPids(port).filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    if (!isMeetingHelperProcess(pid)) {
      logger.warn(
        `[Meeting] VCam raw port ${port} is owned by non-meeting-helper pid=${pid}; leaving it untouched.`,
      );
      continue;
    }

    logger.warn(
      `[Meeting] Terminating stale meeting helper pid=${pid} on VCam raw port ${port}`,
    );
    try {
      process.kill(pid, "SIGTERM");
      const exited = await waitForProcessExit(pid, STALE_HELPER_PORT_RELEASE_TIMEOUT_MS);
      if (!exited) {
        logger.warn(
          `[Meeting] Stale meeting helper pid=${pid} did not exit after SIGTERM; sending SIGKILL.`,
        );
        process.kill(pid, "SIGKILL");
        await waitForProcessExit(pid, STALE_HELPER_PORT_RELEASE_TIMEOUT_MS);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[Meeting] Could not terminate stale meeting helper pid=${pid}: ${message}`,
      );
    }
  }
}

/**
 * Retry control.ping because helper startup can briefly race with socket accept.
 */
async function waitForHelperPing(
  client: MeetingHelperClient,
  maxAttempts: number = HELPER_PING_ATTEMPTS,
  logger: LoggerT = getLogger(),
): Promise<boolean> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (await client.pingOrThrow()) {
        return true;
      }
      lastError = "control.ping returned no pong";
    } catch (error: unknown) {
      // Keep the last failure: a bare helper_ping_failed was undiagnosable
      // (ENOENT on the pipe vs. a helper that never answered look identical).
      lastError =
        error instanceof MeetingHelperRequestError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    }
    if (attempt + 1 < maxAttempts) {
      await sleep(HELPER_PING_DELAY_MS);
    }
  }
  logger.debug?.(
    `[Meeting] control.ping failed ${maxAttempts} times; last error: ${lastError ?? "unknown"}`,
  );
  return false;
}

/**
 * Sidecar file the helper mirrors its JSON events into. On macOS the helper
 * is launched through /usr/bin/open, which swallows stdio - this file is the
 * only surviving channel, and its tail is dumped into the bridge log when the
 * helper dies (see handleProcessExit).
 */
function resolveHelperEventLogPath(): string {
  try {
    return join(getBridgeContext().userDataDir, "meeting-helper-events.log");
  } catch {
    return join(tmpdir(), "broadify-meeting-helper-events.log");
  }
}

function readHelperEventLogTail(maxBytes = 4096): string | null {
  try {
    const path = resolveHelperEventLogPath();
    const content = readFileSync(path, "utf8");
    const tail = content.length > maxBytes ? content.slice(-maxBytes) : content;
    const trimmed = tail.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
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
  private lastRuntimeBackendStatus: string | null = null;
  private lastStartOptions: MeetingHelperStartOptionsT = {};
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private consecutiveControlFailures = 0;
  private lastRunningSince: number | null = null;
  private stopping = false;
  // Set once the bridge itself is shutting down. The helper usually dies from
  // the process-group SIGTERM BEFORE server.ts reaches stop() (which sets
  // `stopping`), so without this flag that exit is misclassified as a crash
  // and a restart timer is armed mid-shutdown.
  private shutdownRequested = false;
  // Last successful camera calls and merged keyer patches, replayed after a
  // crash restart so the program does not come back without its camera. The
  // webapp's full push restores program sections, but nothing else re-opens
  // the camera devices.
  private readonly restorableCameraCalls = new Map<
    RestorableCameraMethodT,
    Record<string, unknown>
  >();
  private keyerRestoreConfig: Record<string, unknown> | null = null;

  getClient(): MeetingHelperClient | null {
    return this.client;
  }

  /** Record a successful camera call for replay after a crash restart. */
  noteCameraCall(
    method: RestorableCameraMethodT,
    options: Record<string, unknown>,
  ): void {
    this.restorableCameraCalls.set(method, options);
  }

  noteCameraStopped(): void {
    this.restorableCameraCalls.clear();
  }

  /** Merge a successful keyer patch into the replayable keyer config. */
  noteKeyerConfigured(patch: Record<string, unknown>): void {
    this.keyerRestoreConfig = { ...(this.keyerRestoreConfig ?? {}), ...patch };
  }

  /**
   * Replay the last known camera/keyer configuration into a freshly
   * restarted helper. Best effort: a failed replay is logged, not fatal -
   * the operator can still fix it manually, which without this would be the
   * only option.
   */
  private async restoreRuntimeConfig(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    for (const method of RESTORABLE_CAMERA_METHOD_ORDER) {
      const options = this.restorableCameraCalls.get(method);
      if (!options) {
        continue;
      }
      try {
        await client[method](options);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        getLogger().warn(
          `[Meeting] Restore of ${method} after helper restart failed: ${message}`,
        );
      }
    }
    if (this.keyerRestoreConfig) {
      try {
        await client.keyerConfigure(this.keyerRestoreConfig);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        getLogger().warn(
          `[Meeting] Restore of keyer config after helper restart failed: ${message}`,
        );
      }
    }
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
    // A user-initiated start supersedes any crash-recovery in flight.
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.lastStartOptions = options;
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

  /**
   * Mark the whole bridge as shutting down. Must be called FIRST in the
   * server shutdown path: from here on a helper exit is never treated as a
   * crash and no restart is scheduled.
   */
  beginShutdown(): void {
    this.shutdownRequested = true;
    this.clearRestartTimer();
  }

  async stop(): Promise<MeetingHelperManagerStatusT> {
    // Intentional stop: no crash-recovery restart for the resulting exit,
    // and nothing to replay for the next session.
    this.stopping = true;
    this.clearRestartTimer();
    this.restartAttempts = 0;
    this.restorableCameraCalls.clear();
    this.keyerRestoreConfig = null;
    this.stopStatusPolling();
    const client = this.client;
    if (client) {
      // Finalize an in-flight recording before shutting the helper down: a
      // killed writer leaves an MP4 without its moov atom, i.e. an unplayable
      // file. recording.stop is a fast no-op when nothing is recording.
      try {
        await client.recordingStop();
      } catch {
        // Best effort - the helper-side shutdown handler finalizes too.
      }
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
    this.lastRuntimeBackendStatus = null;
    this.stopping = false;
    await this.publishStatus("engine_stopped", true);
    return this.getStatus();
  }

  async getFullStatus(): Promise<Record<string, unknown>> {
    const manager = this.getStatus();
    if (!this.client || this.state !== "running") {
      return { manager, engine: null, recording: null };
    }
    try {
      const [engineState, framebus, keyer, recordingResult, virtualCamera] =
        await Promise.all([
          this.client.getState(),
          this.client.framebusStatus(),
          this.client.keyerGet(),
          // Best effort: a failing recording.status must not take down the whole
          // snapshot (and older helpers may not implement the RPC).
          this.client.recordingStatus().catch(() => null),
          // Windows: output.vcam.status (active/supported/last_error);
          // macOS: system-extension status. Best effort like recording.
          this.client.virtualCameraStatus().catch(() => null),
        ]);
      const recordingRaw = recordingResult?.recording;
      const recording =
        recordingRaw && typeof recordingRaw === "object" ? recordingRaw : null;
      this.consecutiveControlFailures = 0;
      return {
        manager,
        engine: engineState,
        framebus,
        keyer,
        recording,
        virtualCamera,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error instanceof MeetingHelperRequestError &&
        error.code === HELPER_NOT_REACHABLE_CODE
      ) {
        this.noteControlChannelFailure(message);
      }
      return { manager, engine: null, engineError: message, recording: null };
    }
  }

  /**
   * Liveness for a helper whose PROCESS is alive but whose control channel is
   * gone (Windows: the pipe thread died after a CreateNamedPipe failure, so
   * every RPC is ENOENT forever while the exit-bound restart logic never
   * fires). Carried by the existing 2 s status poll: after
   * HELPER_CONTROL_CHANNEL_LOST_THRESHOLD consecutive connect-level failures
   * the process is killed, and the regular exit handler runs the bounded
   * crash restart. Any successful snapshot resets the counter.
   */
  private noteControlChannelFailure(detail: string): void {
    if (this.state !== "running" || !this.process) {
      return;
    }
    this.consecutiveControlFailures += 1;
    if (this.consecutiveControlFailures < HELPER_CONTROL_CHANNEL_LOST_THRESHOLD) {
      return;
    }
    this.consecutiveControlFailures = 0;
    const pid = this.process.pid ?? "unknown";
    const message = `Meeting helper control channel lost (${HELPER_CONTROL_CHANNEL_LOST_THRESHOLD} consecutive failures, pid ${pid}): ${detail}`;
    this.lastError = message;
    getLogger().warn(`[Meeting] ${message}; killing helper for restart`);
    publishMeetingErrorEvent("helper_control_channel_lost", message);
    // Stop polling now: the kill takes up to 3 s and the exit handler must
    // be the one to classify the crash and schedule the restart.
    this.stopStatusPolling();
    this.killProcess();
  }

  private async startInternal(
    options: MeetingHelperStartOptionsT,
  ): Promise<MeetingHelperManagerStatusT> {
    const logger = getLogger();
    const helperPath = resolveMeetingHelperPath();
    if (!existsSync(helperPath)) {
      this.helperIdentity = inspectMeetingHelperIdentity(helperPath);
      this.state = "error";
      this.lastError = "Meeting helper is not installed.";
      logger.debug?.(`[Meeting] Helper not found at ${helperPath}`);
      publishMeetingErrorEvent("helper_missing", this.lastError);
      return this.getStatus();
    }
    this.helperIdentity = inspectMeetingHelperIdentity(helperPath);
    logger.info(
      `[Meeting] Helper identity: bundleId=${this.helperIdentity.bundleId ?? "none"} tccIdentity=${this.helperIdentity.tccIdentity ?? "none"} codeSignature=${this.helperIdentity.codeSignatureStatus} cameraEntitlement=${this.helperIdentity.cameraEntitlementStatus} microphoneEntitlement=${this.helperIdentity.microphoneEntitlementStatus} teamId=${this.helperIdentity.teamId ?? "none"}`,
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
    const warnOnMissingEntitlement = (
      device: "camera" | "microphone",
      status: EntitlementStatusT,
    ): void => {
      if (platform() !== "darwin" || status === "present") {
        return;
      }
      logger.warn(
        `[Meeting] Helper ${device} entitlement is ${status}; macOS may deny ${device} access without showing a permission prompt.`,
      );
      publishMeetingErrorEvent(
        `helper_${device}_entitlement_missing`,
        `Meeting helper is missing the macOS ${device} entitlement; ${device} permission cannot be requested reliably.`,
      );
    };
    warnOnMissingEntitlement("camera", this.helperIdentity.cameraEntitlementStatus);
    warnOnMissingEntitlement(
      "microphone",
      this.helperIdentity.microphoneEntitlementStatus,
    );
    const modelsDir = resolveMeetingModelsDir(helperPath);
    const requiredModelPath =
      platform() === "darwin"
        ? join(modelsDir, "MODNet.mlpackage")
        : platform() === "win32"
          ? join(modelsDir, "modnet.onnx")
          : null;
    if (requiredModelPath !== null && !existsSync(requiredModelPath)) {
      this.state = "error";
      this.lastError = `Meeting keyer model not found at ${requiredModelPath}`;
      publishMeetingErrorEvent("keyer_model_missing", this.lastError);
      logger.error(`[Meeting] ${this.lastError}`);
      return this.getStatus();
    }
    logger.info(
      `[Meeting] Models directory resolved: ${modelsDir}${requiredModelPath ? ` model=${requiredModelPath}` : ""}`,
    );

    this.state = "starting";
    this.lastError = null;
    this.stdoutBuffer = "";

    try {
      const port = await findFreePort();
      const controlSocketPath = resolveControlSocketPath();
      this.port = port;

      const width = options.width ?? 1920;
      const height = options.height ?? 1080;
      const fps = options.fps ?? 30;
      const args = [
        "--run",
        "--parent-pid",
        String(process.pid),
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
        "--event-log",
        resolveHelperEventLogPath(),
        ...resolveMeetingHelperForwardedEnvArgs(),
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
        MEETING_EVENT_LOG: resolveHelperEventLogPath(),
        MEETING_VCAM_NATIVE_AVAILABLE: isVcamExtensionAvailable() ? "1" : "0",
      };

      await releaseStaleMeetingHelperVcamPort(DEFAULT_MEETING_VCAM_FRAME_PORT, logger);

      const useLaunchServices =
        platform() === "darwin" && this.helperIdentity.appPath !== null;
      const launchPath = useLaunchServices ? "/usr/bin/open" : helperPath;
      const launchArgs = useLaunchServices
        ? ["-W", "-n", this.helperIdentity.appPath as string, "--args", ...args]
        : args;

      logger.info(
        useLaunchServices
          ? `[Meeting] Opening helper app: ${this.helperIdentity.appPath} ${meetingHelperArgsForLog(args)}`
          : `[Meeting] Starting helper: ${helperPath} ${meetingHelperArgsForLog(args)}`,
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
        // warn, not debug: stderr is where the C++ helper prints crashes and
        // assertion failures - at debug level they were invisible in
        // production logs (WP-2.7).
        logger.warn(`[MeetingHelper] ${chunk.toString().trimEnd()}`);
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
        logger,
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
      this.lastRunningSince = Date.now();
      this.consecutiveControlFailures = 0;
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
      if (parsed.type === "meeting_gpu_compositor") {
        logger.info(`[MeetingHelper] ${line}`);
      }
      if (parsed.type === "meeting_keyer_pipeline") {
        logger.info(`[MeetingHelper] ${line}`);
      }
      if (parsed.type === "meeting_recorder") {
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

  /**
   * Re-publishes the full status after a recording start/stop so every
   * consumer (webapp push, resync snapshot, deck REC mirror) sees the same
   * authoritative snapshot (audit SD-04/WP-2.4).
   */
  notifyRecordingChanged(): void {
    void this.publishStatus("recording_changed", true);
  }

  private async publishStatus(reason: string, force: boolean): Promise<void> {
    const status = await this.getFullStatus();
    // Single writer for the deck's REC mirror: derived from the same snapshot
    // every other consumer sees, so the key can no longer diverge from the
    // real recorder state (idempotent - only re-renders on change).
    const recording = status.recording;
    streamDeckManager.setRecordingActive(
      !!recording &&
        typeof recording === "object" &&
        (recording as Record<string, unknown>).active === true,
    );
    const keyer = status.keyer;
    if (keyer && typeof keyer === "object") {
      const runtimeStatus = (keyer as Record<string, unknown>).status;
      if (runtimeStatus && typeof runtimeStatus === "object") {
        const value = runtimeStatus as Record<string, unknown>;
        const backendStatus = JSON.stringify({
          active_keyer: value.active_keyer ?? null,
          provider: value.provider ?? null,
          fallback_active: value.fallback_active ?? null,
          fallback_reason: value.fallback_reason ?? null,
          keyer_pipeline_mode: value.keyer_pipeline_mode ?? null,
          compositor: value.compositor ?? null,
          model_hash_ok: value.model_hash_ok ?? null,
          model_path: value.model_path ?? null,
        });
        if (backendStatus !== this.lastRuntimeBackendStatus) {
          getLogger().info(`[Meeting] Runtime keyer status ${backendStatus}`);
          this.lastRuntimeBackendStatus = backendStatus;
        }
      }
    }
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
    this.consecutiveControlFailures = 0;
    this.lastRuntimeBackendStatus = null;
    this.readyRejecter?.(new Error(`Meeting helper exited with code ${code}`));
    const wasRunning = this.state === "running";
    // Any exit we did not initiate ourselves is a crash - the helper never
    // quits on its own. The exit code is useless for this decision: on macOS
    // the child is the LaunchServices `open` wrapper, which reports code 0
    // even when the helper behind it was SIGKILLed.
    const crashed = wasRunning && !this.stopping && !this.shutdownRequested;
    if (this.state !== "stopped") {
      if (crashed) {
        this.state = "error";
        this.lastError = `Meeting helper exited unexpectedly (code ${code})`;
      } else {
        this.state = code === 0 || code === null ? "stopped" : "error";
        if (this.state === "error") {
          this.lastError = `Meeting helper exited with code ${code}`;
        }
      }
    }
    if (wasRunning) {
      // The recorder died with the helper; publishStatus derives the deck's
      // REC mirror from the (now empty) snapshot and resets it.
      void this.publishStatus("engine_exited", true);
    }
    if (crashed) {
      // The exit code above comes from the `open` wrapper on macOS and is
      // meaningless; the helper's own event log names what actually happened.
      const eventTail = readHelperEventLogTail();
      getLogger().warn(
        `[Meeting] Helper event log tail: ${eventTail ?? "(no events recorded - hard kill or crash before any event)"}`,
      );
    }
    if (crashed) {
      // Uptime above the threshold means the previous restarts worked out;
      // start counting from zero for this new, unrelated crash.
      const uptimeMs =
        this.lastRunningSince !== null ? Date.now() - this.lastRunningSince : 0;
      if (uptimeMs >= HELPER_RESTART_HEALTHY_UPTIME_MS) {
        this.restartAttempts = 0;
      }
      this.scheduleRestart();
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /**
   * Bounded crash recovery: up to HELPER_RESTART_MAX_ATTEMPTS respawns with
   * exponential backoff. The webapp observes the resulting engine_restarted
   * status event and re-pushes its program/keyer configuration (its full push
   * fires on the engine-running transition). A user-initiated start() or
   * stop() cancels any pending attempt.
   */
  private scheduleRestart(): void {
    if (this.restartTimer || this.shutdownRequested) {
      return;
    }
    if (this.restartAttempts >= HELPER_RESTART_MAX_ATTEMPTS) {
      const message = `Meeting helper crashed and did not recover after ${HELPER_RESTART_MAX_ATTEMPTS} restart attempts.`;
      this.lastError = message;
      getLogger().error(`[Meeting] ${message}`);
      publishMeetingErrorEvent("helper_restart_exhausted", message);
      return;
    }
    this.restartAttempts += 1;
    const delayMs =
      HELPER_RESTART_BASE_DELAY_MS * 2 ** (this.restartAttempts - 1);
    getLogger().warn(
      `[Meeting] Helper crashed; restart attempt ${this.restartAttempts}/${HELPER_RESTART_MAX_ATTEMPTS} in ${delayMs}ms`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (
        this.state !== "error" ||
        this.startPromise ||
        this.stopping ||
        this.shutdownRequested
      ) {
        return;
      }
      this.startPromise = this.startInternal(this.lastStartOptions)
        .then(async (status) => {
          if (status.state === "running") {
            getLogger().info(
              `[Meeting] Helper restarted after crash (attempt ${this.restartAttempts})`,
            );
            await this.restoreRuntimeConfig();
            await this.publishStatus("engine_restarted", true);
          } else {
            this.scheduleRestart();
          }
          return status;
        })
        .finally(() => {
          this.startPromise = null;
        });
      void this.startPromise.catch(() => {
        this.scheduleRestart();
      });
    }, delayMs);
    this.restartTimer.unref?.();
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
