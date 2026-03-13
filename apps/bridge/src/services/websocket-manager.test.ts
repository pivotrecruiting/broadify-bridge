import { WebSocketManager } from "./websocket-manager.js";

type FakeClientT = {
  send: jest.Mock<void, [string]>;
};

const createClient = (sendImpl?: (payload: string) => void): FakeClientT => ({
  send: jest.fn((payload: string) => {
    if (sendImpl) {
      sendImpl(payload);
    }
  }),
});

describe("WebSocketManager", () => {
  it("registers clients and tracks subscriptions", () => {
    const manager = new WebSocketManager();
    const client = createClient();

    manager.registerClient(client);
    manager.subscribe(client, ["engine", "video"]);

    expect(manager.getClientCount()).toBe(1);
    expect(manager.getTopicSubscriberCount("engine")).toBe(1);
    expect(manager.getTopicSubscriberCount("video")).toBe(1);
    expect(Array.from(manager.getClientTopics(client))).toEqual([
      "engine",
      "video",
    ]);
  });

  it("unsubscribes from selected topics only", () => {
    const manager = new WebSocketManager();
    const client = createClient();

    manager.registerClient(client);
    manager.subscribe(client, ["engine", "video"]);
    manager.unsubscribe(client, ["video"]);

    expect(Array.from(manager.getClientTopics(client))).toEqual(["engine"]);
    expect(manager.getTopicSubscriberCount("engine")).toBe(1);
    expect(manager.getTopicSubscriberCount("video")).toBe(0);
  });

  it("broadcasts only to subscribed clients", () => {
    const manager = new WebSocketManager();
    const engineClient = createClient();
    const videoClient = createClient();

    manager.registerClient(engineClient);
    manager.registerClient(videoClient);
    manager.subscribe(engineClient, ["engine"]);
    manager.subscribe(videoClient, ["video"]);

    manager.broadcast("engine", {
      type: "engine.status",
      status: "connected",
    });

    expect(engineClient.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "engine.status",
        status: "connected",
      }),
    );
    expect(videoClient.send).not.toHaveBeenCalled();
  });

  it("removes client when broadcast send throws", () => {
    const manager = new WebSocketManager();
    const badClient = createClient(() => {
      throw new Error("socket closed");
    });

    manager.registerClient(badClient);
    manager.subscribe(badClient, ["engine"]);

    manager.broadcast("engine", {
      type: "engine.status",
      status: "connected",
    });

    expect(manager.getClientCount()).toBe(0);
  });

  it("sends snapshots only for subscribed topics", () => {
    const manager = new WebSocketManager();
    const client = createClient();

    manager.registerClient(client);
    manager.subscribe(client, ["engine"]);

    manager.sendSnapshot(client, (topic) => {
      if (topic === "engine") {
        return {
          type: "engine.connected",
          state: { status: "connected", macros: [] },
        };
      }
      return {
        type: "video.status",
        status: "not-configured",
      };
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "engine.connected",
        state: { status: "connected", macros: [] },
      }),
    );
  });

  it("removes client when direct send throws", () => {
    const manager = new WebSocketManager();
    const client = createClient(() => {
      throw new Error("socket closed");
    });

    manager.registerClient(client);
    manager.sendToClient(client, {
      type: "video.status",
      status: "not-configured",
    });

    expect(manager.getClientCount()).toBe(0);
  });
});
