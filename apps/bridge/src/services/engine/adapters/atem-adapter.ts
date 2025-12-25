import { Atem } from "atem-connection";
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
  private state: EngineStateT = {
    status: "disconnected",
    macros: [],
  };

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
    });

    try {
      // Create new ATEM connection
      const atem = new Atem({ debugBuffers: false });
      this.atemConnection = atem;

      // Set up event handlers
      atem.on("connected", () => {
        this.setState({ status: "connected" });
        this.updateMacrosFromState();
      });

      atem.on("disconnected", () => {
        if (this.state.status === "connected") {
          this.setState({ status: "disconnected" });
        }
      });

      atem.on("stateChanged", () => {
        this.updateMacrosFromState();
      });

      atem.on("error", (error: Error | string) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.setState({
          status: "error",
          error: errorMessage || "ATEM connection error occurred",
        });
      });

      // Connect to ATEM
      await atem.connect(config.ip, config.port);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const detailedError =
        errorMessage ||
        `Failed to connect to ATEM at ${config.ip}:${config.port}. Check if the device is reachable and the port is correct.`;
      this.setState({
        status: "error",
        error: detailedError,
      });
      throw new Error(detailedError);
    }
  }

  /**
   * Disconnect from ATEM
   */
  async disconnect(): Promise<void> {
    if (this.atemConnection) {
      try {
        await this.atemConnection.disconnect();
      } catch (error) {
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
    });
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
      await this.atemConnection.macroRun(id);
      // State update will come via stateChanged event
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
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
      // Note: atem-connection might not have macroStop method
      // Check if method exists
      if (typeof (this.atemConnection as any).macroStop === "function") {
        await (this.atemConnection as any).macroStop(id);
      } else {
        // Fallback: Try to stop by running macro 0 or using stop command
        // This is a workaround if macroStop doesn't exist
        throw new Error("macroStop method not available in atem-connection");
      }
      // State update will come via stateChanged event
    } catch (error: unknown) {
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

  /**
   * Update macros from ATEM state
   */
  private updateMacrosFromState(): void {
    if (!this.atemConnection || !this.atemConnection.state) {
      return;
    }

    const macros: MacroT[] = [];
    const macroPool = this.atemConnection.state.macro;

    if (macroPool && macroPool.macroProperties) {
      for (let i = 0; i < macroPool.macroProperties.length; i++) {
        const macroProp = macroPool.macroProperties[i];
        if (macroProp && macroProp.name) {
          // Determine macro status
          let status: "idle" | "running" | "recording" = "idle";
          if (macroPool.macroRecorder) {
            const recorder = macroPool.macroRecorder;
            if (recorder.isRecording && recorder.macroIndex === i) {
              status = "recording";
            }
          }
          if (macroPool.macroPlayer) {
            const player = macroPool.macroPlayer;
            // Check if macro is playing - API might use different property names
            if (
              (player as any).isPlaying !== undefined &&
              (player as any).isPlaying &&
              (player as any).macroIndex === i
            ) {
              status = "running";
            } else if (
              (player as any).isRunning !== undefined &&
              (player as any).isRunning &&
              (player as any).macroIndex === i
            ) {
              status = "running";
            } else if (
              typeof (player as any).macroIndex === "number" &&
              (player as any).macroIndex === i
            ) {
              // If macroIndex matches, assume it's running
              status = "running";
            }
          }

          macros.push({
            id: i, // 0-based ID (Slot 1 = ID 0)
            name: macroProp.name || `Macro ${i + 1}`,
            status,
          });
        }
      }
    }

    this.setState({ macros });
  }
}
