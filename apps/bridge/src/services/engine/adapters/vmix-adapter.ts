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
  createConnectionTimeoutError,
  createConnectionRefusedError,
  createNetworkError,
  createDeviceUnreachableError,
} from "../engine-errors.js";

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
  private readonly connectTimeoutMs = 10000; // 10 seconds timeout
  private readonly requestTimeoutMs = 5000; // 5 seconds for individual requests
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly pollingIntervalMs = 2000; // Poll every 2 seconds
  private baseUrl: string = "";

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

    this.baseUrl = `http://${config.ip}:${config.port}`;

    try {
      // Test connection by checking version
      const versionResponse = await this.makeRequest("GetVersion");
      if (!versionResponse.ok) {
        throw new Error(
          `vMix API returned status ${versionResponse.status}: ${versionResponse.statusText}`
        );
      }

      // Connection successful
      this.setState({ status: "connected" });

      // Load initial macros
      await this.updateMacrosFromApi();

      // Start polling for status updates
      this.startPolling();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Determine error type
      let engineError: EngineError;
      if (
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("refused") ||
        errorMessage.includes("ECONNRESET")
      ) {
        engineError = createConnectionRefusedError(config.ip, config.port);
      } else if (
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("EHOSTUNREACH") ||
        errorMessage.includes("getaddrinfo")
      ) {
        engineError = createDeviceUnreachableError(config.ip, config.port);
      } else if (
        errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("timeout") ||
        errorMessage.includes("aborted")
      ) {
        engineError = createConnectionTimeoutError(
          config.ip,
          config.port,
          this.connectTimeoutMs
        );
      } else if (error instanceof EngineError) {
        engineError = error;
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
      });
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

    this.baseUrl = "";
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
      const response = await this.makeRequest("MacroStart", { Input: id });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `vMix API returned status ${response.status}: ${text || response.statusText}`
        );
      }

      // Update macros after running (to reflect status change)
      await this.updateMacrosFromApi();
    } catch (error: unknown) {
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
      const response = await this.makeRequest("MacroStop", { Input: id });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `vMix API returned status ${response.status}: ${text || response.statusText}`
        );
      }

      // Update macros after stopping
      await this.updateMacrosFromApi();
    } catch (error: unknown) {
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
   * Make HTTP request to vMix API
   */
  private async makeRequest(
    functionName: string,
    params?: Record<string, string | number>
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api`);
    url.searchParams.set("Function", functionName);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs
    );

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Accept": "application/xml, application/json, text/xml, */*",
        },
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Update macros from vMix API
   */
  private async updateMacrosFromApi(): Promise<void> {
    if (this.state.status !== "connected") {
      return;
    }

    try {
      const response = await this.makeRequest("GetMacros");
      if (!response.ok) {
        // If request fails, don't update macros but don't throw
        return;
      }

      const text = await response.text();
      const macros = this.parseMacrosFromResponse(text);

      this.setState({ macros });
    } catch (error: unknown) {
      // Log error but don't throw - polling will retry
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[VmixAdapter] Failed to update macros: ${errorMessage}`);
    }
  }

  /**
   * Parse macros from vMix API response
   *
   * vMix API returns XML or JSON depending on format parameter.
   * We try to parse as XML first, then fall back to JSON.
   */
  private parseMacrosFromResponse(responseText: string): MacroT[] {
    const macros: MacroT[] = [];

    try {
      // Try to parse as XML
      // vMix XML format: <vmix><macros><macro number="1" name="Macro 1" running="False"/></macros></vmix>
      if (responseText.includes("<vmix>") || responseText.includes("<macros>")) {
        // Simple XML parsing (for MVP - could use fast-xml-parser later if needed)
        const macroMatches = responseText.matchAll(
          /<macro\s+number="(\d+)"\s+name="([^"]*)"\s+running="([^"]*)"/g
        );

        for (const match of macroMatches) {
          const id = parseInt(match[1], 10);
          const name = match[2] || `Macro ${id}`;
          const running = match[3]?.toLowerCase() === "true";

          macros.push({
            id,
            name,
            status: running ? "running" : "idle",
          });
        }
      } else {
        // Try to parse as JSON
        const json = JSON.parse(responseText);
        if (json.macros && Array.isArray(json.macros)) {
          for (const macro of json.macros) {
            if (macro.number && macro.name) {
              macros.push({
                id: parseInt(String(macro.number), 10),
                name: String(macro.name),
                status: macro.running === true ? "running" : "idle",
              });
            }
          }
        }
      }
    } catch (error: unknown) {
      // If parsing fails, return empty array
      console.error(
        `[VmixAdapter] Failed to parse macros response: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return macros;
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

