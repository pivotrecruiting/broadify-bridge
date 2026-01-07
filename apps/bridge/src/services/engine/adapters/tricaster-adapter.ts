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
  createConnectionTimeoutError,
  createConnectionRefusedError,
  createNetworkError,
  createDeviceUnreachableError,
} from "../engine-errors.js";

/**
 * Tricaster adapter implementation
 *
 * Implements EngineAdapter interface for NewTek Tricaster systems.
 * Uses HTTP REST API (Port 8080) for communication.
 *
 * Important: Macro IDs are typically 1-based (Macro 1 = ID 1)
 * but may vary depending on Tricaster model and API version.
 */
export class TricasterAdapter extends EventEmitter implements EngineAdapter {
  private state: EngineStateT = {
    status: "disconnected",
    macros: [],
  };
  private readonly connectTimeoutMs = 10000; // 10 seconds timeout
  private readonly requestTimeoutMs = 5000; // 5 seconds for individual requests
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly pollingIntervalMs = 2000; // Poll every 2 seconds
  private baseUrl: string = "";
  private authHeader: string | null = null;

  /**
   * Connect to Tricaster system
   */
  async connect(config: EngineConnectConfig): Promise<void> {
    if (config.type !== "tricaster") {
      throw new Error(
        `TricasterAdapter only supports type "tricaster", got "${config.type}"`
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

    // Note: Authentication can be added later if needed
    // For now, we assume no authentication is required
    // If auth is needed, it can be passed via config or environment variables

    try {
      // Test connection by checking status
      const statusResponse = await this.makeRequest("GET", "/api/status");
      if (!statusResponse.ok) {
        // If status endpoint doesn't exist, try a simpler endpoint
        const testResponse = await this.makeRequest("GET", "/api");
        if (!testResponse.ok && testResponse.status !== 404) {
          throw new Error(
            `Tricaster API returned status ${testResponse.status}: ${testResponse.statusText}`
          );
        }
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
   * Disconnect from Tricaster
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
    this.authHeader = null;
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
   * Note: Macro IDs are typically 1-based (Macro 1 = ID 1)
   */
  getMacros(): MacroT[] {
    return [...this.state.macros];
  }

  /**
   * Run a macro by ID
   *
   * @param id Macro ID (typically 1-based: Macro 1 = ID 1)
   */
  async runMacro(id: number): Promise<void> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    if (id < 1) {
      throw new Error(
        `Invalid macro ID: ${id}. Tricaster macro IDs typically start at 1.`
      );
    }

    try {
      // Try different API endpoint formats
      let response: Response | null = null;
      let lastError: Error | null = null;

      // Try POST /api/macro/{id}/run
      try {
        response = await this.makeRequest("POST", `/api/macro/${id}/run`);
        if (response.ok) {
          await this.updateMacrosFromApi();
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Try POST /api/macros/{id}/run
      try {
        response = await this.makeRequest("POST", `/api/macros/${id}/run`);
        if (response.ok) {
          await this.updateMacrosFromApi();
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Try POST /api/macro/run with body
      try {
        response = await this.makeRequest("POST", "/api/macro/run", {
          id: id,
        });
        if (response.ok) {
          await this.updateMacrosFromApi();
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // If all attempts failed, throw error
      const errorText = response
        ? await response.text().catch(() => response.statusText)
        : lastError?.message || "Unknown error";
      throw new Error(`Failed to run macro ${id}: ${errorText}`);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to run macro ${id}: ${errorMessage}`);
    }
  }

  /**
   * Stop a macro by ID
   *
   * @param id Macro ID (typically 1-based: Macro 1 = ID 1)
   */
  async stopMacro(id: number): Promise<void> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    if (id < 1) {
      throw new Error(
        `Invalid macro ID: ${id}. Tricaster macro IDs typically start at 1.`
      );
    }

    try {
      // Try different API endpoint formats
      let response: Response | null = null;
      let lastError: Error | null = null;

      // Try POST /api/macro/{id}/stop
      try {
        response = await this.makeRequest("POST", `/api/macro/${id}/stop`);
        if (response.ok) {
          await this.updateMacrosFromApi();
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Try POST /api/macros/{id}/stop
      try {
        response = await this.makeRequest("POST", `/api/macros/${id}/stop`);
        if (response.ok) {
          await this.updateMacrosFromApi();
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Try POST /api/macro/stop with body
      try {
        response = await this.makeRequest("POST", "/api/macro/stop", {
          id: id,
        });
        if (response.ok) {
          await this.updateMacrosFromApi();
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // If all attempts failed, throw error
      const errorText = response
        ? await response.text().catch(() => response.statusText)
        : lastError?.message || "Unknown error";
      throw new Error(`Failed to stop macro ${id}: ${errorText}`);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to stop macro ${id}: ${errorMessage}`);
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
   * Make HTTP request to Tricaster API
   */
  private async makeRequest(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs
    );

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers,
        body: body ? JSON.stringify(body) : undefined,
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
   * Update macros from Tricaster API
   */
  private async updateMacrosFromApi(): Promise<void> {
    if (this.state.status !== "connected") {
      return;
    }

    try {
      // Try different API endpoint formats
      let response: Response | null = null;

      // Try GET /api/macros
      try {
        response = await this.makeRequest("GET", "/api/macros");
        if (response.ok) {
          const macros = await this.parseMacrosFromResponse(response);
          this.setState({ macros });
          return;
        }
      } catch {
        // Continue to next attempt
      }

      // Try GET /api/macro
      try {
        response = await this.makeRequest("GET", "/api/macro");
        if (response.ok) {
          const macros = await this.parseMacrosFromResponse(response);
          this.setState({ macros });
          return;
        }
      } catch {
        // Continue to next attempt
      }

      // If both fail, don't update macros but don't throw
      // (API might not support macro listing)
    } catch (error: unknown) {
      // Log error but don't throw - polling will retry
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[TricasterAdapter] Failed to update macros: ${errorMessage}`
      );
    }
  }

  /**
   * Parse macros from Tricaster API response
   */
  private async parseMacrosFromResponse(response: Response): Promise<MacroT[]> {
    const macros: MacroT[] = [];

    try {
      const json = await response.json();

      // Handle different response formats
      if (Array.isArray(json)) {
        // Array of macros: [{ id: 1, name: "Macro 1", running: false }, ...]
        for (const macro of json) {
          if (macro.id || macro.number) {
            macros.push({
              id: parseInt(String(macro.id || macro.number), 10),
              name: String(macro.name || `Macro ${macro.id || macro.number}`),
              status: macro.running === true ? "running" : "idle",
            });
          }
        }
      } else if (json.macros && Array.isArray(json.macros)) {
        // Object with macros array: { macros: [...] }
        for (const macro of json.macros) {
          if (macro.id || macro.number) {
            macros.push({
              id: parseInt(String(macro.id || macro.number), 10),
              name: String(macro.name || `Macro ${macro.id || macro.number}`),
              status: macro.running === true ? "running" : "idle",
            });
          }
        }
      } else if (json.macro && Array.isArray(json.macro)) {
        // Object with macro array: { macro: [...] }
        for (const macro of json.macro) {
          if (macro.id || macro.number) {
            macros.push({
              id: parseInt(String(macro.id || macro.number), 10),
              name: String(macro.name || `Macro ${macro.id || macro.number}`),
              status: macro.running === true ? "running" : "idle",
            });
          }
        }
      }
    } catch (error: unknown) {
      // If parsing fails, return empty array
      console.error(
        `[TricasterAdapter] Failed to parse macros response: ${
          error instanceof Error ? error.message : String(error)
        }`
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
            `[TricasterAdapter] Polling error: ${
              error instanceof Error ? error.message : String(error)
            }`
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
