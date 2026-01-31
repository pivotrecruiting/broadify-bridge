import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type {
  OutputDeviceT,
  BridgeOutputsT,
  DeviceDescriptorT,
} from "../types.js";
import { deviceCache } from "../services/device-cache.js";

/**
 * Transform Device/Port model to UI-compatible output format.
 *
 * This is a view on the internal Device/Port model that provides
 * the simple output1/output2 structure expected by the UI.
 *
 * @param devices Device descriptors from detection layer.
 * @returns UI-friendly outputs list.
 */
function transformDevicesToOutputs(devices: DeviceDescriptorT[]): BridgeOutputsT {
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

  // Process each device and expose output ports directly
  for (const device of devices) {
    for (const port of device.ports) {
      const outputCapable =
        port.direction === "output" || port.direction === "bidirectional";
      if (!outputCapable) {
        continue;
      }

      // Availability is derived from device + port status (UI-friendly flag).
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
 * Register outputs route
 * 
 * GET /outputs - Returns UI-compatible output format (view on /devices)
 * GET /outputs?refresh=1 - Forces refresh of device detection
 */
export async function registerOutputsRoute(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  fastify.get("/outputs", async (request, reply) => {
    try {
      const refresh = request.query as { refresh?: string };
      const forceRefresh = refresh?.refresh === "1";
      if (forceRefresh) {
        fastify.log.info("[Outputs] Refresh requested");
      }

      // Get devices from cache (with optional refresh)
      const devices = await deviceCache.getDevices(forceRefresh);

      // Transform to UI-compatible format
      const outputs = transformDevicesToOutputs(devices);

      fastify.log.info(
        `[Outputs] Returning ${outputs.output1.length} output1 devices and ${outputs.output2.length} output2 connection types`
      );

      return outputs;
    } catch (error: unknown) {
      fastify.log.error({ err: error }, "[Outputs] Error getting outputs");

      // Handle rate limit errors
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorAny = error as any;
      if (errorAny?.message?.includes("Rate limit")) {
        return reply.code(429).send({
          error: "Rate limit exceeded",
          message: errorAny.message,
        });
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      reply.code(500).send({
        error: "Failed to get outputs",
        message: errorMessage,
      });
    }
  });
}
