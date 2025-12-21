import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { BridgeConfigT } from "../config.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Track server start time for uptime calculation
const serverStartTime = Date.now();

/**
 * Get version from package.json
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
 * Calculate uptime in seconds
 */
function getUptime(): number {
  return Math.floor((Date.now() - serverStartTime) / 1000);
}

/**
 * Register status route
 */
export async function registerStatusRoute(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & { config: BridgeConfigT }
): Promise<void> {
  const { config } = options;

  fastify.get("/status", async (request, reply) => {
    return {
      running: true,
      version: getVersion(),
      uptime: getUptime(),
      mode: config.mode,
      port: config.port,
      host: config.host,
    };
  });
}

