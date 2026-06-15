import type {
  EngineAdapter,
  EngineConnectConfig,
  EnsureVmixBrowserInputConfigT,
  EnsureVmixBrowserInputResultT,
  VmixActionConfigT,
  VmixActionResultT,
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
import { VmixHttpClient, type VmixInputSummaryT } from "./vmix-http-client.js";

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
   * Ensure a named browser input exists in vMix and points to the requested URL.
   */
  async ensureVmixBrowserInput(
    config: EnsureVmixBrowserInputConfigT
  ): Promise<EnsureVmixBrowserInputResultT> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    const url = config.url.trim();
    const inputName = config.inputName.trim();

    if (!url) {
      throw new Error("Browser input URL is required");
    }

    if (!inputName) {
      throw new Error("Browser input name is required");
    }

    try {
      if (!this.client) {
        throw new Error("vMix client is not initialized");
      }

      const existingInputs = await this.client.getInputs();
      const matchingInput = findBrowserInputByName(existingInputs, inputName);

      if (matchingInput) {
        await this.client.setInputName(matchingInput.number, inputName);
        await this.client.navigateBrowserInput(matchingInput.number, url);

        return {
          action: "updated_existing",
          inputNumber: matchingInput.number,
          inputKey: matchingInput.key,
          inputName,
          browserInputUrl: url,
        };
      }

      const existingInputIds = new Set(
        existingInputs.map((input) => getStableInputId(input)),
      );

      await this.client.addBrowserInput(url);

      const inputsAfterCreate = await this.client.getInputs();
      const createdInput =
        findNewBrowserInput(inputsAfterCreate, existingInputIds) ??
        findBrowserInputByName(inputsAfterCreate, inputName) ??
        findLatestBrowserInput(inputsAfterCreate);

      if (!createdInput) {
        throw new Error(
          "vMix created a browser input, but the bridge could not identify it via API",
        );
      }

      await this.client.setInputName(createdInput.number, inputName);
      await this.client.navigateBrowserInput(createdInput.number, url);

      return {
        action: "created",
        inputNumber: createdInput.number,
        inputKey: createdInput.key,
        inputName,
        browserInputUrl: url,
      };
    } catch (error: unknown) {
      this.handleActionFailure(error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to ensure vMix browser input: ${errorMessage}`
      );
    }
  }

  /**
   * Execute a documented vMix action through the HTTP API.
   */
  async runVmixAction(config: VmixActionConfigT): Promise<VmixActionResultT> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    const scriptName = config.scriptName.trim();
    if (!scriptName) {
      throw new Error("vMix script name is required");
    }

    try {
      if (!this.client) {
        throw new Error("vMix client is not initialized");
      }

      if (config.actionType === "script_start") {
        await this.client.runScriptStart(scriptName);
        return {
          actionType: "script_start",
          scriptName,
          executedFunction: "ScriptStart",
        };
      }

      await this.client.runScriptStop(scriptName);
      return {
        actionType: "script_stop",
        scriptName,
        executedFunction: "ScriptStop",
      };
    } catch (error: unknown) {
      this.handleActionFailure(error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to execute vMix action: ${errorMessage}`);
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

    if (
      error.code === EngineErrorCode.PROTOCOL_ERROR ||
      error.code === EngineErrorCode.UNKNOWN_ERROR
    ) {
      this.setState({
        error: error.message,
      });
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

const isBrowserInputType = (type: string | null): boolean => {
  return typeof type === "string" && type.toLowerCase().includes("browser");
};

const findBrowserInputByName = (
  inputs: VmixInputSummaryT[],
  inputName: string
): VmixInputSummaryT | null => {
  const normalizedName = inputName.trim().toLowerCase();
  return (
    inputs.find((input) => {
      if (!isBrowserInputType(input.type)) {
        return false;
      }

      const title = input.title.trim().toLowerCase();
      const shortTitle = input.shortTitle?.trim().toLowerCase() ?? "";
      return title === normalizedName || shortTitle === normalizedName;
    }) ?? null
  );
};

const findNewBrowserInput = (
  inputs: VmixInputSummaryT[],
  existingInputIds: Set<string>
): VmixInputSummaryT | null => {
  const candidates = inputs.filter(
    (input) =>
      isBrowserInputType(input.type) &&
      !existingInputIds.has(getStableInputId(input)),
  );
  return candidates.sort((left, right) => right.number - left.number)[0] ?? null;
};

const findLatestBrowserInput = (
  inputs: VmixInputSummaryT[]
): VmixInputSummaryT | null => {
  return (
    inputs
      .filter((input) => isBrowserInputType(input.type))
      .sort((left, right) => right.number - left.number)[0] ?? null
  );
};

const getStableInputId = (input: VmixInputSummaryT): string => {
  return input.key ? `key:${input.key}` : `number:${input.number}`;
};
