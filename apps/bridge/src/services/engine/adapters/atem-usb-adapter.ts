import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "events";
import type {
  EngineAdapter,
  EngineConnectConfig,
} from "../engine-adapter-interface.js";
import type {
  EngineStatusT,
  MacroExecutionT,
  MacroT,
  EngineStateT,
} from "../../engine-types.js";
import { EngineMacroExecutionStore } from "../engine-macro-execution-store.js";
import {
  EngineError,
  EngineErrorCode,
  createAtemSoftwareMissingError,
  createNotConnectedError,
  createUsbDeviceBusyError,
  createUsbSwitcherNotFoundError,
  createUsbConnectFailedError,
} from "../engine-errors.js";
import { getBridgeContext } from "../../bridge-context.js";
import { stopChildProcessWithEscalation } from "../../shared/child-process-exit.js";

const HELPER_PATH_ENV = "ATEM_USB_HELPER_PATH";
const CONNECT_TIMEOUT_MS = 10000;
const SHUTDOWN_SIGTERM_DELAY_MS = 4000;
const SHUTDOWN_SIGKILL_DELAY_MS = 2000;
const PENDING_COMPLETION_GRACE_MS = 750;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_MAX_MISSES = 2;
const MACRO_ACK_TIMEOUT_MS = 2000;
const HELPER_PROTOCOL_HEARTBEAT_MIN_VERSION = 2;
/** Helper emits this macro index when no macro is active. */
const HELPER_NO_MACRO_INDEX = 65535;

type HelperMacroT = { id: number; name: string; description: string };

type HelperEventT = {
  type?: string;
  error?: string;
  detail?: string;
  product_name?: string;
  macros?: HelperMacroT[];
  status?: "idle" | "running" | "waiting";
  loop?: boolean;
  index?: number;
  protocol_version?: number;
  seq?: number;
  req?: number;
  command?: string;
  hr?: string;
  fail_reason?: string;
};

type PendingMacroRunT = {
  runId: string;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: EngineError) => void;
};

const getLogger = () => {
  try {
    return getBridgeContext().logger;
  } catch {
    return {
      info: (msg: string) => console.info(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
      debug: (msg: string) => console.debug(msg),
    };
  }
};

/** Test-only override; set to non-null in tests to bypass import.meta. */
let testHelperPathOverride: string | null = null;

function getModuleDirname(): string {
  try {
    const url = (0, eval)("import.meta.url") as string;
    return dirname(fileURLToPath(url));
  } catch {
    return "/tmp";
  }
}

/**
 * Resolve the ATEM USB helper binary path (env override, then packaged
 * resources in production, then the repo-local dev build).
 */
export function resolveAtemUsbHelperPath(): string {
  if (testHelperPathOverride !== null) {
    return testHelperPathOverride;
  }
  const envPath = process.env[HELPER_PATH_ENV];
  if (envPath) {
    return envPath;
  }

  const __dirname = getModuleDirname();
  const binaryName =
    process.platform === "win32" ? "atem-usb-helper.exe" : "atem-usb-helper";

  const devPath = join(
    __dirname,
    "../../../../native/atem-usb-helper",
    binaryName
  );

  const resourcesPath = process.resourcesPath;
  const prodPath = resourcesPath
    ? join(resourcesPath, "native", "atem-usb-helper", binaryName)
    : "";

  if (process.env.NODE_ENV === "production" && prodPath) {
    return prodPath;
  }

  return devPath;
}

/**
 * Test-only: override helper path for resolveAtemUsbHelperPath. Call with
 * null to reset.
 * @internal
 */
export function __setAtemUsbHelperPathForTesting(path: string | null): void {
  testHelperPathOverride = path;
}

/**
 * ATEM USB adapter implementation
 *
 * Implements EngineAdapter for USB-attached Blackmagic ATEM switchers by
 * driving the atem-usb-helper process (official ATEM Switchers SDK). The
 * helper speaks one JSON command per line on stdin and one JSON event per
 * line on stdout; all SDK calls stay in the helper so SDK crashes or
 * blocking calls can never take down the bridge.
 *
 * Macro IDs are 0-based, identical to the network AtemAdapter.
 */
export class AtemUsbAdapter extends EventEmitter implements EngineAdapter {
  private process: ChildProcess | null = null;
  private stdoutBuffer = "";
  private state: EngineStateT = {
    status: "disconnected",
    macros: [],
    macroExecution: null,
    lastCompletedMacroExecution: null,
  };
  private readonly macroExecutionStore = new EngineMacroExecutionStore();
  private pendingCompletionTimeout: NodeJS.Timeout | null = null;
  private helperMacros: HelperMacroT[] = [];
  private macroRunState: { status: "idle" | "running" | "waiting"; loop: boolean; index: number } =
    { status: "idle", loop: false, index: HELPER_NO_MACRO_INDEX };
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimeout: NodeJS.Timeout | null = null;
  private stopping: Promise<void> | null = null;
  private helperProtocolVersion = 1;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private pendingHeartbeatSeq: number | null = null;
  private missedPongs = 0;
  private nextHeartbeatSeq = 1;
  private nextMacroRequest = 1;
  private readonly pendingMacroRuns = new Map<number, PendingMacroRunT>();

  async connect(config: EngineConnectConfig): Promise<void> {
    if (config.type !== "atem" || config.transport !== "usb") {
      throw new Error(
        `AtemUsbAdapter only supports type "atem" with transport "usb", got "${config.type}"/"${config.transport ?? "network"}"`
      );
    }
    if (this.stopping) {
      await this.stopping;
    }
    if (this.process) {
      throw new EngineError(
        EngineErrorCode.UNKNOWN_ERROR,
        "ATEM USB helper is still running"
      );
    }
    if (this.state.status === "connected" || this.state.status === "connecting") {
      throw new Error("Engine is already connected or connecting");
    }

    const helperPath = resolveAtemUsbHelperPath();
    try {
      await access(helperPath, constants.X_OK);
    } catch {
      throw new EngineError(
        EngineErrorCode.DEVICE_NOT_FOUND,
        `ATEM USB helper binary not found or not executable at ${helperPath}.`,
        { helperPath }
      );
    }

    this.setState({
      status: "connecting",
      type: config.type,
      transport: "usb",
      ip: undefined,
      port: undefined,
      macroExecution: null,
      lastCompletedMacroExecution: null,
      error: undefined,
      errorCode: undefined,
    });

    const connectionPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });

    const child = spawn(helperPath, ["--run"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    this.stdoutBuffer = "";

    child.stdout?.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      getLogger().debug?.(`[AtemUsbHelper] ${chunk.toString().trimEnd()}`);
    });
    child.on("error", (error: Error) => {
      this.failConnect(
        new EngineError(
          EngineErrorCode.UNKNOWN_ERROR,
          `Failed to start ATEM USB helper: ${error.message}`,
          { helperPath }
        )
      );
    });
    child.on("exit", (code, signal) => {
      getLogger().info(
        `[AtemUsb] Helper exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
      );
      this.handleHelperExit(child);
    });

    this.connectTimeout = setTimeout(() => {
      this.failConnect(
        new EngineError(
          EngineErrorCode.CONNECTION_TIMEOUT,
          `Connection timeout: no ATEM switcher responded on USB within ${CONNECT_TIMEOUT_MS}ms. Check the USB cable and that the switcher is powered on.`,
          { transport: "usb", timeoutMs: CONNECT_TIMEOUT_MS }
        )
      );
    }, CONNECT_TIMEOUT_MS);
    this.connectTimeout.unref?.();

    await connectionPromise;
  }

  async disconnect(): Promise<void> {
    this.clearPendingCompletionTimer();
    this.stopHeartbeat();
    this.rejectPendingMacroRuns("not_connected");
    await this.stopHelper();
    this.setState({
      status: "disconnected",
      macros: [],
      ip: undefined,
      port: undefined,
      type: undefined,
      transport: undefined,
      error: undefined,
      errorCode: undefined,
      macroExecution: null,
      lastCompletedMacroExecution: null,
    });
    this.macroExecutionStore.reset();
    this.helperMacros = [];
    this.macroRunState = { status: "idle", loop: false, index: HELPER_NO_MACRO_INDEX };
    this.helperProtocolVersion = 1;
  }

  getStatus(): EngineStatusT {
    return this.state.status;
  }

  getMacros(): MacroT[] {
    return [...this.state.macros];
  }

  async runMacro(id: number): Promise<void> {
    this.assertConnected("run macro");
    const pendingExecution = this.macroExecutionStore.startPending({
      macroId: id,
      macroName: this.resolveMacroName(id),
      engineType: "atem",
    });
    this.rebuildMacros();
    if (this.helperProtocolVersion >= 2) {
      const req = this.nextMacroRequest++;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingMacroRuns.delete(req);
          this.macroExecutionStore.fail("macro_ack_timeout");
          this.setState({
            macroExecution: this.macroExecutionStore.getActiveExecution(),
            lastCompletedMacroExecution:
              this.macroExecutionStore.getLastCompletedExecution(),
          });
          reject(
            new EngineError(
              EngineErrorCode.PROTOCOL_ERROR,
              "ATEM USB helper did not acknowledge the macro run request.",
              { reason: "macro_ack_timeout" }
            )
          );
        }, MACRO_ACK_TIMEOUT_MS);
        timer.unref?.();
        this.pendingMacroRuns.set(req, {
          runId: pendingExecution.runId,
          timer,
          resolve,
          reject,
        });
        try {
          this.sendCommand({ command: "macro_run", index: id, req });
        } catch (error: unknown) {
          clearTimeout(timer);
          this.pendingMacroRuns.delete(req);
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.macroExecutionStore.fail(errorMessage);
          this.rebuildMacros();
          reject(
            new EngineError(
              EngineErrorCode.PROTOCOL_ERROR,
              `Failed to run macro ${id} (slot ${id + 1}): ${errorMessage}`,
              { reason: errorMessage }
            )
          );
        }
      });
    }
    try {
      this.sendCommand({ command: "macro_run", index: id });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.macroExecutionStore.fail(errorMessage);
      this.rebuildMacros();
      throw new Error(`Failed to run macro ${id} (slot ${id + 1}): ${errorMessage}`);
    }
    const acceptedExecution = this.macroExecutionStore.markAccepted();
    this.setState({
      macroExecution: acceptedExecution,
      lastCompletedMacroExecution:
        this.macroExecutionStore.getLastCompletedExecution(),
    });
    if (
      acceptedExecution?.status === "pending" &&
      acceptedExecution.runId === pendingExecution.runId
    ) {
      this.schedulePendingCompletion(acceptedExecution.runId);
    }
  }

  async stopMacro(id: number): Promise<void> {
    this.assertConnected("stop macro");
    try {
      this.macroExecutionStore.requestStop();
      this.setState({
        macroExecution: this.macroExecutionStore.getActiveExecution(),
        lastCompletedMacroExecution:
          this.macroExecutionStore.getLastCompletedExecution(),
      });
      this.sendCommand({ command: "macro_stop" });
    } catch (error: unknown) {
      this.macroExecutionStore.clearStopRequest();
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop macro ${id} (slot ${id + 1}): ${errorMessage}`);
    }
  }

  onStateChange(callback: (state: EngineStateT) => void): () => void {
    this.on("stateChange", callback);
    return () => {
      this.off("stateChange", callback);
    };
  }

  getState(): EngineStateT {
    return { ...this.state };
  }

  private assertConnected(operation: string): void {
    if (!this.process || this.state.status !== "connected") {
      throw createNotConnectedError(operation);
    }
  }

  private sendCommand(command: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      throw new Error("ATEM USB helper is not running");
    }
    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleHelperLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleHelperLine(line: string): void {
    let event: HelperEventT;
    try {
      event = JSON.parse(line) as HelperEventT;
    } catch {
      getLogger().debug?.(`[AtemUsb] Ignored non-JSON helper line: ${line}`);
      return;
    }

    switch (event.type) {
      case "ready":
        this.helperProtocolVersion =
          typeof event.protocol_version === "number" ? event.protocol_version : 1;
        getLogger().info?.(
          `[AtemUsb] Helper protocol v${this.helperProtocolVersion}`
        );
        // Helper is up; ask it to open the USB connection.
        try {
          this.sendCommand({ command: "connect" });
        } catch (error: unknown) {
          this.failConnect(
            new EngineError(
              EngineErrorCode.UNKNOWN_ERROR,
              `Failed to command ATEM USB helper: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        }
        break;
      case "connected":
        this.resolveConnect();
        this.setState({
          status: "connected",
          error: undefined,
          errorCode: undefined,
        });
        this.startHeartbeatIfSupported();
        break;
      case "pong":
        this.handlePong(event.seq);
        break;
      case "ack":
        this.handleMacroAck(event);
        break;
      case "nack":
        this.handleMacroNack(event);
        break;
      case "macros":
        this.helperMacros = Array.isArray(event.macros) ? event.macros : [];
        this.rebuildMacros();
        break;
      case "macro_state":
        this.macroRunState = {
          status: event.status ?? "idle",
          loop: event.loop ?? false,
          index: event.index ?? HELPER_NO_MACRO_INDEX,
        };
        this.rebuildMacros();
        break;
      case "disconnected":
        // Emitted on USB drop and on explicit disconnect; either way the
        // session is over for this adapter instance.
        if (this.state.status === "connected") {
          this.setState({ status: "disconnected" });
        }
        // The helper keeps running (and keeps the switcher claimed) after an
        // unsolicited drop — it only reports the event and holds its SDK
        // objects. Stop it so the USB claim is released; otherwise the next
        // connect fails ("No ATEM switcher found on USB") until the cable is
        // physically re-plugged. Idempotent: a no-op if already stopped.
        void this.stopHelper();
        break;
      case "error":
        this.handleHelperError(event);
        break;
      default:
        getLogger().debug?.(`[AtemUsb] Ignored helper event: ${line}`);
    }
  }

  private handleHelperError(event: HelperEventT): void {
    const error = event.error ?? "unknown";
    const detail = event.detail;
    if (this.connectReject) {
      this.failConnect(this.mapConnectError(error, event));
      return;
    }
    if (error === "unknown_command") {
      getLogger().debug?.(
        `[AtemUsb] Ignored helper unknown_command${detail ? `: ${detail}` : ""}`
      );
      return;
    }
    if (error === "invalid_macro_index" || error === "macro_run_failed") {
      this.macroExecutionStore.fail(error);
      this.rebuildMacros();
      return;
    }
    if (this.state.status === "connected") {
      this.setState({ error: detail ? `${error}: ${detail}` : error });
    }
  }

  private mapConnectError(error: string, event: HelperEventT): EngineError {
    const diagnostics = {
      hr: event.hr,
      failReason: event.fail_reason,
    };
    switch (error) {
      case "atem_software_not_installed":
        return createAtemSoftwareMissingError();
      case "no_usb_switcher_found":
        return createUsbSwitcherNotFoundError(diagnostics);
      case "device_busy":
        return createUsbDeviceBusyError(event.hr, event.fail_reason);
      default:
        return createUsbConnectFailedError(error, diagnostics);
    }
  }

  private resolveConnect(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    const resolve = this.connectResolve;
    this.connectResolve = null;
    this.connectReject = null;
    resolve?.();
  }

  private failConnect(error: EngineError): void {
    this.stopHeartbeat();
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    if (reject) {
      void this.stopHelper();
      this.setState({
        status: "error",
        error: error.message,
        errorCode: error.code,
      });
      reject(error);
    }
  }

  private handleHelperExit(child: ChildProcess): void {
    if (this.process !== child) {
      return;
    }
    this.process = null;
    this.stopHeartbeat();
    this.rejectPendingMacroRuns("not_connected");
    if (this.connectReject) {
      this.failConnect(
        new EngineError(
          EngineErrorCode.UNKNOWN_ERROR,
          "ATEM USB helper exited before the connection was established."
        )
      );
      return;
    }
    if (this.state.status === "connected") {
      this.setState({ status: "disconnected" });
    }
  }

  /**
   * Ask the helper to shut down, escalating SIGTERM -> SIGKILL if it does
   * not exit in time (same escalation as the DeckLink key/fill adapter).
   */
  private stopHelper(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    const child = this.process;
    if (!child) {
      return Promise.resolve();
    }
    this.process = null;
    this.stopHeartbeat();
    const stopping = stopChildProcessWithEscalation(child, {
      requestShutdown: () => {
        child.stdin?.write('{"command":"shutdown"}\n');
      },
      gracefulMs: SHUTDOWN_SIGTERM_DELAY_MS,
      forceMs: SHUTDOWN_SIGKILL_DELAY_MS,
    }).finally(() => {
      this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  private setState(updates: Partial<EngineStateT>): void {
    this.state = {
      ...this.state,
      ...updates,
      lastUpdate: Date.now(),
    };
    this.emit("stateChange", this.getState());
  }

  private clearPendingCompletionTimer(): void {
    if (!this.pendingCompletionTimeout) {
      return;
    }
    clearTimeout(this.pendingCompletionTimeout);
    this.pendingCompletionTimeout = null;
  }

  private startHeartbeatIfSupported(): void {
    this.stopHeartbeat();
    if (this.helperProtocolVersion < HELPER_PROTOCOL_HEARTBEAT_MIN_VERSION) {
      return;
    }
    this.pendingHeartbeatSeq = null;
    this.missedPongs = 0;
    this.nextHeartbeatSeq = 1;
    this.heartbeatInterval = setInterval(() => {
      if (this.pendingHeartbeatSeq !== null) {
        this.missedPongs += 1;
        if (this.missedPongs >= HEARTBEAT_MAX_MISSES) {
          getLogger().warn?.(
            `[AtemUsb] Helper unresponsive (${HEARTBEAT_MAX_MISSES} missed heartbeats), stopping helper`
          );
          this.setState({ status: "disconnected" });
          void this.stopHelper();
          return;
        }
      }
      const seq = this.nextHeartbeatSeq++;
      this.pendingHeartbeatSeq = seq;
      try {
        this.sendCommand({ command: "ping", seq });
      } catch {
        this.setState({ status: "disconnected" });
        void this.stopHelper();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.pendingHeartbeatSeq = null;
    this.missedPongs = 0;
  }

  private handlePong(seq?: number): void {
    if (
      this.pendingHeartbeatSeq === null ||
      (typeof seq === "number" && seq !== this.pendingHeartbeatSeq)
    ) {
      return;
    }
    this.pendingHeartbeatSeq = null;
    this.missedPongs = 0;
  }

  private handleMacroAck(event: HelperEventT): void {
    if (event.command !== "macro_run" || typeof event.req !== "number") {
      return;
    }
    const pending = this.pendingMacroRuns.get(event.req);
    if (!pending) {
      return;
    }
    this.pendingMacroRuns.delete(event.req);
    clearTimeout(pending.timer);
    const acceptedExecution = this.macroExecutionStore.markAccepted();
    this.setState({
      macroExecution: acceptedExecution,
      lastCompletedMacroExecution:
        this.macroExecutionStore.getLastCompletedExecution(),
    });
    if (
      acceptedExecution?.status === "pending" &&
      acceptedExecution.runId === pending.runId
    ) {
      this.schedulePendingCompletion(acceptedExecution.runId);
    }
    pending.resolve();
  }

  private handleMacroNack(event: HelperEventT): void {
    if (event.command !== "macro_run" || typeof event.req !== "number") {
      return;
    }
    const pending = this.pendingMacroRuns.get(event.req);
    if (!pending) {
      return;
    }
    this.pendingMacroRuns.delete(event.req);
    clearTimeout(pending.timer);
    const reason = event.error ?? "macro_run_failed";
    this.macroExecutionStore.fail(reason);
    this.setState({
      macroExecution: this.macroExecutionStore.getActiveExecution(),
      lastCompletedMacroExecution:
        this.macroExecutionStore.getLastCompletedExecution(),
    });
    if (reason === "not_connected") {
      pending.reject(createNotConnectedError("run macro"));
      return;
    }
    pending.reject(
      new EngineError(
        EngineErrorCode.PROTOCOL_ERROR,
        `ATEM USB helper rejected macro_run (${reason}).`,
        { reason }
      )
    );
  }

  private rejectPendingMacroRuns(reason: string): void {
    for (const [req, pending] of this.pendingMacroRuns) {
      clearTimeout(pending.timer);
      pending.reject(
        new EngineError(
          EngineErrorCode.PROTOCOL_ERROR,
          `ATEM USB helper macro_run failed (${reason}).`,
          { reason }
        )
      );
      this.pendingMacroRuns.delete(req);
    }
  }

  private schedulePendingCompletion(runId: string): void {
    this.clearPendingCompletionTimer();
    this.pendingCompletionTimeout = setTimeout(() => {
      this.pendingCompletionTimeout = null;
      const activeExecution = this.macroExecutionStore.getActiveExecution();
      if (
        activeExecution?.runId !== runId ||
        activeExecution.status !== "pending" ||
        activeExecution.acceptedAt === null ||
        activeExecution.acceptedAt === undefined
      ) {
        return;
      }
      this.macroExecutionStore.markInactive();
      this.rebuildMacros();
    }, PENDING_COMPLETION_GRACE_MS);
    this.pendingCompletionTimeout.unref?.();
  }

  private resolveMacroName(id: number): string | undefined {
    return this.helperMacros.find((macro) => macro.id === id)?.name;
  }

  /**
   * Rebuild the MacroT list from the helper's macro list and run state,
   * mirroring the network adapter's status derivation (recording status is
   * not surfaced by the USB helper).
   */
  private rebuildMacros(): void {
    const activeRunningMacroId =
      this.macroRunState.status === "running" &&
      this.macroRunState.index !== HELPER_NO_MACRO_INDEX
        ? this.macroRunState.index
        : null;
    const activeWaitingMacroId =
      this.macroRunState.status === "waiting" &&
      this.macroRunState.index !== HELPER_NO_MACRO_INDEX
        ? this.macroRunState.index
        : null;
    const activeExecution = this.syncMacroExecutionFromState(
      activeRunningMacroId,
      activeWaitingMacroId,
      this.macroRunState.loop
    );

    const macros: MacroT[] = this.helperMacros.map((helperMacro) => {
      let status: MacroT["status"] = "idle";
      if (activeWaitingMacroId === helperMacro.id) {
        status = "waiting";
      } else if (activeRunningMacroId === helperMacro.id) {
        status = "running";
      } else if (
        activeExecution?.status === "pending" &&
        activeExecution.macroId === helperMacro.id
      ) {
        status = "pending";
      }
      return {
        id: helperMacro.id,
        name: helperMacro.name || `Macro ${helperMacro.id + 1}`,
        status,
      };
    });

    this.setState({
      macros,
      macroExecution: this.macroExecutionStore.getActiveExecution(),
      lastCompletedMacroExecution:
        this.macroExecutionStore.getLastCompletedExecution(),
    });
  }

  private syncMacroExecutionFromState(
    activeRunningMacroId: number | null,
    activeWaitingMacroId: number | null,
    loop: boolean
  ): MacroExecutionT | null {
    if (activeWaitingMacroId !== null) {
      this.clearPendingCompletionTimer();
      return this.macroExecutionStore.markDeviceState({
        macroId: activeWaitingMacroId,
        macroName: this.resolveMacroName(activeWaitingMacroId),
        engineType: "atem",
        status: "waiting",
        loop,
      });
    }
    if (activeRunningMacroId !== null) {
      this.clearPendingCompletionTimer();
      return this.macroExecutionStore.markDeviceState({
        macroId: activeRunningMacroId,
        macroName: this.resolveMacroName(activeRunningMacroId),
        engineType: "atem",
        status: "running",
        loop,
      });
    }
    const execution = this.macroExecutionStore.markInactive();
    if (execution?.status !== "pending") {
      this.clearPendingCompletionTimer();
    }
    return execution;
  }
}
