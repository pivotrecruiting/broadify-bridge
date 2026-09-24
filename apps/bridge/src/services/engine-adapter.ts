import type {
  EngineAdapter,
  EngineConnectConfig,
  EnsureVmixBrowserInputConfigT,
  EnsureVmixBrowserInputResultT,
  VmixActionConfigT,
  VmixActionResultT,
} from "./engine/engine-adapter-interface.js";
import { createEngineAdapter } from "./engine/adapter-factory.js";
import { engineConnectionStore } from "./engine/engine-connection-store.js";
import { EngineStateStore } from "./engine/engine-state-store.js";
import { websocketManager } from "./websocket-manager.js";
import type { EngineStateT, EngineStatusT, MacroT } from "./engine-types.js";
import { getBridgeContext } from "./bridge-context.js";
import { getErrorCode } from "./shared/error-code.js";
import {
  EngineError,
  EngineErrorCode,
  createAlreadyConnectedError,
  createAlreadyConnectingError,
  createNotConnectedError,
} from "./engine/engine-errors.js";
import {
  publishEngineErrorEvent,
  publishEngineMacroExecutionEvent,
  publishEngineStatusEvent,
} from "./engine/engine-event-publisher.js";
import {
  EngineConnectionSupervisor,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_RATIO,
  RECONNECT_MAX_DELAY_MS,
  STARTUP_AUTO_CONNECT_DELAY_MS,
} from "./engine/engine-connection-supervisor.js";
import { ReconnectScheduler } from "./shared/backoff.js";
import { isSameEngineConnectConfig } from "./engine/engine-connect-schema.js";

type EngineBroadcastTopicT = Parameters<typeof websocketManager.broadcast>[0];
type EngineBroadcastMessageT = Parameters<typeof websocketManager.broadcast>[1];

type EngineAdapterServiceDepsT = {
  createAdapter: (
    type: EngineConnectConfig["type"],
    transport?: EngineConnectConfig["transport"]
  ) => EngineAdapter;
  broadcast: (topic: EngineBroadcastTopicT, message: EngineBroadcastMessageT) => void;
  persistConnection?: (config: EngineConnectConfig) => Promise<void>;
  loadPersistedConnection?: () => Promise<EngineConnectConfig | null>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  random?: () => number;
};

const defaultDeps: EngineAdapterServiceDepsT = {
  createAdapter: (type, transport) => createEngineAdapter(type, transport),
  broadcast: (topic, message) => websocketManager.broadcast(topic, message),
  persistConnection: (config) => engineConnectionStore.save(config),
  loadPersistedConnection: () => engineConnectionStore.load(),
};

type EngineConnectOriginT = "manual" | "startup";
type TimerT = ReturnType<typeof setTimeout>;

type VmixBrowserInputCapableAdapterT = EngineAdapter & {
  ensureVmixBrowserInput: (
    config: EnsureVmixBrowserInputConfigT
  ) => Promise<EnsureVmixBrowserInputResultT>;
};

type VmixActionCapableAdapterT = EngineAdapter & {
  runVmixAction: (config: VmixActionConfigT) => Promise<VmixActionResultT>;
};

const isVmixBrowserInputCapableAdapter = (
  adapter: EngineAdapter | null
): adapter is VmixBrowserInputCapableAdapterT => {
  return typeof adapter?.ensureVmixBrowserInput === "function";
};

const isVmixActionCapableAdapter = (
  adapter: EngineAdapter | null
): adapter is VmixActionCapableAdapterT => {
  return typeof adapter?.runVmixAction === "function";
};

/**
 * Engine adapter service
 *
 * Manages engine connections using adapter pattern.
 * Delegates actual engine communication to specific adapters (ATEM, Tricaster, etc.).
 * Handles WebSocket broadcasting for real-time state updates.
 */
export class EngineAdapterService {
  private adapter: EngineAdapter | null = null;
  private stateStore: EngineStateStore;
  private previousState: EngineStateT | null = null;
  private unsubscribeAdapterState: (() => void) | null = null;
  private deps: EngineAdapterServiceDepsT;
  private supervisor: EngineConnectionSupervisor;
  private connectPromise: Promise<void> | null = null;
  private connectConfig: EngineConnectConfig | null = null;
  private connectOrigin: EngineConnectOriginT | null = null;
  private startupAutoConnectTimer: TimerT | null = null;
  private reconnectInfo: EngineStateT["reconnect"] = null;

  constructor(deps: EngineAdapterServiceDepsT = defaultDeps) {
    this.deps = { ...defaultDeps, ...deps };
    this.stateStore = new EngineStateStore();
    this.supervisor = new EngineConnectionSupervisor({
      driver: {
        open: (config, origin = "manual") => this.openSession(config, origin),
        close: () => this.closeSession({ resetState: true }),
      },
      getStatus: () => this.getStatus(),
      onReconnectStateChange: (info) => this.setReconnectInfo(info),
      createScheduler: (kind) =>
        new ReconnectScheduler({
          baseMs: RECONNECT_BASE_DELAY_MS,
          maxMs: RECONNECT_MAX_DELAY_MS,
          jitterRatio: kind === "session" ? RECONNECT_JITTER_RATIO : 0,
          setTimeoutFn: this.deps.setTimeoutFn ?? setTimeout,
          clearTimeoutFn: this.deps.clearTimeoutFn ?? clearTimeout,
          now: Date.now,
          random: this.deps.random,
        }),
      logger: {
        info: (message) => getBridgeContext().logger.info(message),
        warn: (message) => getBridgeContext().logger.warn(message),
        error: (message) => getBridgeContext().logger.error(message),
        debug: (message) => getBridgeContext().logger.debug?.(message),
      },
      setTimeoutFn: this.deps.setTimeoutFn ?? setTimeout,
      clearTimeoutFn: this.deps.clearTimeoutFn ?? clearTimeout,
      random: this.deps.random,
    });
  }

  /**
   * Get current engine state
   */
  getState(): EngineStateT {
    return this.stateStore.getState();
  }

  /**
   * Get current engine status
   */
  getStatus(): EngineStatusT {
    return this.stateStore.getState().status;
  }

  /**
   * Get all macros
   */
  getMacros(): MacroT[] {
    return this.stateStore.getState().macros;
  }

  /**
   * Connect to engine
   */
  async connect(
    config: EngineConnectConfig,
    origin: EngineConnectOriginT = "manual"
  ): Promise<void> {
    const currentState = this.stateStore.getState();

    if (currentState.status === "connected") {
      throw createAlreadyConnectedError();
    }

    if (this.connectPromise && this.connectConfig) {
      if (isSameEngineConnectConfig(this.connectConfig, config)) {
        return this.connectPromise;
      }
      if (this.connectOrigin === "manual" || origin !== "manual") {
        throw createAlreadyConnectingError();
      }
      this.supervisor.cancelPending();
      await this.closeSession();
    }

    this.cancelStartupAutoConnectTimer();

    this.connectConfig = config;
    this.connectOrigin = origin;
    this.connectPromise = this.supervisor.connect(config, origin).finally(() => {
      if (this.connectConfig === config) {
        this.connectPromise = null;
        this.connectConfig = null;
        this.connectOrigin = null;
      }
    });
    return this.connectPromise;
  }

  startPersistedAutoConnect(): void {
    this.cancelStartupAutoConnectTimer();
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout;
    this.startupAutoConnectTimer = setTimeoutFn(() => {
      this.startupAutoConnectTimer = null;
      void (async () => {
        const persisted = await this.deps.loadPersistedConnection?.();
        if (!persisted || this.getStatus() !== "disconnected") {
          return;
        }
        await this.connect(persisted, "startup").catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          getBridgeContext().logger.info(
            `[Engine] Startup auto-connect skipped: ${message}`
          );
        });
      })();
    }, STARTUP_AUTO_CONNECT_DELAY_MS);
    this.startupAutoConnectTimer.unref?.();
  }

  beginShutdown(): void {
    this.supervisor.beginShutdown();
    this.cancelStartupAutoConnectTimer();
  }

  private async openSession(
    config: EngineConnectConfig,
    origin: EngineConnectOriginT
  ): Promise<void> {
    this.stateStore.setState({
      status: "connecting",
      type: config.type,
      transport: config.transport ?? "network",
      ip: config.transport === "usb" ? undefined : config.ip,
      port: config.transport === "usb" ? undefined : config.port,
      error: undefined,
      errorCode: undefined,
      reconnect: this.reconnectInfo ?? null,
    });
    this.broadcastStateChanges(this.stateStore.getState());

    let adapter: EngineAdapter | null = null;
    let unsubscribeAdapterState: (() => void) | null = null;
    try {
      await this.closeSession();
      adapter = this.deps.createAdapter(config.type, config.transport);
      this.adapter = adapter;
      const unsubscribe = adapter.onStateChange(
        (state: EngineStateT) => {
          if (this.adapter !== adapter) {
            return;
          }
          const previous = this.stateStore.getState();
          const next = {
            ...state,
            reconnect: state.status === "connected" ? null : this.reconnectInfo ?? null,
          };
          this.stateStore.setState(next);
          this.broadcastStateChanges(this.stateStore.getState());
          this.supervisor.handleSessionStatus(previous.status, state.status);
        }
      );
      unsubscribeAdapterState = () => {
        unsubscribe();
        unsubscribeAdapterState = null;
      };
      this.unsubscribeAdapterState = unsubscribeAdapterState;
      await adapter.connect(config);
      if (origin === "manual") {
        await this.persistConnection(config);
      }
    } catch (error: unknown) {
      if (adapter && this.adapter === adapter) {
        await this.closeSession();
      } else if (adapter) {
        if (unsubscribeAdapterState) {
          unsubscribeAdapterState();
          await adapter.disconnect().catch(() => {});
        }
      }

      if (origin !== "manual") {
        throw error;
      }
      if (error instanceof EngineError) {
        const errorState: EngineStateT = {
          status: "error",
          type: config.type,
          ip: config.ip,
          port: config.port,
          error: error.message,
          errorCode: getErrorCode(error),
          macros: [],
          reconnect: null,
        };
        this.stateStore.setState(errorState);
        this.broadcastStateChanges(this.stateStore.getState());
        throw error;
      }

      // Wrap unknown errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const engineError = new EngineError(
        EngineErrorCode.UNKNOWN_ERROR,
        errorMessage ||
          `Failed to connect to ${config.type} at ${config.ip}:${config.port}`,
        { type: config.type, ip: config.ip, port: config.port }
      );
      const errorState: EngineStateT = {
        status: "error",
        type: config.type,
        ip: config.ip,
        port: config.port,
        error: engineError.message,
        errorCode: engineError.code,
        macros: [],
        reconnect: null,
      };
      this.stateStore.setState(errorState);
      this.broadcastStateChanges(this.stateStore.getState());
      throw engineError;
    }
  }

  private async closeSession(options: { resetState?: boolean } = {}): Promise<void> {
    if (this.unsubscribeAdapterState) {
      this.unsubscribeAdapterState();
      this.unsubscribeAdapterState = null;
    }

    if (this.adapter) {
      const previousAdapter = this.adapter;
      this.adapter = null;
      try {
        await previousAdapter.disconnect();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(
          "[EngineAdapterService] Error during disconnect:",
          errorMessage
        );
      }
    }

    if (options.resetState) {
      this.reconnectInfo = null;
      this.stateStore.reset();
      this.broadcastStateChanges(this.stateStore.getState());
    }
  }

  /**
   * Disconnect from engine
   */
  async disconnect(): Promise<void> {
    this.cancelStartupAutoConnectTimer();
    await this.supervisor.disconnect();
    this.connectPromise = null;
    this.connectConfig = null;
    this.connectOrigin = null;

    // Reset state
    this.stateStore.reset();
    const disconnectedState = this.stateStore.getState();
    this.broadcastStateChanges(disconnectedState);
  }

  /**
   * Run a macro by ID
   */
  async runMacro(macroId: number): Promise<void> {
    if (!this.adapter) {
      throw createNotConnectedError("run macro");
    }

    const currentState = this.stateStore.getState();
    if (currentState.status !== "connected") {
      throw createNotConnectedError("run macro");
    }

    try {
      await this.adapter.runMacro(macroId);
      // State update will come via adapter's onStateChange callback
    } catch (error: unknown) {
      if (error instanceof EngineError) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new EngineError(
        EngineErrorCode.UNKNOWN_ERROR,
        `Failed to run macro ${macroId}: ${errorMessage}`
      );
    }
  }

  /**
   * Stop a macro by ID
   */
  async stopMacro(macroId: number): Promise<void> {
    if (!this.adapter) {
      throw createNotConnectedError("stop macro");
    }

    const currentState = this.stateStore.getState();
    if (currentState.status !== "connected") {
      throw createNotConnectedError("stop macro");
    }

    try {
      await this.adapter.stopMacro(macroId);
      // State update will come via adapter's onStateChange callback
    } catch (error: unknown) {
      if (error instanceof EngineError) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new EngineError(
        EngineErrorCode.UNKNOWN_ERROR,
        `Failed to stop macro ${macroId}: ${errorMessage}`
      );
    }
  }

  /**
   * Ensure a vMix browser input exists for the current browser-input graphics URL.
   */
  async ensureVmixBrowserInput(
    config: EnsureVmixBrowserInputConfigT
  ): Promise<EnsureVmixBrowserInputResultT> {
    if (!this.adapter) {
      throw createNotConnectedError("ensure browser input");
    }

    const currentState = this.stateStore.getState();
    if (currentState.status !== "connected" || currentState.type !== "vmix") {
      throw new Error("vMix engine is not connected");
    }

    if (!isVmixBrowserInputCapableAdapter(this.adapter)) {
      throw new Error("Connected engine does not support browser-input setup");
    }

    return this.adapter.ensureVmixBrowserInput(config);
  }

  /**
   * Execute a documented vMix action for the connected engine.
   */
  async runVmixAction(config: VmixActionConfigT): Promise<VmixActionResultT> {
    if (!this.adapter) {
      throw createNotConnectedError("run vMix action");
    }

    const currentState = this.stateStore.getState();
    if (currentState.status !== "connected" || currentState.type !== "vmix") {
      throw new Error("vMix engine is not connected");
    }

    if (!isVmixActionCapableAdapter(this.adapter)) {
      throw new Error("Connected engine does not support vMix actions");
    }

    return this.adapter.runVmixAction(config);
  }

  /**
   * Broadcast state changes via WebSocket Manager
   */
  private broadcastStateChanges(state: EngineStateT): void {
    const didStatusChange =
      !this.previousState ||
      this.previousState.status !== state.status ||
      this.previousState.error !== state.error ||
      this.previousState.errorCode !== state.errorCode ||
      JSON.stringify(this.previousState.reconnect ?? null) !==
        JSON.stringify(state.reconnect ?? null);
    const didMacrosChange =
      !this.previousState ||
      JSON.stringify(this.previousState.macros) !== JSON.stringify(state.macros);
    const didMacroExecutionChange =
      !this.previousState ||
      JSON.stringify(this.previousState.macroExecution) !==
        JSON.stringify(state.macroExecution) ||
      JSON.stringify(this.previousState.lastCompletedMacroExecution) !==
        JSON.stringify(state.lastCompletedMacroExecution);

    // Broadcast status change only if status or error changed
    if (didStatusChange) {
      this.deps.broadcast("engine", {
        type: "engine.status",
        status: state.status,
        error: state.error,
        errorCode: state.errorCode,
        reconnect: state.reconnect ?? null,
      });
    }

    // Broadcast connection/disconnection events
    if (this.previousState) {
      if (
        this.previousState.status !== "connected" &&
        state.status === "connected"
      ) {
        this.deps.broadcast("engine", {
          type: "engine.connected",
          state,
        });
      } else if (
        this.previousState.status === "connected" &&
        state.status !== "connected"
      ) {
        this.deps.broadcast("engine", {
          type: "engine.disconnected",
        });
      }
    }

    // Broadcast error events only when status changes to error
    if (
      state.status === "error" &&
      state.error &&
      (!this.previousState ||
        this.previousState.status !== "error" ||
        this.previousState.error !== state.error)
    ) {
      this.deps.broadcast("engine", {
        type: "engine.error",
        error: {
          code: state.errorCode,
          message: state.error,
        },
      });
    }

    // Broadcast macros if changed
    if (didMacrosChange) {
      this.deps.broadcast("engine", {
        type: "engine.macros",
        macros: state.macros,
      });
    }

    // Broadcast individual macro status changes
    if (this.previousState) {
      state.macros.forEach((macro) => {
        const previousMacro = this.previousState!.macros.find(
          (m) => m.id === macro.id
        );
        if (!previousMacro || previousMacro.status !== macro.status) {
          this.deps.broadcast("engine", {
            type: "engine.macroStatus",
            macroId: macro.id,
            status: macro.status,
          });
        }
      });
    }

    if (didMacroExecutionChange) {
      this.deps.broadcast("engine", {
        type: "engine.macroExecution",
        execution: state.macroExecution ?? null,
        lastCompletedExecution: state.lastCompletedMacroExecution ?? null,
      });
    }

    if (didStatusChange || didMacrosChange || didMacroExecutionChange) {
      const reason = didMacroExecutionChange
        ? "macro_execution_changed"
        : didMacrosChange
          ? "macros_changed"
          : state.reconnect
            ? "reconnecting"
          : state.status === "disconnected"
            ? "disconnected"
            : state.status === "connected" && this.previousState?.status !== "connected"
              ? "connected"
              : state.status === "error"
                ? "error"
                : "status_changed";
      publishEngineStatusEvent(reason, state);
    }

    if (didMacroExecutionChange) {
      publishEngineMacroExecutionEvent("execution_changed", state);
    }

    if (
      state.status === "error" &&
      state.error &&
      (!this.previousState ||
        this.previousState.status !== "error" ||
        this.previousState.error !== state.error)
    ) {
      publishEngineErrorEvent(state.errorCode ?? "engine_error", state.error);
    }

    this.previousState = { ...state };
  }

  private setReconnectInfo(info: EngineStateT["reconnect"]): void {
    this.reconnectInfo = info;
    const current = this.stateStore.getState();
    if (current.reconnect === info) {
      return;
    }
    this.stateStore.setState({
      status: info ? "connecting" : current.status,
      reconnect: info,
      error: info?.lastError,
      errorCode: info ? current.errorCode : current.errorCode,
    });
    this.broadcastStateChanges(this.stateStore.getState());
  }

  private cancelStartupAutoConnectTimer(): void {
    if (!this.startupAutoConnectTimer) {
      return;
    }
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout;
    clearTimeoutFn(this.startupAutoConnectTimer);
    this.startupAutoConnectTimer = null;
  }

  private async persistConnection(config: EngineConnectConfig): Promise<void> {
    try {
      await this.deps.persistConnection?.(config);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        getBridgeContext().logger.warn(
          `[EngineAdapterService] Failed to persist engine connection: ${message}`
        );
      } catch {
        console.warn(
          "[EngineAdapterService] Failed to persist engine connection:",
          message
        );
      }
    }
  }

  /**
   * Get connected since timestamp
   */
  getConnectedSince(): number | null {
    return this.stateStore.getConnectedSince();
  }

  /**
   * Get last error message
   */
  getLastError(): string | null {
    return this.stateStore.getLastError();
  }
}

/**
 * Singleton instance
 */
export const engineAdapter = new EngineAdapterService();
