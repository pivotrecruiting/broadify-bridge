import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { BridgeConfigT } from "../config.js";
import { runtimeConfig } from "../services/runtime-config.js";
import { engineAdapter } from "../services/engine-adapter.js";
import { getRuntimeAppVersion } from "../services/runtime-app-version.js";
import { enforceLocalOrToken } from "./route-guards.js";

// Track server start time for uptime calculation
const serverStartTime = Date.now();

/**
 * Calculate uptime in seconds.
 *
 * @returns Uptime in seconds since server start.
 */
function getUptime(): number {
  return Math.floor((Date.now() - serverStartTime) / 1000);
}

type StatusRouteDepsT = {
  runtimeConfig: Pick<typeof runtimeConfig, "getConfig" | "getState" | "hasOutputs">;
  engineAdapter: Pick<typeof engineAdapter, "getState">;
  enforceLocalOrToken: typeof enforceLocalOrToken;
  getVersion: () => string;
  getUptime: () => number;
};

type StatusRouteOptionsT = FastifyPluginOptions &
  { config: BridgeConfigT } &
  Partial<StatusRouteDepsT>;

/**
 * Register status route.
 *
 * @param fastify Fastify instance.
 * @param options Plugin options with bridge config.
 */
export async function registerStatusRoute(
  fastify: FastifyInstance,
  options: StatusRouteOptionsT
): Promise<void> {
  const { config } = options;
  const deps: StatusRouteDepsT = {
    runtimeConfig,
    engineAdapter,
    enforceLocalOrToken,
    getVersion: getRuntimeAppVersion,
    getUptime,
    ...options,
  };

  fastify.get("/status", async (request, reply) => {
    if (!deps.enforceLocalOrToken(request, reply)) {
      return;
    }
    const engineState = deps.engineAdapter.getState();
    const runtimeConfigData = deps.runtimeConfig.getConfig();

    return {
      running: true,
      version: deps.getVersion(),
      uptime: deps.getUptime(),
      mode: config.mode,
      port: config.port,
      host: config.host,
      bridgeName: config.bridgeName || null,
      state: deps.runtimeConfig.getState(),
      outputsConfigured: deps.runtimeConfig.hasOutputs(),
      engine: {
        configured: !!runtimeConfigData?.engine,
        status: engineState.status,
        type: engineState.type,
        connected: engineState.status === "connected",
        macrosCount: engineState.macros.length,
      },
    };
  });
}
