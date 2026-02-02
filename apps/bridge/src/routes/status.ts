import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { BridgeConfigT } from "../config.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeConfig } from "../services/runtime-config.js";
import { engineAdapter } from "../services/engine-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Track server start time for uptime calculation
const serverStartTime = Date.now();

/**
 * Get version from package.json.
 *
 * @returns Version string or default.
 */
function getVersion(): string {
  try {
    const packagePath = join(__dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

/**
 * Calculate uptime in seconds.
 *
 * @returns Uptime in seconds since server start.
 */
function getUptime(): number {
  return Math.floor((Date.now() - serverStartTime) / 1000);
}

/**
 * Register status route.
 *
 * @param fastify Fastify instance.
 * @param options Plugin options with bridge config.
 */
export async function registerStatusRoute(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & { config: BridgeConfigT }
): Promise<void> {
  const { config } = options;

  fastify.get("/status", async () => {
    const engineState = engineAdapter.getState();
    const runtimeConfigData = runtimeConfig.getConfig();

    return {
      running: true,
      version: getVersion(),
      uptime: getUptime(),
      mode: config.mode,
      port: config.port,
      host: config.host,
      bridgeName: config.bridgeName || null,
      state: runtimeConfig.getState(),
      outputsConfigured: runtimeConfig.hasOutputs(),
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
