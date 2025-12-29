import { engineAdapter } from "./engine-adapter.js";
import { deviceCache } from "./device-cache.js";
import { runtimeConfig } from "./runtime-config.js";
import type { EngineStateT } from "./engine-types.js";
import type { BridgeOutputsT, DeviceDescriptorT } from "../types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Relay command types
 */
export type RelayCommand =
  | "get_status"
  | "list_outputs"
  | "engine_connect"
  | "engine_disconnect"
  | "engine_get_status"
  | "engine_get_macros"
  | "engine_run_macro"
  | "engine_stop_macro";

/**
 * Relay command payload
 */
export interface RelayCommandPayload {
  command: RelayCommand;
  payload?: Record<string, unknown>;
}

/**
 * Relay command result
 */
export interface RelayCommandResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Get version from package.json
 */
function getVersion(): string {
  try {
    const packagePath = join(__dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/**
 * Transform Device/Port model to UI-compatible output format
 */
function transformDevicesToOutputs(
  devices: DeviceDescriptorT[]
): BridgeOutputsT {
  const output1Devices: Array<{
    id: string;
    name: string;
    type: "decklink" | "capture" | "connection";
    available: boolean;
  }> = [];
  const output2Devices: Array<{
    id: string;
    name: string;
    type: "decklink" | "capture" | "connection";
    available: boolean;
  }> = [];
  const connectionTypesSeen = new Set<string>();

  // Process each device
  for (const device of devices) {
    // Add device to output1 (Hardware Devices)
    const hasOutputPort = device.ports.some(
      (port) =>
        port.direction === "output" || port.direction === "bidirectional"
    );

    if (hasOutputPort) {
      output1Devices.push({
        id: device.id,
        name: device.displayName,
        type: device.type === "decklink" ? "decklink" : "capture",
        available:
          device.status.present && device.status.ready && !device.status.inUse,
      });
    }

    // Collect connection types from ports (for output2)
    for (const port of device.ports) {
      if (
        port.direction === "output" ||
        port.direction === "bidirectional"
      ) {
        const connectionType = port.type;
        if (!connectionTypesSeen.has(connectionType)) {
          connectionTypesSeen.add(connectionType);
          output2Devices.push({
            id: connectionType,
            name: port.displayName,
            type: "connection",
            available: port.status.available,
          });
        }
      }
    }
  }

  return {
    output1: output1Devices,
    output2: output2Devices,
  };
}

/**
 * Command Router Service
 * 
 * Central command processing logic used by both HTTP routes and Relay Client.
 * Uses direct function calls to services (no HTTP calls to self).
 */
export class CommandRouter {
  /**
   * Handle relay command
   */
  async handleCommand(
    command: RelayCommand,
    payload?: Record<string, unknown>
  ): Promise<RelayCommandResult> {
    try {
      switch (command) {
        case "get_status": {
          const engineState = engineAdapter.getState();
          const runtimeConfigData = runtimeConfig.getConfig();

          return {
            success: true,
            data: {
              running: true,
              version: getVersion(),
              state: runtimeConfig.getState(),
              outputsConfigured: runtimeConfig.hasOutputs(),
              engine: {
                configured: !!runtimeConfigData?.engine,
                status: engineState.status,
                type: engineState.type,
                connected: engineState.status === "connected",
                macrosCount: engineState.macros.length,
              },
            },
          };
        }

        case "list_outputs": {
          const devices = await deviceCache.getDevices(false);
          const outputs = transformDevicesToOutputs(devices);

          return {
            success: true,
            data: outputs,
          };
        }

        case "engine_connect": {
          if (!payload) {
            return {
              success: false,
              error: "Missing payload for engine_connect",
            };
          }

          const { type, ip, port } = payload;

          if (
            !type ||
            !["atem", "tricaster", "vmix"].includes(type as string)
          ) {
            return {
              success: false,
              error: "Invalid engine type. Must be 'atem', 'tricaster', or 'vmix'",
            };
          }

          if (!ip || typeof ip !== "string") {
            return {
              success: false,
              error: "IP address is required",
            };
          }

          if (!port || typeof port !== "number") {
            return {
              success: false,
              error: "Port is required and must be a number",
            };
          }

          await engineAdapter.connect({
            type: type as "atem" | "tricaster" | "vmix",
            ip,
            port,
          });

          return {
            success: true,
            data: {
              state: engineAdapter.getState(),
            },
          };
        }

        case "engine_disconnect": {
          await engineAdapter.disconnect();

          return {
            success: true,
            data: {
              state: engineAdapter.getState(),
            },
          };
        }

        case "engine_get_status": {
          const state = engineAdapter.getState();
          const connectedSince = engineAdapter.getConnectedSince();
          const lastError = engineAdapter.getLastError();

          return {
            success: true,
            data: {
              state: {
                ...state,
                connectedSince: connectedSince || undefined,
                lastError: lastError || undefined,
              },
            },
          };
        }

        case "engine_get_macros": {
          const macros = engineAdapter.getMacros();
          const status = engineAdapter.getStatus();

          if (status !== "connected") {
            return {
              success: false,
              error: `Engine not connected. Status: ${status}`,
              data: {
                macros: [],
              },
            };
          }

          return {
            success: true,
            data: {
              macros,
            },
          };
        }

        case "engine_run_macro": {
          if (!payload || typeof payload.macroId !== "number") {
            return {
              success: false,
              error: "Macro ID is required and must be a number",
            };
          }

          const macroId = payload.macroId as number;
          await engineAdapter.runMacro(macroId);

          return {
            success: true,
            data: {
              macroId,
              state: engineAdapter.getState(),
            },
          };
        }

        case "engine_stop_macro": {
          if (!payload || typeof payload.macroId !== "number") {
            return {
              success: false,
              error: "Macro ID is required and must be a number",
            };
          }

          const macroId = payload.macroId as number;
          await engineAdapter.stopMacro(macroId);

          return {
            success: true,
            data: {
              macroId,
              state: engineAdapter.getState(),
            },
          };
        }

        default:
          return {
            success: false,
            error: `Unknown command: ${command}`,
          };
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

// Singleton instance
export const commandRouter = new CommandRouter();

