import {
  buildWebSocketSnapshot,
  normalizeWebSocketTopics,
} from "./websocket-contract.js";

describe("normalizeWebSocketTopics", () => {
  it("keeps only supported topics", () => {
    expect(
      normalizeWebSocketTopics(["engine", "invalid", "video", "foo"]),
    ).toEqual(["engine", "video"]);
  });

  it("returns empty array when no supported topics are present", () => {
    expect(normalizeWebSocketTopics(["foo", "bar"])).toEqual([]);
  });
});

describe("buildWebSocketSnapshot", () => {
  it("returns engine.connected for connected engine state", () => {
    const state = {
      status: "connected" as const,
      macros: [],
      ip: "10.0.0.10",
      port: 9910,
      type: "atem" as const,
    };

    expect(buildWebSocketSnapshot("engine", state)).toEqual({
      type: "engine.connected",
      state,
    });
  });

  it("returns engine.error for error engine state", () => {
    expect(
      buildWebSocketSnapshot("engine", {
        status: "error",
        macros: [],
        error: "dial failed",
      }),
    ).toEqual({
      type: "engine.error",
      error: "dial failed",
    });
  });

  it("returns engine.status for non-connected engine states", () => {
    expect(
      buildWebSocketSnapshot("engine", {
        status: "connecting",
        macros: [],
      }),
    ).toEqual({
      type: "engine.status",
      status: "connecting",
      error: undefined,
    });
  });

  it("returns placeholder video status for video topic", () => {
    expect(
      buildWebSocketSnapshot("video", {
        status: "disconnected",
        macros: [],
      }),
    ).toEqual({
      type: "video.status",
      status: "not-configured",
    });
  });
});
