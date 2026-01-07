/**
 * Runtime configuration state
 * 
 * Stores configuration (outputs, engine) that is set via POST /config
 * This is separate from the startup config (host, port, mode)
 */
export interface RuntimeConfig {
  outputs?: {
    output1: string;
    output2: string;
  };
  engine?: {
    type: "atem" | "tricaster" | "vmix";
    ip: string;
    port: number;
  };
}

/**
 * Runtime config state
 */
class RuntimeConfigService {
  private config: RuntimeConfig | null = null;
  private state: "idle" | "configured" | "active" = "idle";

  /**
   * Get current runtime config
   */
  getConfig(): RuntimeConfig | null {
    return this.config;
  }

  /**
   * Get current state
   */
  getState(): "idle" | "configured" | "active" {
    return this.state;
  }

  /**
   * Check if outputs are configured
   */
  hasOutputs(): boolean {
    return !!(
      this.config?.outputs?.output1 && this.config?.outputs?.output2
    );
  }

  /**
   * Check if engine is configured
   */
  hasEngine(): boolean {
    return !!this.config?.engine;
  }

  /**
   * Get engine configuration
   */
  getEngineConfig(): RuntimeConfig["engine"] {
    return this.config?.engine || undefined;
  }

  /**
   * Set runtime config
   */
  setConfig(config: RuntimeConfig): void {
    this.config = config;
    
    // Update state based on config
    if (config.outputs || config.engine) {
      this.state = "configured";
    } else {
      this.state = "idle";
    }
  }

  /**
   * Set state to active (when controllers are opened)
   */
  setActive(): void {
    if (this.config && (this.config.outputs || this.config.engine)) {
      this.state = "active";
    }
  }

  /**
   * Clear runtime config
   */
  clear(): void {
    this.config = null;
    this.state = "idle";
  }
}

/**
 * Singleton instance
 */
export const runtimeConfig = new RuntimeConfigService();
