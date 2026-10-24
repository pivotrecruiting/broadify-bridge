import { existsSync, readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { PgmStatusT, VideoInputDescriptorT } from "@broadify/protocol";

import { getBridgeContext } from "../bridge-context.js";
import {
  DEFAULT_HELPER_RESTART_POLICY,
  createHelperRestartState,
  decideHelperRestart,
  noteHelperCrash,
  type HelperRestartStateT,
} from "../helpers/helper-restart-policy.js";
import {
  inspectHelperIdentity,
  launchHelper,
  resolveControlSocketPath,
  resolveHelperEventLogPath,
  resolveHelperPath,
  waitForHelperPing,
  type HelperSpecT,
} from "../helpers/helper-launch.js";
import { parsePgmEnv } from "./pgm-env.js";
import { PgmError } from "./pgm-errors.js";
import { publishPgmErrorEvent, publishPgmStatusEvent } from "./pgm-event-publisher.js";
import { PgmHelperClient, PgmHelperRequestError } from "./pgm-helper-client.js";
import { PgmSessionManager } from "./pgm-session-manager.js";
import { PgmSourceStore, type PgmSourceFileT } from "./pgm-source-store.js";
import type { PgmWebrtcOfferT } from "./pgm-command-schemas.js";

export const PGM_HELPER_SPEC: HelperSpecT = {
  dirName: "pgm-helper",
  binaryName: "pgm-helper",
  pathEnv: "BRIDGE_PGM_HELPER_PATH",
  macosAppName: "Broadify Bridge PGM Helper.app",
  macosExecutableName: "BroadifyPgmHelper",
  socketPrefix: "pgm",
};

const PING_ATTEMPTS = 40;
const PING_DELAY_MS = 250;
const STATUS_PUBLISH_MIN_INTERVAL_MS = 250;

export type PgmHelperLifecycleStateT = "stopped" | "starting" | "running" | "error";

type LoggerT = { debug?: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

const getLogger = (): LoggerT => {
  try {
    return getBridgeContext().logger;
  } catch {
    return { info: console.info, warn: console.warn, error: console.error };
  }
};

export function idlePgmStatus(enabled: boolean, lastError: { code: string; message: string } | null = null): PgmStatusT {
  return { enabled, state: lastError ? "error" : "idle", input: null, signal: null, encoder: null, audio: false, viewers: 0, last_error: lastError };
}

/** A helper stdout/event-log line; the status projection the manager keeps. */
export function applyHelperEvent(current: PgmStatusT, line: string): { status: PgmStatusT; kind: string } | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "pgm_status" && event.status && typeof event.status === "object") {
    return { status: { ...(event.status as PgmStatusT), enabled: current.enabled }, kind: type };
  }
  if (type === "pgm_signal" && event.signal && typeof event.signal === "object") {
    return { status: { ...current, signal: event.signal as PgmStatusT["signal"] }, kind: type };
  }
  if (type === "pgm_error" && typeof event.code === "string") {
    return { status: { ...current, state: "error", last_error: { code: event.code, message: String(event.message ?? "") } }, kind: type };
  }
  return { status: current, kind: type };
}

export type PgmHelperManagerDepsT = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  userDataDir: () => string;
  createClient: (socketPath: string) => PgmHelperClient;
};

const defaultDeps: PgmHelperManagerDepsT = {
  env: process.env,
  platform: process.platform,
  userDataDir: () => getBridgeContext().userDataDir,
  createClient: (socketPath) => new PgmHelperClient(socketPath),
};

/**
 * Lifecycle of the native PGM helper: started on demand (first source
 * selection or viewer), kept alive while a source is selected, restarted after
 * a crash with the shared backoff policy (source re-selected), stopped with
 * the bridge. Status comes from helper events (stdout on Windows, event log
 * tail on macOS where Launch Services swallows stdio) and from `pgm.status`.
 */
export class PgmHelperManager {
  private state: PgmHelperLifecycleStateT = "stopped";
  private process: ChildProcess | null = null;
  private client: PgmHelperClient | null = null;
  private status: PgmStatusT;
  private stdoutBuffer = "";
  private restart: HelperRestartStateT = createHelperRestartState();
  private restartTimer: NodeJS.Timeout | null = null;
  private runningSince: number | null = null;
  private startPromise: Promise<void> | null = null;
  private shutdownRequested = false;
  private lastPublishAt = 0;
  private publishTimer: NodeJS.Timeout | null = null;
  private eventLogOffset = 0;
  private eventLogTimer: NodeJS.Timeout | null = null;
  private readonly sessions: PgmSessionManager;
  private readonly store: PgmSourceStore | null;
  private source: PgmSourceFileT;

  constructor(private readonly deps: PgmHelperManagerDepsT = defaultDeps) {
    const env = parsePgmEnv(deps.env);
    this.status = idlePgmStatus(env.enabled);
    this.sessions = new PgmSessionManager(env.maxViewers);
    let store: PgmSourceStore | null = null;
    try {
      store = new PgmSourceStore(deps.userDataDir());
    } catch {
      store = null;
    }
    this.store = store;
    this.source = store ? store.load() : { version: 1, input: null, profile: "auto" };
  }

  getStatus(): PgmStatusT {
    return { ...this.status, viewers: this.sessions.count() };
  }

  getSessions(): { sessions: Array<{ session_id: string; viewer_user_id: string; label: string | null; created_at: number }>; max_viewers: number; active_viewers: number } {
    return {
      sessions: this.sessions.list().map((s) => ({ session_id: s.sessionId, viewer_user_id: s.viewerUserId, label: s.label, created_at: s.createdAt })),
      max_viewers: parsePgmEnv(this.deps.env).maxViewers,
      active_viewers: this.sessions.count(),
    };
  }

  isRunning(): boolean {
    return this.state === "running" && this.client !== null;
  }

  async listInputs(): Promise<{ inputs: VideoInputDescriptorT[]; camera_permission: string }> {
    const client = await this.ensureRunning();
    return client.inputsList();
  }

  async selectSource(inputId: string, profile: "auto" | "lan" | "remote"): Promise<PgmStatusT> {
    const client = await this.ensureRunning();
    const status = await client.sourceSelect(inputId, profile).catch((error) => this.rethrow(error));
    this.source = {
      version: 1,
      input: status.input ? { kind: status.input.kind, stable_key: status.input.stable_key, display_name: status.input.display_name } : null,
      profile,
    };
    await this.store?.save(this.source).catch(() => undefined);
    this.setStatus(status, "source_selected", true);
    return this.getStatus();
  }

  async clearSource(): Promise<PgmStatusT> {
    this.source = { version: 1, input: null, profile: this.source.profile };
    await this.store?.save(this.source).catch(() => undefined);
    if (this.client) {
      const status = await this.client.sourceClear().catch((error) => this.rethrow(error));
      this.setStatus(status, "source_cleared", true);
    }
    this.sessions.clear();
    // Nothing to serve: stop the helper, it is started again on demand.
    await this.stop();
    return this.getStatus();
  }

  async offer(payload: PgmWebrtcOfferT): Promise<{ sdp: string; max_viewers: number; active_viewers: number }> {
    const env = parsePgmEnv(this.deps.env);
    if (!this.source.input) {
      throw new PgmError("pgm_no_signal", "No program source is selected on this bridge.");
    }
    if (!this.sessions.reserve(payload.session_id, payload.viewer_user_id, payload.label ?? null)) {
      throw new PgmError("pgm_viewer_limit", `Viewer limit reached (${env.maxViewers}).`, { max_viewers: env.maxViewers, active_viewers: this.sessions.count() });
    }
    try {
      const client = await this.ensureRunning();
      const { sdp } = await client.viewerOffer(payload, this.source.profile);
      this.requestStatusPublish("viewer_added");
      return { sdp, max_viewers: env.maxViewers, active_viewers: this.sessions.count() };
    } catch (error: unknown) {
      this.sessions.release(payload.session_id);
      this.rethrow(error);
    }
  }

  async close(sessionId: string, viewerUserId: string): Promise<void> {
    if (!this.sessions.owned(sessionId, viewerUserId)) {
      throw new PgmError("pgm_session_not_found", "No live program session with this id for this viewer.");
    }
    this.sessions.release(sessionId);
    if (this.client) {
      await this.client.viewerClose(sessionId).catch(() => undefined);
    }
    this.requestStatusPublish("viewer_closed");
  }

  /** Restores a persisted source on bridge start (helper starts lazily). */
  async restoreOnBoot(): Promise<void> {
    if (!parsePgmEnv(this.deps.env).enabled || !this.source.input) {
      return;
    }
    try {
      await this.selectSource(`${this.source.input.kind}:${this.source.input.stable_key}`, this.source.profile);
    } catch (error: unknown) {
      getLogger().warn(`[PGM] Restoring the program source failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
    this.stopEventLogTail();
    const client = this.client;
    this.client = null;
    if (client) {
      await client.shutdown().catch(() => undefined);
    }
    this.killProcess();
    this.state = "stopped";
    this.runningSince = null;
    this.setStatus(idlePgmStatus(parsePgmEnv(this.deps.env).enabled), "stopped", true);
  }

  beginShutdown(): void {
    this.shutdownRequested = true;
    this.clearRestartTimer();
  }

  private rethrow(error: unknown): never {
    if (error instanceof PgmHelperRequestError) {
      throw new PgmError(isKnownPgmCode(error.code) ? error.code : "helper_not_reachable", error.message);
    }
    throw error;
  }

  private async ensureRunning(): Promise<PgmHelperClient> {
    if (!parsePgmEnv(this.deps.env).enabled) {
      throw new PgmError("pgm_disabled", "Live program preview is disabled on this bridge.");
    }
    if (this.client && this.state === "running") {
      return this.client;
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
    if (!this.client) {
      throw new PgmError("helper_not_reachable", this.status.last_error?.message ?? "PGM helper did not start.");
    }
    return this.client;
  }

  private async startInternal(): Promise<void> {
    const logger = getLogger();
    const helperPath = resolveHelperPath(PGM_HELPER_SPEC);
    if (!existsSync(helperPath)) {
      this.state = "error";
      const message = `PGM helper is not installed (${helperPath}).`;
      this.setStatus(idlePgmStatus(true, { code: "helper_not_reachable", message }), "helper_missing", true);
      publishPgmErrorEvent("helper_missing", message);
      return;
    }
    const identity = inspectHelperIdentity(PGM_HELPER_SPEC, helperPath);
    if (this.deps.platform === "darwin" && identity.codeSignatureStatus !== "valid") {
      logger.warn(`[PGM] Helper code signature is ${identity.codeSignatureStatus}; the camera permission prompt may be hidden.`);
    }
    this.state = "starting";
    this.stdoutBuffer = "";
    const controlSocketPath = resolveControlSocketPath(PGM_HELPER_SPEC);
    const eventLogPath = resolveHelperEventLogPath(PGM_HELPER_SPEC);
    const args = ["--run", "--parent-pid", String(process.pid), "--control-socket", controlSocketPath, "--event-log", eventLogPath];
    if (this.deps.env.BRIDGE_PGM_SYNTHETIC_SOURCE) {
      args.push("--synthetic-source", this.deps.env.BRIDGE_PGM_SYNTHETIC_SOURCE);
    }
    if (this.deps.env.BRIDGE_LOG_PERF === "1") {
      args.push("--log-perf");
    }
    logger.info(`[PGM] Starting helper: ${identity.appPath ?? helperPath} ${args.join(" ")}`);
    const launched = launchHelper(identity, args, { ...this.deps.env, PGM_CONTROL_SOCKET: controlSocketPath });
    this.process = launched.child;
    launched.child.stdout?.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    launched.child.stderr?.on("data", (chunk: Buffer) => logger.warn(`[PgmHelper] ${chunk.toString().trimEnd()}`));
    launched.child.on("exit", (code, signal) => {
      logger.info(`[PGM] Helper exited (code ${code ?? "null"}, signal ${signal ?? "null"})`);
      this.handleProcessExit();
    });
    launched.child.on("error", (error) => {
      this.state = "error";
      publishPgmErrorEvent("spawn_failed", error.message);
    });
    if (launched.viaLaunchServices) {
      this.startEventLogTail(eventLogPath);
    }
    const client = this.deps.createClient(controlSocketPath);
    const ping = await waitForHelperPing(() => client.ping(), PING_ATTEMPTS, PING_DELAY_MS);
    if (!ping.healthy) {
      const message = `PGM helper did not respond to control.ping: ${ping.lastError ?? "unknown"}`;
      this.state = "error";
      this.killProcess();
      this.setStatus(idlePgmStatus(true, { code: "helper_not_reachable", message }), "helper_ping_failed", true);
      publishPgmErrorEvent("helper_ping_failed", message);
      return;
    }
    this.client = client;
    this.state = "running";
    this.runningSince = Date.now();
    const status = await client.status().catch(() => null);
    if (status) {
      this.setStatus(status, "helper_started", true);
    }
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let index = this.stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) {
        this.handleHelperLine(line);
      }
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleHelperLine(line: string): void {
    const applied = applyHelperEvent(this.status, line);
    if (!applied) {
      return;
    }
    if (applied.kind === "pgm_status" || applied.kind === "pgm_signal" || applied.kind === "pgm_error") {
      this.setStatus(applied.status, applied.kind, false);
    } else if (applied.kind === "pgm_inputs_changed") {
      const publish = getBridgeContext().publishBridgeEvent;
      publish?.({ event: "pgm_inputs_changed", data: { at: Date.now() } });
    } else if (applied.kind === "pgm_perf") {
      getLogger().debug?.(`[PGM] perf ${line}`);
    }
  }

  // macOS: Launch Services swallows stdout, so the sidecar event log is tailed.
  private startEventLogTail(path: string): void {
    this.eventLogOffset = 0;
    this.stopEventLogTail();
    this.eventLogTimer = setInterval(() => {
      try {
        const content = readFileSync(path, "utf8");
        if (content.length < this.eventLogOffset) {
          this.eventLogOffset = 0;
        }
        const fresh = content.slice(this.eventLogOffset);
        this.eventLogOffset = content.length;
        for (const line of fresh.split("\n")) {
          if (line.trim()) {
            this.handleHelperLine(line.trim());
          }
        }
      } catch {
        // Not written yet.
      }
    }, 250);
    this.eventLogTimer.unref?.();
  }

  private stopEventLogTail(): void {
    if (this.eventLogTimer) {
      clearInterval(this.eventLogTimer);
      this.eventLogTimer = null;
    }
  }

  private setStatus(status: PgmStatusT, reason: string, force: boolean): void {
    this.status = { ...status, enabled: parsePgmEnv(this.deps.env).enabled };
    this.requestStatusPublish(reason, force);
  }

  private requestStatusPublish(reason: string, force = false): void {
    const elapsed = Date.now() - this.lastPublishAt;
    if (force || elapsed >= STATUS_PUBLISH_MIN_INTERVAL_MS) {
      this.lastPublishAt = Date.now();
      publishPgmStatusEvent(reason, this.getStatus());
      return;
    }
    if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.lastPublishAt = Date.now();
        publishPgmStatusEvent(reason, this.getStatus());
      }, STATUS_PUBLISH_MIN_INTERVAL_MS - elapsed);
      this.publishTimer.unref?.();
    }
  }

  private handleProcessExit(): void {
    const crashed = this.state === "running" && !this.shutdownRequested;
    this.process = null;
    this.client = null;
    this.stopEventLogTail();
    if (this.state !== "stopped") {
      this.state = crashed ? "error" : "stopped";
    }
    this.sessions.clear();
    if (!crashed) {
      return;
    }
    const uptimeMs = this.runningSince !== null ? Date.now() - this.runningSince : 0;
    this.restart = noteHelperCrash(this.restart, uptimeMs, DEFAULT_HELPER_RESTART_POLICY);
    const { decision, state } = decideHelperRestart(this.restart, DEFAULT_HELPER_RESTART_POLICY);
    this.restart = state;
    if (decision.action === "give_up") {
      const message = `PGM helper crashed and did not recover after ${decision.attempts} restart attempts.`;
      this.setStatus(idlePgmStatus(true, { code: "helper_not_reachable", message }), "helper_restart_exhausted", true);
      publishPgmErrorEvent("helper_restart_exhausted", message);
      return;
    }
    getLogger().warn(`[PGM] Helper crashed; restart attempt ${decision.attempt} in ${decision.delayMs}ms`);
    this.setStatus(idlePgmStatus(true, { code: "helper_not_reachable", message: "PGM helper restarting after a crash." }), "helper_crashed", true);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shutdownRequested || !this.source.input) {
        return;
      }
      void this.selectSource(`${this.source.input.kind}:${this.source.input.stable_key}`, this.source.profile).catch((error) => {
        getLogger().warn(`[PGM] Restart failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, decision.delayMs);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private killProcess(): void {
    const child = this.process;
    this.process = null;
    if (!child) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    const force = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5000);
    force.unref?.();
    child.once("exit", () => clearTimeout(force));
  }
}

const KNOWN_PGM_CODES = new Set([
  "pgm_disabled", "pgm_unsupported_bridge", "pgm_not_implemented", "pgm_viewer_limit", "pgm_no_signal", "pgm_sdp_invalid",
  "pgm_session_not_found", "input_not_found", "device_in_use", "camera_permission_denied", "encoder_unavailable", "helper_not_reachable",
]);

function isKnownPgmCode(code: string): code is import("./pgm-errors.js").PgmErrorCodeT {
  return KNOWN_PGM_CODES.has(code);
}

export const pgmHelperManager = new PgmHelperManager();
