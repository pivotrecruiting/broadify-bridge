import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { enforceLocalOrToken } from "./route-guards.js";

/**
 * Video status type
 */
type VideoStatusT = "not-configured" | "configured" | "unavailable" | "error";

type VideoRouteDepsT = {
  enforceLocalOrToken: typeof enforceLocalOrToken;
  getStatus: () => { status: VideoStatusT; message: string };
};

type VideoRouteOptionsT = FastifyPluginOptions & Partial<VideoRouteDepsT>;

/**
 * Register video routes
 *
 * V1: Placeholder endpoint for video status
 * V2: Full video I/O configuration and control
 */
export async function registerVideoRoute(
  fastify: FastifyInstance,
  options: VideoRouteOptionsT
): Promise<void> {
  const deps: VideoRouteDepsT = {
    enforceLocalOrToken,
    getStatus: () => ({
      status: "not-configured",
      message: "Video I/O not yet configured",
    }),
    ...options,
  };

  /**
   * GET /video/status
   * Get video I/O status
   *
   * V1: Returns "not-configured" as placeholder
   * V2: Will return actual video configuration status
   */
  fastify.get("/video/status", async (request, reply) => {
    if (!deps.enforceLocalOrToken(request, reply)) {
      return;
    }
    try {
      return deps.getStatus();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Video] Status error");

      return reply.code(500).send({
        error: "Failed to get video status",
        message: errorMessage || "Unknown error",
      });
    }
  });
}
