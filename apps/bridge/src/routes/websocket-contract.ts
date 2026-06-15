import type { EngineStateT } from "../services/engine-types.js";

export type WebSocketTopicT = "engine" | "video";

export type WebSocketServerMessageT =
  | { type: "engine.status"; status: EngineStateT["status"]; error?: string }
  | {
      type: "engine.macroExecution";
      execution: EngineStateT["macroExecution"];
      lastCompletedExecution?: EngineStateT["lastCompletedMacroExecution"];
    }
  | { type: "engine.connected"; state: EngineStateT }
  | { type: "engine.error"; error: string }
  | { type: "video.status"; status: "not-configured" };

/**
 * Filter user-provided topic names to the supported topic set.
 */
export function normalizeWebSocketTopics(topics: string[]): WebSocketTopicT[] {
  return topics.filter(
    (topic): topic is WebSocketTopicT => topic === "engine" || topic === "video",
  );
}

/**
 * Build a snapshot payload for a subscribed topic.
 */
export function buildWebSocketSnapshot(
  topic: WebSocketTopicT,
  engineState: EngineStateT,
): WebSocketServerMessageT | null {
  if (topic === "engine") {
    if (engineState.status === "connected") {
      return {
        type: "engine.connected",
        state: engineState,
      };
    }

    if (engineState.status === "error") {
      return {
        type: "engine.error",
        error: engineState.error || "Unknown error",
      };
    }

    return {
      type: "engine.status",
      status: engineState.status,
      error: engineState.error,
    };
  }

  if (topic === "video") {
    return {
      type: "video.status",
      status: "not-configured",
    };
  }

  return null;
}
