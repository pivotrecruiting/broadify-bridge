import type { FastifyInstance, FastifyPluginOptions } from "fastify";

/**
 * Video status type
 */
type VideoStatusT = "not-configured" | "configured" | "unavailable" | "error";

/**
 * Register video routes
 *
 * V1: Placeholder endpoint for video status
 * V2: Full video I/O configuration and control
 */
export async function registerVideoRoute(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  /**
   * GET /video/status
   * Get video I/O status
   *
   * V1: Returns "not-configured" as placeholder
   * V2: Will return actual video configuration status
   */
  fastify.get("/video/status", async (_request, reply) => {
    try {
      // V1: Always return "not-configured"
      // V2: Check actual video configuration state
      const status: VideoStatusT = "not-configured";

      return {
        status,
        message: "Video I/O not yet configured",
      };
    } catch (error: any) {
      fastify.log.error("[Video] Status error:", error);

      return reply.code(500).send({
        error: "Failed to get video status",
        message: error.message || "Unknown error",
      });
    }
  });
}

