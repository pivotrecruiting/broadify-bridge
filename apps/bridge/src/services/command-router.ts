import { engineAdapter } from "./engine-adapter.js";
import { deviceCache } from "./device-cache.js";
import { runtimeConfig } from "./runtime-config.js";
import { graphicsManager } from "./graphics/graphics-manager.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBridgeContext } from "./bridge-context.js";
import type {
  BridgeOutputsT,
  DeviceDescriptorT,
  OutputDeviceT,
} from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Relay command types accepted by the bridge.
 */
export type RelayCommand =
  | "get_status"
  | "list_outputs"
  | "engine_connect"
  | "engine_disconnect"
  | "engine_get_status"
  | "engine_get_macros"
  | "engine_run_macro"
  | "engine_stop_macro"
  | "graphics_configure_outputs"
  | "graphics_send"
  | "graphics_test_pattern"
  | "graphics_update_values"
  | "graphics_update_layout"
  | "graphics_remove"
  | "graphics_remove_preset"
  | "graphics_list";

/**
 * Relay command payload.
 */
export interface RelayCommandPayload {
  command: RelayCommand;
  payload?: Record<string, unknown>;
}

/**
 * Relay command result.
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
  const output1Devices: OutputDeviceT[] = [];
  const output2Devices: OutputDeviceT[] = [];
  const mapDeviceTypeToOutputType = (
    deviceType: DeviceDescriptorT["type"]
  ): OutputDeviceT["type"] => {
    if (deviceType === "decklink") {
      return "decklink";
    }
    return "capture";
  };

  for (const device of devices) {
    for (const port of device.ports) {
      const outputCapable =
        port.direction === "output" || port.direction === "bidirectional";
      if (!outputCapable) {
        continue;
      }

      const available =
        device.status.present &&
        device.status.ready &&
        !device.status.inUse &&
        port.status.available;
      const outputEntry: OutputDeviceT = {
        id: port.id,
        name: `${device.displayName} - ${port.displayName}`,
        type: mapDeviceTypeToOutputType(device.type),
        available,
        deviceId: device.id,
        portType: port.type,
        portRole: port.role,
        formats: port.capabilities.formats,
        modes: port.capabilities.modes,
      };

      if (port.role === "key") {
        output2Devices.push(outputEntry);
      } else {
        output1Devices.push(outputEntry);
      }
    }
  }

  return {
    output1: output1Devices,
    output2: output2Devices,
  };
}

/**
 * Command Router Service.
 *
 * Central command processing logic used by both HTTP routes and Relay Client.
 * Uses direct function calls to services (no HTTP calls to self).
 */
export class CommandRouter {
  /**
   * Handle relay command.
   *
   * @param command Command name from relay or HTTP route.
   * @param payload Untrusted payload (validated by downstream services).
   * @returns Command execution result.
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
          const refresh =
            typeof payload?.refresh === "boolean" ? payload.refresh : false;
          if (refresh) {
            getBridgeContext().logger.info(
              "[CommandRouter] list_outputs refresh requested"
            );
          }
          const devices = await deviceCache.getDevices(refresh);
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
              error:
                "Invalid engine type. Must be 'atem', 'tricaster', or 'vmix'",
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

        case "graphics_configure_outputs": {
          if (!payload) {
            return {
              success: false,
              error: "Missing payload for graphics_configure_outputs",
            };
          }

          // Graphics payloads are validated inside GraphicsManager via Zod schemas.
          await graphicsManager.configureOutputs(payload);
          return {
            success: true,
            data: {},
          };
        }

        case "graphics_send": {
          if (!payload) {
            return {
              success: false,
              error: "Missing payload for graphics_send",
            };
          }

          // Graphics payloads are validated inside GraphicsManager via Zod schemas.
          await graphicsManager.sendLayer(payload);
          return {
            success: true,
            data: {},
          };
        }

        case "graphics_test_pattern": {
          await graphicsManager.sendTestPattern();
          return {
            success: true,
            data: {},
          };
        }

        case "graphics_update_values": {
          if (!payload) {
            return {
              success: false,
              error: "Missing payload for graphics_update_values",
            };
          }

          // Graphics payloads are validated inside GraphicsManager via Zod schemas.
          await graphicsManager.updateValues(payload);
          return {
            success: true,
            data: {},
          };
        }

        case "graphics_update_layout": {
          if (!payload) {
            return {
              success: false,
              error: "Missing payload for graphics_update_layout",
            };
          }

          // Graphics payloads are validated inside GraphicsManager via Zod schemas.
          await graphicsManager.updateLayout(payload);
          return {
            success: true,
            data: {},
          };
        }

        case "graphics_remove": {
          if (!payload) {
            return {
              success: false,
              error: "Missing payload for graphics_remove",
            };
          }

          // Graphics payloads are validated inside GraphicsManager via Zod schemas.
          await graphicsManager.removeLayer(payload);
          return {
            success: true,
            data: {},
          };
        }

        case "graphics_remove_preset": {
          if (!payload) {
            return {
              success: false,
              error: "Missing payload for graphics_remove_preset",
            };
          }

          // Graphics payloads are validated inside GraphicsManager via Zod schemas.
          await graphicsManager.removePreset(payload);
          return {
            success: true,
            data: {},
          };
        }

        case "graphics_list": {
          await graphicsManager.initialize();
          return {
            success: true,
            data: graphicsManager.getStatus(),
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
