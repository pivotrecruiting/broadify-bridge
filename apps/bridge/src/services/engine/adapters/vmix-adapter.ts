import type {
  EngineAdapter,
  EngineConnectConfig,
} from "../engine-adapter-interface.js";
import type {
  EngineStatusT,
  MacroT,
  EngineStateT,
} from "../../engine-types.js";
import { EventEmitter } from "events";
import {
  EngineError,
  EngineErrorCode,
} from "../engine-errors.js";
import { VmixHttpClient } from "./vmix-http-client.js";

/**
 * vMix adapter implementation
 *
 * Implements EngineAdapter interface for vMix software switcher.
 * Uses HTTP REST API (Port 8088) for communication.
 *
 * Important: Macro IDs are 1-based (Macro 1 = ID 1, Macro 2 = ID 2, etc.)
 * This differs from ATEM which uses 0-based IDs.
 */
export class VmixAdapter extends EventEmitter implements EngineAdapter {
  private state: EngineStateT = {
    status: "disconnected",
    macros: [],
  };
  private readonly requestTimeoutMs = 5000; // 5 seconds for individual requests
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly pollingIntervalMs = 2000; // Poll every 2 seconds
  private readonly maxPollingFailures = 2;
  private consecutivePollingFailures = 0;
  private client: VmixHttpClient | null = null;

  /**
   * Connect to vMix instance
   */
  async connect(config: EngineConnectConfig): Promise<void> {
    if (config.type !== "vmix") {
      throw new Error(
        `VmixAdapter only supports type "vmix", got "${config.type}"`
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
    });
    this.consecutivePollingFailures = 0;
    this.client = new VmixHttpClient({
      ip: config.ip,
      port: config.port,
      requestTimeoutMs: this.requestTimeoutMs,
    });

    try {
      await this.client.getVersion();

      // Connection successful
      this.setState({
        status: "connected",
        error: undefined,
      });

      // Load initial macros
      await this.updateMacrosFromApi({ failOnError: true });

      // Start polling for status updates
      this.startPolling();
    } catch (error: unknown) {
      const engineError =
        error instanceof EngineError
          ? error
          : new EngineError(
              EngineErrorCode.UNKNOWN_ERROR,
              error instanceof Error ? error.message : String(error),
              { ip: config.ip, port: config.port },
            );

      this.setState({
        status: "error",
        error: engineError.message,
      });
      this.stopPolling();
      this.client = null;
      throw engineError;
    }
  }

  /**
   * Disconnect from vMix
   */
  async disconnect(): Promise<void> {
    // Stop polling
    this.stopPolling();

    this.setState({
      status: "disconnected",
      macros: [],
      ip: undefined,
      port: undefined,
      type: undefined,
      error: undefined,
    });
    this.consecutivePollingFailures = 0;
    this.client = null;
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
   * Note: Macro IDs are 1-based (Macro 1 = ID 1)
   */
  getMacros(): MacroT[] {
    return [...this.state.macros];
  }

  /**
   * Run a macro by ID
   *
   * @param id Macro ID (1-based: Macro 1 = ID 1)
   */
  async runMacro(id: number): Promise<void> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    if (id < 1) {
      throw new Error(`Invalid macro ID: ${id}. vMix macro IDs start at 1.`);
    }

    try {
      if (!this.client) {
        throw new Error("vMix client is not initialized");
      }
      await this.client.startMacro(id);
      await this.updateMacrosFromApi();
    } catch (error: unknown) {
      this.handleActionFailure(error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to run macro ${id}: ${errorMessage}`
      );
    }
  }

  /**
   * Stop a macro by ID
   *
   * @param id Macro ID (1-based: Macro 1 = ID 1)
   */
  async stopMacro(id: number): Promise<void> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    if (id < 1) {
      throw new Error(`Invalid macro ID: ${id}. vMix macro IDs start at 1.`);
    }

    try {
      if (!this.client) {
        throw new Error("vMix client is not initialized");
      }
      await this.client.stopMacro(id);
      await this.updateMacrosFromApi();
    } catch (error: unknown) {
      this.handleActionFailure(error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to stop macro ${id}: ${errorMessage}`
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
   * Update macros from vMix API
   */
  private async updateMacrosFromApi(
    options?: {
      failOnError?: boolean;
    }
  ): Promise<void> {
    if (this.state.status !== "connected" || !this.client) {
      return;
    }

    try {
      const macros = await this.client.getMacros();
      this.consecutivePollingFailures = 0;
      this.setState({
        macros,
        error: undefined,
      });
    } catch (error: unknown) {
      if (options?.failOnError) {
        throw error;
      }

      this.consecutivePollingFailures += 1;
      if (this.consecutivePollingFailures >= this.maxPollingFailures) {
        this.stopPolling();
        this.setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  /**
   * Start polling for status updates
   */
  private startPolling(): void {
    this.stopPolling(); // Clear any existing polling

    this.pollingInterval = setInterval(() => {
      if (this.state.status === "connected") {
        this.updateMacrosFromApi().catch((error) => {
          console.error(
            `[VmixAdapter] Polling error: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      } else {
        // Stop polling if not connected
        this.stopPolling();
      }
    }, this.pollingIntervalMs);
  }

  /**
   * Stop polling for status updates
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private handleActionFailure(error: unknown): void {
    if (!(error instanceof EngineError)) {
      return;
    }

    this.stopPolling();
    this.setState({
      status: "error",
      error: error.message,
    });
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
}
