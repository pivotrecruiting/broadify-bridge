import { engineAdapter } from "./engine-adapter.js";
import { deviceCache } from "./device-cache.js";
import { runtimeConfig } from "./runtime-config.js";
import { graphicsManager } from "./graphics/graphics-manager.js";
import {
  EmptyPayloadSchema,
  EngineConnectSchema,
  ListOutputsSchema,
  MacroIdSchema,
  PairingCodeSchema,
  parseRelayPayload,
} from "./relay-command-schemas.js";
import { getBridgeContext } from "./bridge-context.js";
import { GraphicsError } from "./graphics/graphics-errors.js";
import { getRelayBridgeEnrollmentPublicKey } from "./relay-bridge-identity.js";
import { getRuntimeAppVersion } from "./runtime-app-version.js";
import { transformDevicesToOutputs } from "./device-to-output-transform.js";
import { type RelayCommand } from "./relay-command-allowlist.js";

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
  errorCode?: string;
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
    payload?: Record<string, unknown>,
  ): Promise<RelayCommandResult> {
    try {
      switch (command) {
        case "get_status": {
          parseRelayPayload(
            EmptyPayloadSchema,
            payload ?? {},
            "Invalid payload for get_status",
          );
          const engineState = engineAdapter.getState();
          const runtimeConfigData = runtimeConfig.getConfig();
          const context = getBridgeContext();

          return {
            success: true,
            data: {
              running: true,
              version: getRuntimeAppVersion(),
              bridgeName: context.bridgeName || null,
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

        case "bridge_pair_validate": {
          const context = getBridgeContext();
          const pairingCode = context.pairingCode;
          const pairingExpiresAt = context.pairingExpiresAt;

          if (!pairingCode) {
            return {
              success: false,
              error: "Pairing is not enabled on this bridge",
            };
          }

          const { pairingCode: providedCode } = parseRelayPayload(
            PairingCodeSchema,
            payload ?? {},
            "Invalid pairing code format",
          );

          if (pairingExpiresAt && Date.now() > pairingExpiresAt) {
            return {
              success: false,
              error: "Pairing code has expired",
            };
          }

          if (providedCode !== pairingCode) {
            return {
              success: false,
              error: "Invalid pairing code",
            };
          }

          const relayEnrollment = await getRelayBridgeEnrollmentPublicKey();

          return {
            success: true,
            data: {
              bridgeId: context.bridgeId || null,
              bridgeName: context.bridgeName || null,
              version: getRuntimeAppVersion(),
              relayEnrollment,
            },
          };
        }

        case "list_outputs": {
          const { refresh = false } = parseRelayPayload(
            ListOutputsSchema,
            payload ?? {},
            "Invalid payload for list_outputs",
          );
          if (refresh) {
            getBridgeContext().logger.debug?.(
              "[CommandRouter] list_outputs refresh requested",
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
          const { type, ip, port } = parseRelayPayload(
            EngineConnectSchema,
            payload ?? {},
            "Invalid payload for engine_connect",
          );

          await engineAdapter.connect({
            type,
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
          parseRelayPayload(
            EmptyPayloadSchema,
            payload ?? {},
            "Invalid payload for engine_disconnect",
          );
          await engineAdapter.disconnect();

          return {
            success: true,
            data: {
              state: engineAdapter.getState(),
            },
          };
        }

        case "engine_get_status": {
          parseRelayPayload(
            EmptyPayloadSchema,
            payload ?? {},
            "Invalid payload for engine_get_status",
          );
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
          parseRelayPayload(
            EmptyPayloadSchema,
            payload ?? {},
            "Invalid payload for engine_get_macros",
          );
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
          const { macroId } = parseRelayPayload(
            MacroIdSchema,
            payload ?? {},
            "Macro ID is required and must be a number",
          );
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
          const { macroId } = parseRelayPayload(
            MacroIdSchema,
            payload ?? {},
            "Macro ID is required and must be a number",
          );
          await engineAdapter.stopMacro(macroId);

          return {
            success: true,
            data: {
              macroId,
              state: engineAdapter.getState(),
            },
          };
        }

        case "engine_vmix_ensure_browser_input": {
          parseRelayPayload(
            EmptyPayloadSchema,
            payload ?? {},
            "Invalid payload for engine_vmix_ensure_browser_input",
          );

          await graphicsManager.initialize();
          const graphicsStatus = graphicsManager.getStatus();
          const browserInputStatus = graphicsStatus.browserInput;

          if (graphicsStatus.outputConfig?.outputKey !== "browser_input") {
            return {
              success: false,
              error:
                "Graphics output mode browser_input is not configured on this bridge",
            };
          }

          const browserInputUrl = browserInputStatus?.browserInputUrl?.trim();
          const recommendedInputName =
            browserInputStatus?.recommendedInputName?.trim();

          if (!browserInputUrl || !recommendedInputName) {
            return {
              success: false,
              error:
                "Bridge browser-input metadata is incomplete. Save the browser_input output config first.",
            };
          }

          const result = await engineAdapter.ensureVmixBrowserInput({
            url: browserInputUrl,
            inputName: recommendedInputName,
          });

          return {
            success: true,
            data: result,
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
      const errorCode = error instanceof GraphicsError ? error.code : undefined;
      return {
        success: false,
        error: errorMessage,
        errorCode,
      };
    }
  }
}

// Singleton instance
export const commandRouter = new CommandRouter();
