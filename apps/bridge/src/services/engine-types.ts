/**
 * Engine connection status
 */
export type EngineStatusT =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/**
 * Macro execution status
 */
export type MacroStatusT = "idle" | "running" | "recording";

/**
 * Macro definition
 */
export type MacroT = {
  id: number;
  name: string;
  status: MacroStatusT;
};

/**
 * Engine state information
 */
export type EngineStateT = {
  status: EngineStatusT;
  type?: "atem" | "tricaster" | "vmix";
  ip?: string;
  port?: number;
  macros: MacroT[];
  lastUpdate?: number;
  error?: string;
};

/**
 * Engine configuration from runtime config
 */
export type EngineConfigT = {
  type: "atem" | "tricaster" | "vmix";
  ip: string;
  port: number;
};

