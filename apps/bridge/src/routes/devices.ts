import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { deviceCache } from "../services/device-cache.js";
import { enforceLocalOrToken } from "./route-guards.js";

/**
 * Register devices route
 *
 * GET /devices - Returns raw device inventory (Device/Port model)
 * GET /devices?refresh=1 - Forces refresh of device detection (with rate limiting)
 */
export async function registerDevicesRoute(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  fastify.get("/devices", async (request, reply) => {
    if (!enforceLocalOrToken(request, reply)) {
      return;
    }
    try {
      const refresh = request.query as { refresh?: string };
      return await deviceCache.getDevices(refresh?.refresh === "1");
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage.startsWith("Rate limit exceeded")) {
        const retryAfterMatch = errorMessage.match(/wait (\d+) seconds?/i);
        const retryAfter = Number(retryAfterMatch?.[1] ?? 1);
        return reply.code(429).send({
          error: "Rate limit exceeded",
          message: `Please wait ${retryAfter} seconds before refreshing again`,
          retryAfter,
        });
      }
      fastify.log.error({ err: error }, "[Devices] Error detecting devices");
      reply.code(500).send({
        error: "Failed to detect devices",
        message: errorMessage,
      });
    }
  });
}
