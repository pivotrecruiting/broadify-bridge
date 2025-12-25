import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { DeviceDescriptorT } from "../types.js";
import { moduleRegistry } from "../modules/module-registry.js";

/**
 * Register devices route
 *
 * GET /devices - Returns raw device inventory (Device/Port model)
 * GET /devices?refresh=1 - Forces refresh of device detection (with rate limiting)
 */
export async function registerDevicesRoute(
  fastify: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: FastifyPluginOptions
): Promise<void> {
  // Cache for device detection results
  let cachedDevices: DeviceDescriptorT[] = [];
  let lastDetectionTime = 0;
  const CACHE_TTL = 1000; // 1 second cache TTL
  const REFRESH_RATE_LIMIT = 2000; // 2 seconds between refreshes

  /**
   * Perform device detection
   */
  const performDetection = async (): Promise<DeviceDescriptorT[]> => {
    fastify.log.debug("[Devices] Starting device detection");
    const devices = await moduleRegistry.detectAll();
    fastify.log.debug(`[Devices] Detected ${devices.length} devices`);
    return devices;
  };

  fastify.get("/devices", async (request, reply) => {
    try {
      const refresh = request.query as { refresh?: string };
      const now = Date.now();

      // Check if refresh is requested
      if (refresh?.refresh === "1") {
        // Rate limiting for refresh
        const timeSinceLastRefresh = now - lastDetectionTime;
        if (timeSinceLastRefresh < REFRESH_RATE_LIMIT) {
          fastify.log.warn(
            `[Devices] Refresh rate limited. Please wait ${Math.ceil(
              (REFRESH_RATE_LIMIT - timeSinceLastRefresh) / 1000
            )}s`
          );
          return reply.code(429).send({
            error: "Rate limit exceeded",
            message: `Please wait ${Math.ceil(
              (REFRESH_RATE_LIMIT - timeSinceLastRefresh) / 1000
            )} seconds before refreshing again`,
            retryAfter: Math.ceil(
              (REFRESH_RATE_LIMIT - timeSinceLastRefresh) / 1000
            ),
          });
        }

        // Force refresh
        fastify.log.info(
          "[Devices] Refresh requested, performing new detection"
        );
        cachedDevices = await performDetection();
        lastDetectionTime = now;
        return cachedDevices;
      }

      // Use cache if available and fresh
      const timeSinceLastDetection = now - lastDetectionTime;
      if (cachedDevices.length > 0 && timeSinceLastDetection < CACHE_TTL) {
        fastify.log.debug("[Devices] Returning cached devices");
        return cachedDevices;
      }

      // Perform detection and cache result
      cachedDevices = await performDetection();
      lastDetectionTime = now;
      return cachedDevices;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Devices] Error detecting devices");
      reply.code(500).send({
        error: "Failed to detect devices",
        message: errorMessage,
      });
    }
  });
}
