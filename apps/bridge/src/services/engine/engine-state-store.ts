import type { EngineStateT, EngineStatusT } from "../engine-types.js";

/**
 * Engine state store
 *
 * Manages engine state independently from runtimeConfig and DeviceCache.
 * This ensures the engine layer is completely decoupled from other systems.
 */
export class EngineStateStore {
  private state: EngineStateT = {
    status: "disconnected",
    macros: [],
  };
  private connectedSince: number | null = null;
  private lastError: string | null = null;

  /**
   * Get current engine state
   */
  getState(): EngineStateT {
    return { ...this.state };
  }

  /**
   * Update engine state
   */
  setState(updates: Partial<EngineStateT>): void {
    this.state = {
      ...this.state,
      ...updates,
      lastUpdate: Date.now(),
    };

    // Track connection timestamp
    if (updates.status === "connected" && !this.connectedSince) {
      this.connectedSince = Date.now();
    }

    // Clear connection timestamp on disconnect
    if (updates.status === "disconnected" || updates.status === "error") {
      this.connectedSince = null;
    }

    // Track errors
    if (updates.error) {
      this.lastError = updates.error;
    } else if (updates.status === "connected") {
      // Clear error on successful connection
      this.lastError = null;
    }
  }

  /**
   * Get connection timestamp
   */
  getConnectedSince(): number | null {
    return this.connectedSince;
  }

  /**
   * Get last error message
   */
  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Reset state to disconnected
   */
  reset(): void {
    this.state = {
      status: "disconnected",
      macros: [],
    };
    this.connectedSince = null;
    this.lastError = null;
  }
}

