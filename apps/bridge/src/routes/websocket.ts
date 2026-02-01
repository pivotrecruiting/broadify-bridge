import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { websocketManager } from "../services/websocket-manager.js";
import { engineAdapter } from "../services/engine-adapter.js";
import { getAuthFailure } from "./route-guards.js";

/**
 * WebSocket message types
 */
type ClientMessage =
  | { type: "subscribe"; topics: string[] }
  | { type: "unsubscribe"; topics: string[] };

type Topic = "engine" | "video";

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
  _options: FastifyPluginOptions
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.get("/ws", { websocket: true } as any, (connection, request) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = connection.socket as any;
    const authFailure = getAuthFailure(request);
    if (authFailure) {
      fastify.log.warn(
        { reason: authFailure.message, ip: request.ip },
        "[WebSocket] Rejected client connection"
      );
      client.close(1008, "Forbidden");
      return;
    }
    fastify.log.info("[WebSocket] Client connected");

    // Register client
    websocketManager.registerClient(client);

    // Send snapshot for subscribed topics on connect
    const sendSnapshot = () => {
      websocketManager.sendSnapshot(client, (topic: Topic) => {
        if (topic === "engine") {
          const state = engineAdapter.getState();
          // Send appropriate event based on actual status
          if (state.status === "connected") {
            return {
              type: "engine.connected",
              state,
            };
          } else if (state.status === "error") {
            return {
              type: "engine.error",
              error: state.error || "Unknown error",
            };
          } else {
            // disconnected or connecting
            return {
              type: "engine.status",
              status: state.status,
              error: state.error,
            };
          }
        } else if (topic === "video") {
          // V1: Placeholder
          return {
            type: "video.status",
            status: "not-configured",
          };
        }
        return null;
      });
    };

    // Handle incoming messages
    client.on("message", (message: Buffer) => {
      try {
        const data: ClientMessage = JSON.parse(message.toString());

        if (data.type === "subscribe") {
          // Validate topics
          const validTopics = data.topics.filter(
            (t): t is Topic => t === "engine" || t === "video"
          );

          if (validTopics.length > 0) {
            websocketManager.subscribe(client, validTopics);
            fastify.log.info(
              `[WebSocket] Client subscribed to topics: ${validTopics.join(
                ", "
              )}`
            );

            // Send snapshot after subscription
            sendSnapshot();
          }
        } else if (data.type === "unsubscribe") {
          const validTopics = data.topics.filter(
            (t): t is Topic => t === "engine" || t === "video"
          );

          if (validTopics.length > 0) {
            websocketManager.unsubscribe(client, validTopics);
            fastify.log.info(
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
      fastify.log.info("[WebSocket] Client disconnected");
      websocketManager.unregisterClient(client);
    });

    // Handle errors
    client.on("error", (error: Error) => {
      fastify.log.error({ err: error }, "[WebSocket] Error");
      websocketManager.unregisterClient(client);
    });
  });
}
