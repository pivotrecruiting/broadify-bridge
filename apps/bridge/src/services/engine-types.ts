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
export type MacroStatusT =
  | "idle"
  | "pending"
  | "running"
  | "waiting"
  | "recording";

/**
 * Macro definition
 */
export type MacroT = {
  id: number;
  name: string;
  status: MacroStatusT;
};

export type MacroExecutionStatusT =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "stopped"
  | "failed";

export type MacroExecutionT = {
  runId: string;
  macroId: number;
  macroName?: string;
  engineType: "atem" | "tricaster" | "vmix";
  status: MacroExecutionStatusT;
  triggeredAt: number;
  acceptedAt?: number | null;
  startedAt: number | null;
  waitingAt: number | null;
  completedAt: number | null;
  actualDurationMs: number | null;
  loop: boolean;
  stopRequestedAt?: number | null;
  error?: string;
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
  macroExecution?: MacroExecutionT | null;
  lastCompletedMacroExecution?: MacroExecutionT | null;
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
