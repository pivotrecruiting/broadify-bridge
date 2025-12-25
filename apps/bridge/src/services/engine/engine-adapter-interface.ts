import type { EngineStatusT, MacroT, EngineStateT } from "../engine-types.js";

/**
 * Engine connection configuration
 */
export interface EngineConnectConfig {
  type: "atem" | "tricaster" | "vmix";
  ip: string;
  port: number;
}

/**
 * Engine adapter interface
 *
 * Defines the contract for engine adapters (ATEM, Tricaster, vMix, etc.)
 * Each adapter implements this interface to provide engine-specific functionality.
 */
export interface EngineAdapter {
  /**
   * Connect to the engine
   * @param config Connection configuration (type, ip, port)
   * @throws Error if connection fails
   */
  connect(config: EngineConnectConfig): Promise<void>;

  /**
   * Disconnect from the engine
   */
  disconnect(): Promise<void>;

  /**
   * Get current connection status
   */
  getStatus(): EngineStatusT;

  /**
   * Get all available macros
   */
  getMacros(): MacroT[];

  /**
   * Run a macro by ID
   * @param id Macro ID (0-based for ATEM)
   * @throws Error if macro cannot be run
   */
  runMacro(id: number): Promise<void>;

  /**
   * Stop a macro by ID
   * @param id Macro ID (0-based for ATEM)
   * @throws Error if macro cannot be stopped
   */
  stopMacro(id: number): Promise<void>;

  /**
   * Subscribe to state changes
   * @param callback Function called when state changes
   * @returns Unsubscribe function
   */
  onStateChange(callback: (state: EngineStateT) => void): () => void;
}

