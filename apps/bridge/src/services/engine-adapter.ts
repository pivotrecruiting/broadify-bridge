import type {
  EngineAdapter,
  EngineConnectConfig,
  EnsureVmixBrowserInputConfigT,
  EnsureVmixBrowserInputResultT,
} from "./engine/engine-adapter-interface.js";
import { createEngineAdapter } from "./engine/adapter-factory.js";
import { EngineStateStore } from "./engine/engine-state-store.js";
import { websocketManager } from "./websocket-manager.js";
import type { EngineStateT, EngineStatusT, MacroT } from "./engine-types.js";
import {
  EngineError,
  EngineErrorCode,
  createAlreadyConnectedError,
  createAlreadyConnectingError,
  createNotConnectedError,
} from "./engine/engine-errors.js";

type EngineBroadcastTopicT = Parameters<typeof websocketManager.broadcast>[0];
type EngineBroadcastMessageT = Parameters<typeof websocketManager.broadcast>[1];

type EngineAdapterServiceDepsT = {
  createAdapter: (type: EngineConnectConfig["type"]) => EngineAdapter;
  broadcast: (topic: EngineBroadcastTopicT, message: EngineBroadcastMessageT) => void;
};

const defaultDeps: EngineAdapterServiceDepsT = {
  createAdapter: (type) => createEngineAdapter(type),
  broadcast: (topic, message) => websocketManager.broadcast(topic, message),
};

type VmixBrowserInputCapableAdapterT = EngineAdapter & {
  ensureVmixBrowserInput: (
    config: EnsureVmixBrowserInputConfigT
  ) => Promise<EnsureVmixBrowserInputResultT>;
};

const isVmixBrowserInputCapableAdapter = (
  adapter: EngineAdapter | null
): adapter is VmixBrowserInputCapableAdapterT => {
  return typeof adapter?.ensureVmixBrowserInput === "function";
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

  constructor(deps: EngineAdapterServiceDepsT = defaultDeps) {
    this.deps = deps;
    this.stateStore = new EngineStateStore();
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
  async connect(config: EngineConnectConfig): Promise<void> {
    const currentState = this.stateStore.getState();

    if (currentState.status === "connected") {
      throw createAlreadyConnectedError();
    }
    if (currentState.status === "connecting") {
      throw createAlreadyConnectingError();
    }

    // Update state
    this.stateStore.setState({
      status: "connecting",
      type: config.type,
      ip: config.ip,
      port: config.port,
    });

    try {
      // Unsubscribe from previous adapter if exists
      if (this.unsubscribeAdapterState) {
        this.unsubscribeAdapterState();
        this.unsubscribeAdapterState = null;
      }

      // Create adapter using factory
      this.adapter = this.deps.createAdapter(config.type);

      // Subscribe to adapter state changes and store unsubscribe function
      this.unsubscribeAdapterState = this.adapter.onStateChange(
        (state: EngineStateT) => {
          this.stateStore.setState(state);
          this.broadcastStateChanges(state);
        }
      );

      // Connect adapter
      await this.adapter.connect(config);

      // Note: State will be updated via adapter's onStateChange callback
    } catch (error: unknown) {
      // Clean up adapter on connection failure
      if (this.unsubscribeAdapterState) {
        this.unsubscribeAdapterState();
        this.unsubscribeAdapterState = null;
      }
      this.adapter = null;

      // Re-throw EngineError as-is, wrap others
      if (error instanceof EngineError) {
        const errorState: EngineStateT = {
          status: "error",
          type: config.type,
          ip: config.ip,
          port: config.port,
          error: error.message,
          macros: [],
        };
        this.stateStore.setState(errorState);
        this.broadcastStateChanges(errorState);
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
        macros: [],
      };
      this.stateStore.setState(errorState);
      this.broadcastStateChanges(errorState);
      throw engineError;
    }
  }

  /**
   * Disconnect from engine
   */
  async disconnect(): Promise<void> {
    // Unsubscribe from adapter state changes first
    if (this.unsubscribeAdapterState) {
      this.unsubscribeAdapterState();
      this.unsubscribeAdapterState = null;
    }

    if (this.adapter) {
      try {
        await this.adapter.disconnect();
      } catch (error) {
        // Log disconnect errors but don't throw - disconnect should always succeed
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(
          "[EngineAdapterService] Error during disconnect:",
          errorMessage
        );
      }
      this.adapter = null;
    }

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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to run macro ${macroId}: ${errorMessage}`);
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop macro ${macroId}: ${errorMessage}`);
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
   * Broadcast state changes via WebSocket Manager
   */
  private broadcastStateChanges(state: EngineStateT): void {
    // Broadcast status change only if status or error changed
    if (
      !this.previousState ||
      this.previousState.status !== state.status ||
      this.previousState.error !== state.error
    ) {
      this.deps.broadcast("engine", {
        type: "engine.status",
        status: state.status,
        error: state.error,
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
          message: state.error,
        },
      });
    }

    // Broadcast macros if changed
    if (
      !this.previousState ||
      JSON.stringify(this.previousState.macros) !== JSON.stringify(state.macros)
    ) {
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

    this.previousState = { ...state };
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
