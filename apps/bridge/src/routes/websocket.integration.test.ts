import { EventEmitter } from "events";
import { registerWebSocketRoute } from "./websocket.js";

class FakeSocket extends EventEmitter {
  public close = jest.fn<void, [number, string]>();
}

describe("registerWebSocketRoute integration", () => {
  const createFastifyStub = () => {
    const captured: { handler?: (connection: { socket: FakeSocket }, request: { ip: string }) => void } = {};
    const fastify = {
      get: jest.fn(
        (
          _path: string,
          _options: unknown,
          handler: (connection: { socket: FakeSocket }, request: { ip: string }) => void,
        ) => {
          captured.handler = handler;
        },
      ),
      log: {
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    };

    return { fastify, captured };
  };

  it("rejects unauthorized websocket connection", async () => {
    const { fastify, captured } = createFastifyStub();
    const websocketManager = {
      registerClient: jest.fn(),
      unregisterClient: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      sendSnapshot: jest.fn(),
    };

    await registerWebSocketRoute(fastify as any, {
      websocketManager,
      engineAdapter: { getState: () => ({ status: "disconnected", macros: [] }) },
      getAuthFailure: () => ({ status: 403, message: "Forbidden" }),
    });

    const socket = new FakeSocket();
    captured.handler?.({ socket }, { ip: "192.168.1.10" });

    expect(socket.close).toHaveBeenCalledWith(1008, "Forbidden");
    expect(websocketManager.registerClient).not.toHaveBeenCalled();
  });

  it("registers client, subscribes valid topics, and sends snapshot", async () => {
    const { fastify, captured } = createFastifyStub();
    const websocketManager = {
      registerClient: jest.fn(),
      unregisterClient: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      sendSnapshot: jest.fn(
        (
          _client: FakeSocket,
          getSnapshot: (
            topic: "engine" | "video",
          ) => Record<string, unknown> | null,
        ) => {
          const engineSnapshot = getSnapshot("engine");
          const videoSnapshot = getSnapshot("video");
          expect(engineSnapshot).toEqual({
            type: "engine.connected",
            state: {
              status: "connected",
              macros: [],
              ip: "10.0.0.10",
              port: 9910,
              type: "atem",
            },
          });
          expect(videoSnapshot).toEqual({
            type: "video.status",
            status: "not-configured",
          });
        },
      ),
    };

    await registerWebSocketRoute(fastify as any, {
      websocketManager,
      engineAdapter: {
        getState: () => ({
          status: "connected",
          macros: [],
          ip: "10.0.0.10",
          port: 9910,
          type: "atem" as const,
        }),
      },
      getAuthFailure: () => null,
    });

    const socket = new FakeSocket();
    captured.handler?.({ socket }, { ip: "127.0.0.1" });

    expect(websocketManager.registerClient).toHaveBeenCalledWith(socket);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "subscribe",
          topics: ["engine", "video", "invalid"],
        }),
      ),
    );

    expect(websocketManager.subscribe).toHaveBeenCalledWith(socket, [
      "engine",
      "video",
    ]);
    expect(websocketManager.sendSnapshot).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes only valid topics and unregisters on close/error", async () => {
    const { fastify, captured } = createFastifyStub();
    const websocketManager = {
      registerClient: jest.fn(),
      unregisterClient: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      sendSnapshot: jest.fn(),
    };

    await registerWebSocketRoute(fastify as any, {
      websocketManager,
      engineAdapter: { getState: () => ({ status: "disconnected", macros: [] }) },
      getAuthFailure: () => null,
    });

    const socket = new FakeSocket();
    captured.handler?.({ socket }, { ip: "127.0.0.1" });

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "unsubscribe",
          topics: ["video", "invalid"],
        }),
      ),
    );

    expect(websocketManager.unsubscribe).toHaveBeenCalledWith(socket, ["video"]);

    socket.emit("close");
    socket.emit("error", new Error("boom"));

    expect(websocketManager.unregisterClient).toHaveBeenCalledTimes(2);
    expect(websocketManager.unregisterClient).toHaveBeenNthCalledWith(1, socket);
    expect(websocketManager.unregisterClient).toHaveBeenNthCalledWith(2, socket);
  });
});
