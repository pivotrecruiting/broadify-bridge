import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type {
  OutputDeviceT,
  BridgeOutputsT,
  DeviceDescriptorT,
} from "../types.js";
import { deviceCache } from "../services/device-cache.js";

/**
 * Transform Device/Port model to UI-compatible output format
 * 
 * This is a view on the internal Device/Port model that provides
 * the simple output1/output2 structure expected by the UI.
 */
function transformDevicesToOutputs(devices: DeviceDescriptorT[]): BridgeOutputsT {
  const output1Devices: OutputDeviceT[] = [];
  const output2Devices: OutputDeviceT[] = [];
  const connectionTypeMap = new Map<string, OutputDeviceT>();

  // Process each device
  for (const device of devices) {
    // Add device to output1 (Hardware Devices)
    const hasOutputPort = device.ports.some(
      (port) => port.direction === "output" || port.direction === "bidirectional"
    );
    const hasAvailableOutputPort = device.ports.some(
      (port) =>
        (port.direction === "output" || port.direction === "bidirectional") &&
        port.status.available
    );

    if (hasOutputPort) {
      output1Devices.push({
        id: device.id,
        name: device.displayName,
        type: "capture",
        available:
          device.status.present &&
          device.status.ready &&
          !device.status.inUse &&
          hasAvailableOutputPort,
      });
    }

    // Collect connection types from ports (for output2)
    for (const port of device.ports) {
      const connectionType = port.type;
      const outputCapable =
        port.direction === "output" || port.direction === "bidirectional";
      if (!outputCapable) {
        continue;
      }
      const available = port.status.available;
      const existing = connectionTypeMap.get(connectionType);

      if (!existing) {
        connectionTypeMap.set(connectionType, {
          id: connectionType,
          name: port.displayName,
          type: "connection",
          available,
        });
      } else if (!existing.available && available) {
        existing.available = true;
        existing.name = port.displayName;
      }
    }
  }

  output2Devices.push(...connectionTypeMap.values());

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
