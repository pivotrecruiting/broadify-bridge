import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import type { BridgeConfigT } from "../config.js";
import { enforceLocalOrToken } from "./route-guards.js";

type RelayRouteDepsT = {
  enforceLocalOrToken: typeof enforceLocalOrToken;
};

type RelayRouteOptionsT = FastifyPluginOptions &
  { config: BridgeConfigT; relayClient?: unknown } &
  Partial<RelayRouteDepsT>;

/**
 * Relay status route
 * 
 * GET /relay/status - Returns relay connection status
 */
export async function registerRelayRoute(
  fastify: FastifyInstance,
  options: RelayRouteOptionsT
): Promise<void> {
  const { config, relayClient } = options;
  const deps: RelayRouteDepsT = {
    enforceLocalOrToken,
    ...options,
  };

  fastify.get("/relay/status", async (request, reply) => {
    if (!deps.enforceLocalOrToken(request, reply)) {
      return;
    }
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
