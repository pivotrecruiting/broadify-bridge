import type {
  EngineAdapter,
  EngineConnectConfig,
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

/**
 * Engine adapter service
 *
 * Manages engine connections using adapter pattern.
 * Delegates actual engine communication to specific adapters (ATEM, Tricaster, etc.).
 * Handles WebSocket broadcasting for real-time state updates.
 */
class EngineAdapterService {
  private adapter: EngineAdapter | null = null;
  private stateStore: EngineStateStore;
  private previousState: EngineStateT | null = null;
  private unsubscribeAdapterState: (() => void) | null = null;

  constructor() {
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
      this.adapter = createEngineAdapter(config.type);

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
   * Broadcast state changes via WebSocket Manager
   */
  private broadcastStateChanges(state: EngineStateT): void {
    // Broadcast status change
    websocketManager.broadcast("engine", {
      type: "engine.status",
      status: state.status,
      error: state.error,
    });

    // Broadcast connection/disconnection events
    if (this.previousState) {
      if (
        this.previousState.status !== "connected" &&
        state.status === "connected"
      ) {
        websocketManager.broadcast("engine", {
          type: "engine.connected",
          state,
        });
      } else if (
        this.previousState.status === "connected" &&
        state.status !== "connected"
      ) {
        websocketManager.broadcast("engine", {
          type: "engine.disconnected",
        });
      }
    }

    // Broadcast error events
    if (state.status === "error" && state.error) {
      websocketManager.broadcast("engine", {
        type: "engine.error",
        error: state.error,
      });
    }

    // Broadcast macros if changed
    if (
      !this.previousState ||
      JSON.stringify(this.previousState.macros) !== JSON.stringify(state.macros)
    ) {
      websocketManager.broadcast("engine", {
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
          websocketManager.broadcast("engine", {
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
