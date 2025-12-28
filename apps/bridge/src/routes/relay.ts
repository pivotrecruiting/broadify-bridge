import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { BridgeConfigT } from "../config.js";

/**
 * Relay status route
 * 
 * GET /relay/status - Returns relay connection status
 */
export async function registerRelayRoute(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & { config: BridgeConfigT; relayClient?: unknown }
): Promise<void> {
  const { config, relayClient } = options;

  fastify.get("/relay/status", async () => {
    // Check if relay client is available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = relayClient as any;

    if (!client) {
      return {
        connected: false,
        bridgeId: config.bridgeId || null,
        lastSeen: null,
        error: "Relay client not initialized",
      };
    }

    const isConnected = client.isConnected ? client.isConnected() : false;
    const lastSeen = client.getLastSeen ? client.getLastSeen() : null;

    return {
      connected: isConnected,
      bridgeId: config.bridgeId || null,
      lastSeen: lastSeen,
    };
  });
}

