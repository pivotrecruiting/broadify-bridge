import { z } from "zod";
import { runtimeConfig } from "../services/runtime-config.js";
import { moduleRegistry } from "../modules/module-registry.js";
import { deviceCache } from "../services/device-cache.js";
import { isDevelopmentMode } from "../services/dev-mode.js";
import { graphicsManager } from "../services/graphics/graphics-manager.js";
import { outputConfigStore } from "../services/graphics/output-config-store.js";
import { getAuthFailure } from "./route-guards.js";
import type { FastifyInstance } from "fastify";
import type { DeviceDescriptorT } from "@broadify/protocol";

type ConfigRouteDepsT = {
  runtimeConfig: Pick<
    typeof runtimeConfig,
    | "setConfig"
    | "setActive"
    | "getState"
    | "hasOutputs"
    | "clear"
  >;
  moduleRegistry: Pick<typeof moduleRegistry, "getController">;
  deviceCache: Pick<typeof deviceCache, "getDevices">;
  graphicsManager: Pick<typeof graphicsManager, "shutdown">;
  outputConfigStore: Pick<typeof outputConfigStore, "clear">;
  isDevelopmentMode: typeof isDevelopmentMode;
  getAuthFailure: typeof getAuthFailure;
};

/**
 * Config request schema.
 */
const ConfigRequestSchema = z.object({
  outputs: z
    .object({
      output1: z.string(),
      output2: z.string(),
    })
    .optional(),
  engine: z
    .object({
      type: z.enum(["atem", "tricaster", "vmix"]),
      ip: z.string().ip({ version: "v4" }),
      port: z.number().int().min(1).max(65535),
    })
    .optional(),
});

/**
 * Register config route.
 *
 * POST /config - Configure outputs and/or engine
 * POST /config/clear - Clear configuration
 */
export async function registerConfigRoute(
  fastify: FastifyInstance,
  options: Partial<ConfigRouteDepsT> = {}
): Promise<void> {
  const deps: ConfigRouteDepsT = {
    runtimeConfig,
    moduleRegistry,
    deviceCache,
    graphicsManager,
    outputConfigStore,
    isDevelopmentMode,
    getAuthFailure,
    ...options,
  };

  fastify.addHook("preHandler", async (request, reply) => {
    const authFailure = deps.getAuthFailure(request);
    if (!authFailure) {
      return;
    }
    return reply.code(authFailure.status).send({
      success: false,
      error: authFailure.message,
    });
  });

  /**
   * Validate and find device by ID or name.
   *
   * @param deviceIdOrName Device id or display name.
   * @param devices Current device list.
   * @returns Matching device or null.
   */
  async function findDevice(
    deviceIdOrName: string,
    devices: DeviceDescriptorT[]
  ): Promise<DeviceDescriptorT | null> {
    // Try to find by ID first
    let device = devices.find((d) => d.id === deviceIdOrName);

    // If not found, try to find by display name
    if (!device) {
      device = devices.find((d) => d.displayName === deviceIdOrName);
    }

    return device || null;
  }

  /**
   * Validate outputs exist and are available.
   *
   * @param output1 Output 1 identifier.
   * @param output2 Output 2 identifier or connection type.
   * @returns Validation result.
   */
  async function validateOutputs(
    output1: string,
    output2: string
  ): Promise<{ valid: boolean; error?: string }> {
    const devices = await deps.deviceCache.getDevices();

    // Find output1 device
    const device1 = await findDevice(output1, devices);
    if (!device1) {
      return {
        valid: false,
        error: `Output 1 device "${output1}" not found`,
      };
    }

    // Check if device1 has output-capable ports
    const hasOutput1Port = device1.ports.some(
      (port) =>
        (port.direction === "output" || port.direction === "bidirectional") &&
        port.status.available
    );

    if (!hasOutput1Port) {
      return {
        valid: false,
        error: `Output 1 device "${output1}" has no available output ports`,
      };
    }

    // Find output2 device (or connection type)
    // For now, we'll check if it's a valid connection type or device
    const device2 = await findDevice(output2, devices);

    // If output2 is a connection type (sdi, hdmi, usb, etc.), it's valid
    const connectionTypes = [
      "sdi",
      "hdmi",
      "usb",
      "displayport",
      "thunderbolt",
    ];
    if (connectionTypes.includes(output2.toLowerCase())) {
      // Check if any device has this connection type available
      const hasConnectionType = devices.some((device) =>
        device.ports.some(
          (port) =>
            port.type === output2.toLowerCase() &&
            (port.direction === "output" ||
              port.direction === "bidirectional") &&
            port.status.available
        )
      );

      if (!hasConnectionType) {
        return {
          valid: false,
          error: `Connection type "${output2}" is not available`,
        };
      }
    } else if (!device2) {
      return {
        valid: false,
        error: `Output 2 device or connection type "${output2}" not found`,
      };
    }

    return { valid: true };
  }

  /**
   * Open device controllers.
   *
   * @param output1 Output 1 identifier.
   * @param output2 Output 2 identifier or connection type.
   * @returns Result of controller open operations.
   */
  async function openControllers(
    output1: string,
    output2: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const devices = await deps.deviceCache.getDevices();

      // Find and open output1 controller
      const device1 = await findDevice(output1, devices);
      if (device1) {
        const controller1 = await deps.moduleRegistry.getController(device1.id);
        await controller1.open();
        fastify.log.info(
          `[Config] Opened controller for output1: ${device1.id}`
        );
      }

      // For output2, if it's a device (not connection type), open controller
      const connectionTypes = [
        "sdi",
        "hdmi",
        "usb",
        "displayport",
        "thunderbolt",
      ];
      if (!connectionTypes.includes(output2.toLowerCase())) {
        const device2 = await findDevice(output2, devices);
        if (device2) {
          const controller2 = await deps.moduleRegistry.getController(device2.id);
          await controller2.open();
          fastify.log.info(
            `[Config] Opened controller for output2: ${device2.id}`
          );
        }
      }

      return { success: true };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Config] Error opening controllers");
      return {
        success: false,
        error: errorMessage || "Failed to open device controllers",
      };
    }
  }

  fastify.post("/config", async (request, reply) => {
    try {
      // Validate request body
      const body = ConfigRequestSchema.parse(request.body);
      const devMode = deps.isDevelopmentMode();

      // If outputs are provided, validate them
      if (body.outputs) {
        if (devMode) {
          fastify.log.warn(
            "[Config] DEVELOPMENT mode enabled: skipping output validation and controller open"
          );
        } else {
          const validation = await validateOutputs(
            body.outputs.output1,
            body.outputs.output2
          );

          if (!validation.valid) {
            return reply.code(400).send({
              error: "Invalid outputs",
              message: validation.error,
            });
          }

          // Open device controllers
          const openResult = await openControllers(
            body.outputs.output1,
            body.outputs.output2
          );

          if (!openResult.success) {
            return reply.code(500).send({
              error: "Failed to open device controllers",
              message: openResult.error,
            });
          }
        }
      }

      // Set runtime config (in-memory state only).
      deps.runtimeConfig.setConfig({
        outputs: body.outputs,
        engine: body.engine,
      });

      // Set state to active if controllers were opened.
      if (body.outputs) {
        deps.runtimeConfig.setActive();
      }

      fastify.log.info(
        `[Config] Configuration updated - State: ${deps.runtimeConfig.getState()}`
      );

      return {
        success: true,
        state: deps.runtimeConfig.getState(),
        outputsConfigured: deps.runtimeConfig.hasOutputs(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Config] Error setting configuration");

      // Handle Zod validation errors
      if (
        error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "ZodError" &&
        "errors" in error &&
        Array.isArray(error.errors)
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const zodErrors = error.errors as any[];
        return reply.code(400).send({
          error: "Invalid request",
          message: zodErrors.map((e) => e.message || String(e)).join(", "),
        });
      }

      reply.code(500).send({
        error: "Failed to set configuration",
        message: errorMessage,
      });
    }
  });

  fastify.post("/config/clear", async (_, reply) => {
    try {
      await deps.graphicsManager.shutdown();
      await deps.outputConfigStore.clear();
      deps.runtimeConfig.clear();
      fastify.log.info("[Config] Configuration cleared");

      return {
        success: true,
        state: deps.runtimeConfig.getState(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error(
        { err: error },
        "[Config] Error clearing configuration"
      );
      reply.code(500).send({
        error: "Failed to clear configuration",
        message: errorMessage,
      });
    }
  });
}
