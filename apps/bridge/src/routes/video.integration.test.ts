import Fastify from "fastify";
import { registerVideoRoute } from "./video.js";

describe("registerVideoRoute integration", () => {
  it("returns default placeholder video status", async () => {
    const app = Fastify();

    await app.register(registerVideoRoute, {
      enforceLocalOrToken: () => true,
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/video/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "not-configured",
      message: "Video I/O not yet configured",
    });

    await app.close();
  });

  it("returns injected custom video status", async () => {
    const app = Fastify();

    await app.register(registerVideoRoute, {
      enforceLocalOrToken: () => true,
      getStatus: () => ({
        status: "configured",
        message: "Video I/O ready",
      }),
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/video/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "configured",
      message: "Video I/O ready",
    });

    await app.close();
  });

  it("returns 500 when status provider throws", async () => {
    const app = Fastify();

    await app.register(registerVideoRoute, {
      enforceLocalOrToken: () => true,
      getStatus: () => {
        throw new Error("probe failed");
      },
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/video/status",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "Failed to get video status",
      message: "probe failed",
    });

    await app.close();
  });

  it("returns guard response when blocked", async () => {
    const app = Fastify();

    await app.register(registerVideoRoute, {
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
      url: "/video/status",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      success: false,
      error: "Local-only endpoint",
    });

    await app.close();
  });
});
