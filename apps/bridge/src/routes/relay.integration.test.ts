import Fastify from "fastify";
import { registerRelayRoute } from "./relay.js";

describe("registerRelayRoute integration", () => {
  it("returns disconnected status when relay client is missing", async () => {
    const app = Fastify();

    await app.register(registerRelayRoute, {
      config: {
        host: "127.0.0.1",
        port: 8000,
        bridgeId: "bridge-1",
      },
      enforceLocalOrToken: () => true,
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/relay/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connected: false,
      bridgeId: "bridge-1",
      lastSeen: null,
      error: "Relay client not initialized",
    });

    await app.close();
  });

  it("returns relay client state when available", async () => {
    const app = Fastify();
    const lastSeen = new Date("2026-02-28T10:00:00.000Z");

    await app.register(registerRelayRoute, {
      config: {
        host: "127.0.0.1",
        port: 8000,
        bridgeId: "bridge-1",
      },
      relayClient: {
        isConnected: () => true,
        getLastSeen: () => lastSeen,
      },
      enforceLocalOrToken: () => true,
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/relay/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connected: true,
      bridgeId: "bridge-1",
      lastSeen: lastSeen.toISOString(),
    });

    await app.close();
  });

  it("returns guard response when blocked", async () => {
    const app = Fastify();

    await app.register(registerRelayRoute, {
      config: {
        host: "127.0.0.1",
        port: 8000,
      },
      enforceLocalOrToken: (_request: unknown, reply: { code: (status: number) => { send: (payload: unknown) => void } }) => {
        reply.code(401).send({
          success: false,
          error: "Unauthorized",
        });
        return false;
      },
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/relay/status",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      error: "Unauthorized",
    });

    await app.close();
  });
});
