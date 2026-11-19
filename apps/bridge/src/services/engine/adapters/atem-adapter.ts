import { Atem } from "atem-connection";
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
import { EventEmitter } from "events";
import { EngineMacroExecutionStore } from "../engine-macro-execution-store.js";
import {
  EngineError,
  EngineErrorCode,
  createConnectionTimeoutError,
  createConnectionRefusedError,
  createNetworkError,
  createDeviceUnreachableError,
} from "../engine-errors.js";

/**
 * ATEM adapter implementation
 *
 * Implements EngineAdapter interface for Blackmagic Design ATEM switchers.
 * Uses the atem-connection library for protocol handling.
 *
 * Important: Macro IDs are 0-based (Slot 1 in ATEM UI = ID 0)
 * Example: First macro slot = ID 0, Second macro slot = ID 1, etc.
 */
export class AtemAdapter extends EventEmitter implements EngineAdapter {
  private atemConnection: Atem | null = null;
  private atemConnectedListener: (() => void) | null = null;
  private atemErrorListener: ((error: Error | string) => void) | null = null;
  private atemStateChangedListener: (() => void) | null = null;
  private atemDisconnectedListener: (() => void) | null = null;
  private connectSettled = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private state: EngineStateT = {
    status: "disconnected",
    macros: [],
    macroExecution: null,
    lastCompletedMacroExecution: null,
  };
  private readonly connectTimeoutMs = 10000; // 10 seconds timeout
  private readonly macroExecutionStore = new EngineMacroExecutionStore();
  private readonly pendingCompletionGraceMs = 750;
  private pendingCompletionTimeout: NodeJS.Timeout | null = null;

  /**
   * Connect to ATEM switcher
   */
  async connect(config: EngineConnectConfig): Promise<void> {
    if (config.type !== "atem") {
      throw new Error(
        `AtemAdapter only supports type "atem", got "${config.type}"`
      );
    }

    if (
      this.state.status === "connected" ||
      this.state.status === "connecting"
    ) {
      throw new Error("Engine is already connected or connecting");
    }

    this.setState({
      status: "connecting",
      ip: config.ip,
      port: config.port,
      type: config.type,
      macroExecution: null,
      lastCompletedMacroExecution: null,
    });

    // Create new ATEM connection
    const atem = new Atem({ debugBuffers: false });
    this.atemConnection = atem;

    let timeoutId: NodeJS.Timeout | null = null;
    this.connectSettled = false;
    this.connectResolve = null;
    this.connectReject = null;

    // Promise that resolves when "connected" event fires
    const connectionPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });

    // Set up connected handler
    const onConnected = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      this.setState({
        status: "connected",
        error: undefined,
        errorCode: undefined,
      });
      this.updateMacrosFromState();
      if (!this.connectSettled) {
        this.connectSettled = true;
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
      }
    };

    // Set up error handler
    const onAtemError = (error: Error | string) => {
      if (this.connectSettled) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        if (this.state.status === "connected") {
          this.setState({ error: errorMessage });
        }
        return;
      }

      if (!(error instanceof Error)) {
        return;
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      const errorMessage = error.message;

      // Determine error type from message
      let engineError: EngineError;
      if (
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("refused")
      ) {
        engineError = createConnectionRefusedError(config.ip, config.port);
      } else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("EHOSTUNREACH")
      ) {
        engineError = createDeviceUnreachableError(config.ip, config.port);
      } else if (
        errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("timeout")
      ) {
        engineError = createConnectionTimeoutError(
          config.ip,
          config.port,
          this.connectTimeoutMs
        );
      } else {
        engineError = createNetworkError(
          config.ip,
          config.port,
          error instanceof Error ? error : undefined
        );
      }

      this.setState({
        status: "error",
        error: engineError.message,
        errorCode: engineError.code,
      });
      this.connectSettled = true;
      this.connectReject?.(engineError);
      this.connectResolve = null;
      this.connectReject = null;
    };

    // Set up disconnected handler
    const onDisconnected = () => {
      if (this.state.status === "connected") {
        this.setState({
          status: "connecting",
          error: undefined,
          errorCode: undefined,
        });
      }
    };

    const onStateChanged = () => {
      this.updateMacrosFromState();
    };

    atem.on("connected", onConnected);
    atem.on("disconnected", onDisconnected);
    atem.on("stateChanged", onStateChanged);
    atem.on("error", onAtemError);
    this.atemConnectedListener = onConnected;
    this.atemErrorListener = onAtemError;
    this.atemDisconnectedListener = onDisconnected;
    this.atemStateChangedListener = onStateChanged;

    try {
      // Start connection
      void atem.connect(config.ip, config.port).catch((error: unknown) => {
        onAtemError(error instanceof Error ? error : new Error(String(error)));
      });

      // Set up timeout
      timeoutId = setTimeout(() => {
        const timeoutError = createConnectionTimeoutError(
          config.ip,
          config.port,
          this.connectTimeoutMs
        );
        this.setState({
          status: "error",
          error: timeoutError.message,
          errorCode: timeoutError.code,
        });
        this.connectSettled = true;
        this.connectReject?.(timeoutError);
        this.connectResolve = null;
        this.connectReject = null;
      }, this.connectTimeoutMs);

      // Wait for connection or timeout
      await connectionPromise;
    } catch (error: unknown) {
      // Clean up on error
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (atem) {
        this.detachAtemListeners(atem);
        await atem.destroy().catch(() => {});
      }
      this.atemConnection = null;

      // Re-throw as EngineError if not already
      if (error instanceof EngineError) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const engineError = new EngineError(
        EngineErrorCode.UNKNOWN_ERROR,
        errorMessage ||
          `Failed to connect to ATEM at ${config.ip}:${config.port}. Check if the device is reachable and the port is correct.`,
        { ip: config.ip, port: config.port }
      );
      throw engineError;
    }
  }

  /**
   * Disconnect from ATEM
   */
  async disconnect(): Promise<void> {
    this.clearPendingCompletionTimer();

    if (this.atemConnection) {
      try {
        this.detachAtemListeners(this.atemConnection);
        await this.atemConnection.destroy();
      } catch {
        // Ignore disconnect errors
      }
      this.atemConnection = null;
    }

    this.setState({
      status: "disconnected",
      macros: [],
      ip: undefined,
      port: undefined,
      type: undefined,
      error: undefined,
      errorCode: undefined,
      macroExecution: null,
      lastCompletedMacroExecution: null,
    });
    this.macroExecutionStore.reset();
  }

  private detachAtemListeners(atem: Atem): void {
    if (this.atemConnectedListener) {
      atem.removeListener("connected", this.atemConnectedListener);
      this.atemConnectedListener = null;
    }
    if (this.atemErrorListener) {
      atem.removeListener("error", this.atemErrorListener);
      this.atemErrorListener = null;
    }
    if (this.atemDisconnectedListener) {
      atem.removeListener("disconnected", this.atemDisconnectedListener);
      this.atemDisconnectedListener = null;
    }
    if (this.atemStateChangedListener) {
      atem.removeListener("stateChanged", this.atemStateChangedListener);
      this.atemStateChangedListener = null;
    }
  }

  /**
   * Get current connection status
   */
  getStatus(): EngineStatusT {
    return this.state.status;
  }

  /**
   * Get all available macros
   *
   * Note: Macro IDs are 0-based (Slot 1 = ID 0)
   */
  getMacros(): MacroT[] {
    return [...this.state.macros];
  }

  /**
   * Run a macro by ID
   *
   * @param id Macro ID (0-based: Slot 1 = ID 0)
   */
  async runMacro(id: number): Promise<void> {
    if (!this.atemConnection) {
      throw new Error("Engine is not connected");
    }

    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    try {
      const pendingExecution = this.macroExecutionStore.startPending({
        macroId: id,
        macroName: this.resolveMacroName(id),
        engineType: "atem",
      });
      this.updateMacrosFromState();
      await this.atemConnection.macroRun(id);
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
    } catch (error: unknown) {
      let errorMessage = "Unknown macro command failure";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error) {
        errorMessage = String(error);
      }

      this.macroExecutionStore.fail(errorMessage);
      this.updateMacrosFromState();
      throw new Error(
        `Failed to run macro ${id} (slot ${id + 1}): ${errorMessage}`
      );
    }
  }

  /**
   * Stop a macro by ID
   *
   * @param id Macro ID (0-based: Slot 1 = ID 0)
   */
  async stopMacro(id: number): Promise<void> {
    if (!this.atemConnection) {
      throw new Error("Engine is not connected");
    }

    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    try {
      this.macroExecutionStore.requestStop();
      this.setState({
        macroExecution: this.macroExecutionStore.getActiveExecution(),
        lastCompletedMacroExecution:
          this.macroExecutionStore.getLastCompletedExecution(),
      });
      await this.atemConnection.macroStop();
      // State update will come via stateChanged event
    } catch (error: unknown) {
      this.macroExecutionStore.clearStopRequest();
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to stop macro ${id} (slot ${id + 1}): ${errorMessage}`
      );
    }
  }

  /**
   * Subscribe to state changes
   */
  onStateChange(callback: (state: EngineStateT) => void): () => void {
    this.on("stateChange", callback);
    return () => {
      this.off("stateChange", callback);
    };
  }

  /**
   * Update state and emit change event
   */
  private setState(updates: Partial<EngineStateT>): void {
    this.state = {
      ...this.state,
      ...updates,
      lastUpdate: Date.now(),
    };
    this.emit("stateChange", this.getState());
  }

  /**
   * Get current state
   */
  getState(): EngineStateT {
    return { ...this.state };
  }

  private clearPendingCompletionTimer(): void {
    if (!this.pendingCompletionTimeout) {
      return;
    }

    clearTimeout(this.pendingCompletionTimeout);
    this.pendingCompletionTimeout = null;
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
      this.updateMacrosFromState();
    }, this.pendingCompletionGraceMs);
    this.pendingCompletionTimeout.unref?.();
  }

  /**
   * Update macros from ATEM state
   */
  private updateMacrosFromState(): void {
    if (!this.atemConnection || !this.atemConnection.state) {
      return;
    }

    const macros: MacroT[] = [];
    const macroPool = this.atemConnection.state.macro;
    const activeRunningMacroId = macroPool?.macroPlayer?.isRunning
      ? macroPool.macroPlayer.macroIndex
      : null;
    const activeWaitingMacroId = macroPool?.macroPlayer?.isWaiting
      ? macroPool.macroPlayer.macroIndex
      : null;
    const activeRecordingMacroId = macroPool?.macroRecorder?.isRecording
      ? macroPool.macroRecorder.macroIndex
      : null;
    const activeExecution = this.syncMacroExecutionFromState(
      macroPool?.macroProperties,
      activeRunningMacroId,
      activeWaitingMacroId,
      macroPool?.macroPlayer?.loop ?? false
    );

    if (macroPool && macroPool.macroProperties) {
      for (let i = 0; i < macroPool.macroProperties.length; i++) {
        const macroProp = macroPool.macroProperties[i];
        if (macroProp && macroProp.name) {
          // Determine macro status
          let status: MacroT["status"] = "idle";
          if (activeRecordingMacroId === i) {
            status = "recording";
          } else if (activeWaitingMacroId === i) {
            status = "waiting";
          } else if (activeRunningMacroId === i) {
            status = "running";
          } else if (
            activeExecution?.status === "pending" &&
            activeExecution.macroId === i
          ) {
            status = "pending";
          }

          macros.push({
            id: i, // 0-based ID (Slot 1 = ID 0)
            name: macroProp.name || `Macro ${i + 1}`,
            status,
          });
        }
      }
    }

    this.setState({
      macros,
      macroExecution: this.macroExecutionStore.getActiveExecution(),
      lastCompletedMacroExecution:
        this.macroExecutionStore.getLastCompletedExecution(),
    });
  }

  private resolveMacroName(id: number): string | undefined {
    return this.atemConnection?.state?.macro?.macroProperties?.[id]?.name;
  }

  private syncMacroExecutionFromState(
    macroProperties: Array<{ name?: string } | undefined> | undefined,
    activeRunningMacroId: number | null,
    activeWaitingMacroId: number | null,
    loop: boolean
  ): MacroExecutionT | null {
    if (activeWaitingMacroId !== null) {
      this.clearPendingCompletionTimer();
      return this.macroExecutionStore.markDeviceState({
        macroId: activeWaitingMacroId,
        macroName: macroProperties?.[activeWaitingMacroId]?.name,
        engineType: "atem",
        status: "waiting",
        loop,
      });
    }

    if (activeRunningMacroId !== null) {
      this.clearPendingCompletionTimer();
      return this.macroExecutionStore.markDeviceState({
        macroId: activeRunningMacroId,
        macroName: macroProperties?.[activeRunningMacroId]?.name,
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
