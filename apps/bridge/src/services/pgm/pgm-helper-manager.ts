import { existsSync, readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { PgmRecordingT, PgmStatusT, VideoInputDescriptorT } from "@broadify/protocol";

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
import { EMPTY_PGM_SOURCE, PgmSourceStore, type PgmSourceFileT } from "./pgm-source-store.js";
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

/** How often the bridge-side session map is checked against the helper's live viewers. */
const SESSION_RECONCILE_MS = 10_000;

/** PeerConnection states after which the helper drops the viewer (see WebRtcPublisher::reapDead). */
export function isDeadViewerState(state: string): boolean {
  return state === "closed" || state === "failed";
}

export function idlePgmStatus(enabled: boolean, lastError: { code: string; message: string } | null = null): PgmStatusT {
  return { enabled, state: lastError ? "error" : "idle", input: null, signal: null, encoder: null, audio: false, viewers: 0, last_error: lastError };
}

/** A helper stdout/event-log line; the status projection the manager keeps. */
export function applyHelperEvent(current: PgmStatusT, line: string): { status: PgmStatusT; kind: string; event: Record<string, unknown> } | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "pgm_status" && event.status && typeof event.status === "object") {
    return { status: { ...(event.status as PgmStatusT), enabled: current.enabled }, kind: type, event };
  }
  if (type === "pgm_signal" && event.signal && typeof event.signal === "object") {
    return { status: { ...current, signal: event.signal as PgmStatusT["signal"] }, kind: type, event };
  }
  if (type === "pgm_error" && typeof event.code === "string") {
    return { status: { ...current, state: "error", last_error: { code: event.code, message: String(event.message ?? "") } }, kind: type, event };
  }
  if (type === "pgm_recording" && typeof event.active === "boolean") {
    return { status: { ...current, recording: recordingFromEvent(current.recording ?? null, event) }, kind: type, event };
  }
  return { status: current, kind: type, event };
}

const optionalNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Projects a helper `pgm_recording` event (start: file + archive encoder
 * parameters; stop: ok/error) onto `status.recording`, so a helper-side stop
 * (source cleared, shutdown) reaches the web app without a status round trip.
 * The next `pgm_status` snapshot replaces the projection anyway.
 */
function recordingFromEvent(current: PgmRecordingT | null, event: Record<string, unknown>): PgmRecordingT {
  const error = typeof event.error === "string" ? event.error : null;
  if (event.active !== true) {
    return { active: false, file_path: null, started_at_ms: null, bytes: current?.bytes ?? 0, error };
  }
  const recording: PgmRecordingT = {
    active: true,
    file_path: typeof event.file_path === "string" ? event.file_path : (current?.file_path ?? null),
    started_at_ms: current?.active ? (current.started_at_ms ?? null) : Date.now(),
    bytes: current?.active ? current.bytes : 0,
    error,
  };
  if (event.profile === "high") {
    recording.profile = "high";
  }
  for (const key of ["bitrate_kbps", "width", "height", "fps_num", "fps_den", "frames"] as const) {
    const value = optionalNumber(event[key]);
    if (value !== undefined) {
      recording[key] = value;
    }
  }
  return recording;
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
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly sessions: PgmSessionManager;
  /** Resolved lazily: the singleton is created at import time, before the bridge context (userDataDir) exists. */
  private store: PgmSourceStore | null = null;
  private source: PgmSourceFileT = EMPTY_PGM_SOURCE;
  private sourceLoaded = false;

  constructor(private readonly deps: PgmHelperManagerDepsT = defaultDeps) {
    const env = parsePgmEnv(deps.env);
    this.status = idlePgmStatus(env.enabled);
    this.sessions = new PgmSessionManager(env.maxViewers);
  }

  private getStore(): PgmSourceStore | null {
    if (!this.store) {
      try {
        this.store = new PgmSourceStore(this.deps.userDataDir());
      } catch {
        return null; // context not ready yet; retried on the next call
      }
    }
    return this.store;
  }

  /** The persisted program source (loaded from disk on first use). */
  getSource(): PgmSourceFileT {
    if (!this.sourceLoaded) {
      const store = this.getStore();
      if (store) {
        this.source = store.load();
        this.sourceLoaded = true;
      }
    }
    return this.source;
  }

  private async persistSource(next: PgmSourceFileT): Promise<void> {
    this.source = next;
    this.sourceLoaded = true;
    try {
      await this.getStore()?.save(next);
    } catch (error: unknown) {
      getLogger().warn(`[PGM] Persisting the program source failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    await this.persistSource({
      version: 1,
      input: status.input ? { kind: status.input.kind, stable_key: status.input.stable_key, display_name: status.input.display_name } : null,
      profile,
    });
    this.setStatus(status, "source_selected", true);
    return this.getStatus();
  }

  async clearSource(): Promise<PgmStatusT> {
    await this.persistSource({ version: 1, input: null, profile: this.getSource().profile });
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
    const source = this.getSource();
    if (!source.input) {
      throw new PgmError("pgm_no_signal", "No program source is selected on this bridge.");
    }
    if (!this.sessions.reserve(payload.session_id, payload.viewer_user_id, payload.label ?? null)) {
      // Browsers that reloaded or lost power never sent pgm_webrtc_close: ask the helper
      // which viewers are really alive before refusing.
      await this.reconcileSessions();
      if (!this.sessions.reserve(payload.session_id, payload.viewer_user_id, payload.label ?? null)) {
        throw new PgmError("pgm_viewer_limit", `Viewer limit reached (${env.maxViewers}).`, { max_viewers: env.maxViewers, active_viewers: this.sessions.count() });
      }
    }
    try {
      const client = await this.ensureRunning();
      const { sdp } = await client.viewerOffer(payload, source.profile);
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

  async snapshot(quality: number): Promise<{ jpeg_base64: string; width: number; height: number; captured_at_ms: number }> {
    const client = await this.ensureRunning();
    return client.snapshot(quality).catch((error) => this.rethrow(error));
  }

  async recordingStart(filePath: string): Promise<PgmStatusT> {
    const client = await this.ensureRunning();
    await client.recordingStart(filePath).catch((error) => this.rethrow(error));
    const status = await client.status().catch(() => null);
    if (status) {
      this.setStatus(status, "recording_started", true);
    }
    return this.getStatus();
  }

  async recordingStop(): Promise<PgmStatusT> {
    if (!this.client) {
      throw new PgmError("pgm_session_not_found", "No recording is running (helper is not active).");
    }
    await this.client.recordingStop().catch((error) => this.rethrow(error));
    const status = await this.client.status().catch(() => null);
    if (status) {
      this.setStatus(status, "recording_stopped", true);
    }
    return this.getStatus();
  }

  /** Restores a persisted source on bridge start (helper starts lazily). */
  async restoreOnBoot(): Promise<void> {
    const source = this.getSource();
    if (!parsePgmEnv(this.deps.env).enabled || !source.input) {
      return;
    }
    try {
      await this.selectSource(`${source.input.kind}:${source.input.stable_key}`, source.profile);
    } catch (error: unknown) {
      getLogger().warn(`[PGM] Restoring the program source failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
    this.stopEventLogTail();
    this.stopSessionReconcile();
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
    this.startSessionReconcile();
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
    } else if (applied.kind === "pgm_viewer_state") {
      const viewerId = typeof applied.event.viewer_id === "string" ? applied.event.viewer_id : null;
      const viewerState = typeof applied.event.state === "string" ? applied.event.state : "";
      if (viewerId && isDeadViewerState(viewerState) && this.sessions.has(viewerId)) {
        this.sessions.release(viewerId);
        this.requestStatusPublish("viewer_closed");
      }
    } else if (applied.kind === "pgm_inputs_changed") {
      const publish = getBridgeContext().publishBridgeEvent;
      publish?.({ event: "pgm_inputs_changed", data: { at: Date.now() } });
    } else if (applied.kind === "pgm_perf") {
      getLogger().debug?.(`[PGM] perf ${line}`);
    }
  }

  /**
   * Drops bridge-side sessions whose PeerConnection the helper no longer has
   * (closed/failed, or reaped after 10 s disconnected / 15 s never connected).
   * Without this a browser that reloads or loses power keeps its slot forever
   * and the viewer cap locks everyone out.
   */
  async reconcileSessions(): Promise<string[]> {
    const client = this.client;
    if (!client || this.state !== "running") {
      return [];
    }
    let result: Awaited<ReturnType<PgmHelperClient["sessionsList"]>>;
    try {
      result = await client.sessionsList();
    } catch {
      return [];
    }
    const live = new Set(result.sessions.filter((s) => !isDeadViewerState(s.state)).map((s) => s.viewer_id));
    const dropped = this.sessions.reconcile(live);
    if (dropped.length > 0) {
      getLogger().info(`[PGM] Released ${dropped.length} viewer session(s) the helper no longer serves`);
      this.requestStatusPublish("viewer_closed");
    }
    return dropped;
  }

  private startSessionReconcile(): void {
    this.stopSessionReconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileSessions();
    }, SESSION_RECONCILE_MS);
    this.reconcileTimer.unref?.();
  }

  private stopSessionReconcile(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
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
    this.stopSessionReconcile();
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
      const source = this.getSource();
      if (this.shutdownRequested || !source.input) {
        return;
      }
      void this.selectSource(`${source.input.kind}:${source.input.stable_key}`, source.profile).catch((error) => {
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
  "recording_failed", "snapshot_failed",
]);

function isKnownPgmCode(code: string): code is import("./pgm-errors.js").PgmErrorCodeT {
  return KNOWN_PGM_CODES.has(code);
}

export const pgmHelperManager = new PgmHelperManager();
