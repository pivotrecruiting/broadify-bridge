import Fastify from "fastify";
import { registerStatusRoute } from "./status.js";

describe("registerStatusRoute integration", () => {
  it("returns combined bridge status payload", async () => {
    const app = Fastify();

    await app.register(registerStatusRoute, {
      config: {
        mode: "bridge",
        host: "127.0.0.1",
        port: 8000,
        bridgeName: "Studio A",
      },
      enforceLocalOrToken: () => true,
      getVersion: () => "1.2.3",
      getUptime: () => 42,
      runtimeConfig: {
        getConfig: () => ({ engine: { type: "atem", ip: "10.0.0.10", port: 9910 } }),
        getState: () => "configured",
        hasOutputs: () => true,
      },
      engineAdapter: {
        getState: () => ({
          status: "connected",
          macros: [{ id: 1, name: "Intro", status: "idle" as const }],
          type: "atem" as const,
        }),
      },
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      running: true,
      version: "1.2.3",
      uptime: 42,
      mode: "bridge",
      port: 8000,
      host: "127.0.0.1",
      bridgeName: "Studio A",
      state: "configured",
      outputsConfigured: true,
      engine: {
        configured: true,
        status: "connected",
        type: "atem",
        connected: true,
        macrosCount: 1,
      },
    });

    await app.close();
  });

  it("returns guard response when blocked", async () => {
    const app = Fastify();

    await app.register(registerStatusRoute, {
      config: {
        mode: "bridge",
        host: "127.0.0.1",
        port: 8000,
      },
      enforceLocalOrToken: (_request: unknown, reply: { code: (status: number) => { send: (payload: unknown) => void } }) => {
        reply.code(403).send({
          success: false,
          error: "Local-only endpoint",
        });
        return false;
      },
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: "Local-only endpoint",
    });

    await app.close();
  });
});
