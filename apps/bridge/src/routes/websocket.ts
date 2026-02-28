import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { websocketManager } from "../services/websocket-manager.js";
import { engineAdapter } from "../services/engine-adapter.js";
import { getAuthFailure } from "./route-guards.js";
import {
  buildWebSocketSnapshot,
  normalizeWebSocketTopics,
  type WebSocketTopicT,
} from "./websocket-contract.js";

/**
 * WebSocket message types
 */
type ClientMessage =
  | { type: "subscribe"; topics: string[] }
  | { type: "unsubscribe"; topics: string[] };

type WebSocketRouteDepsT = {
  websocketManager: Pick<
    typeof websocketManager,
    "registerClient" | "unregisterClient" | "subscribe" | "unsubscribe" | "sendSnapshot"
  >;
  engineAdapter: Pick<typeof engineAdapter, "getState">;
  getAuthFailure: typeof getAuthFailure;
};

type WebSocketRouteOptionsT = FastifyPluginOptions & Partial<WebSocketRouteDepsT>;

/**
 * Register WebSocket route
 *
 * Generic WebSocket endpoint with topic-based subscription.
 * Clients can subscribe to topics (engine, video) and receive
 * only events for those topics.
 *
 * Protocol:
 * - Client → Server: { type: "subscribe", topics: ["engine", "video"] }
 * - Server → Client: { type: "engine.status", ... } (only if subscribed)
 */
export async function registerWebSocketRoute(
  fastify: FastifyInstance,
  options: WebSocketRouteOptionsT
): Promise<void> {
  const deps: WebSocketRouteDepsT = {
    websocketManager,
    engineAdapter,
    getAuthFailure,
    ...options,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.get("/ws", { websocket: true } as any, (connection, request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = connection.socket as any;
    const authFailure = deps.getAuthFailure(request);
    if (authFailure) {
      fastify.log.warn(
        { reason: authFailure.message, ip: request.ip },
        "[WebSocket] Rejected client connection"
      );
      client.close(1008, "Forbidden");
      return;
    }
    fastify.log.debug("[WebSocket] Client connected");

    // Register client
    deps.websocketManager.registerClient(client);

    // Send snapshot for subscribed topics on connect
    const sendSnapshot = () => {
      deps.websocketManager.sendSnapshot(client, (topic: WebSocketTopicT) =>
        buildWebSocketSnapshot(topic, deps.engineAdapter.getState()),
      );
    };

    // Handle incoming messages
    client.on("message", (message: Buffer) => {
      try {
        const data: ClientMessage = JSON.parse(message.toString());

        if (data.type === "subscribe") {
          const validTopics = normalizeWebSocketTopics(data.topics);

          if (validTopics.length > 0) {
            deps.websocketManager.subscribe(client, validTopics);
            fastify.log.debug(
              `[WebSocket] Client subscribed to topics: ${validTopics.join(
                ", "
              )}`
            );

            // Send snapshot after subscription
            sendSnapshot();
          }
        } else if (data.type === "unsubscribe") {
          const validTopics = normalizeWebSocketTopics(data.topics);

          if (validTopics.length > 0) {
            deps.websocketManager.unsubscribe(client, validTopics);
            fastify.log.debug(
              `[WebSocket] Client unsubscribed from topics: ${validTopics.join(
                ", "
              )}`
            );
          }
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        fastify.log.error(`[WebSocket] Error parsing message: ${errorMessage}`);
      }
    });

    // Handle disconnect
    client.on("close", () => {
      fastify.log.debug("[WebSocket] Client disconnected");
      deps.websocketManager.unregisterClient(client);
    });

    // Handle errors
    client.on("error", (error: Error) => {
      fastify.log.error({ err: error }, "[WebSocket] Error");
      deps.websocketManager.unregisterClient(client);
    });
  });
}
