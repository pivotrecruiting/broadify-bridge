import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { deviceCache } from "../services/device-cache.js";
import { OUTPUT_DEVICE_MODULE_NAMES } from "../services/output-device-modules.js";
import { enforceLocalOrToken } from "./route-guards.js";
import { buildBridgeOutputsView } from "../services/outputs-view.js";

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
    if (!enforceLocalOrToken(request, reply)) {
      return;
    }
    try {
      const refresh = request.query as { refresh?: string };
      const forceRefresh = refresh?.refresh === "1";
      if (forceRefresh) {
        fastify.log.debug("[Outputs] Refresh requested");
      }

      // Get devices from cache (with optional refresh)
      const devices = await deviceCache.getDevices(
        forceRefresh,
        OUTPUT_DEVICE_MODULE_NAMES,
      );

      const outputs = buildBridgeOutputsView(devices);

      fastify.log.debug(
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
