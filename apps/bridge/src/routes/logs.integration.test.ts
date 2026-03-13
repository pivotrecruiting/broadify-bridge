import Fastify from "fastify";
import { registerLogsRoute } from "./logs.js";

describe("registerLogsRoute integration", () => {
  it("returns tailed and filtered log content", async () => {
    const app = Fastify();
    const readFile = jest.fn(async () =>
      "line 1\nengine ok\nline 3\nENGINE warning\nline 5",
    );
    const writeFile = jest.fn(async () => undefined);

    await app.register(registerLogsRoute, {
      readFile,
      writeFile,
      getLogPath: () => "/tmp/bridge.log",
      enforceLocalOrToken: () => true,
    } as any);

    const response = await app.inject({
      method: "GET",
      url: "/logs?lines=3&filter=engine",
    });

    expect(response.statusCode).toBe(200);
    expect(readFile).toHaveBeenCalledWith("/tmp/bridge.log", "utf-8");
    expect(response.json()).toEqual({
      scope: "bridge",
      lines: 1,
      content: "ENGINE warning",
    });

    await app.close();
  });

  it("clears logs via POST /logs/clear", async () => {
    const app = Fastify();
    const readFile = jest.fn(async () => "existing content");
    const writeFile = jest.fn(async () => undefined);

    await app.register(registerLogsRoute, {
      readFile,
      writeFile,
      getLogPath: () => "/tmp/bridge.log",
      enforceLocalOrToken: () => true,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/logs/clear",
    });

    expect(response.statusCode).toBe(200);
    expect(writeFile).toHaveBeenCalledWith("/tmp/bridge.log", "");
    expect(response.json()).toEqual({
      scope: "bridge",
      cleared: true,
    });

    await app.close();
  });

  it("treats missing log file as cleared on POST /logs/clear", async () => {
    const app = Fastify();
    const readFile = jest.fn(async () => {
      const error = new Error("not found") as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    });
    const writeFile = jest.fn(async () => undefined);

    await app.register(registerLogsRoute, {
      readFile,
      writeFile,
      getLogPath: () => "/tmp/bridge.log",
      enforceLocalOrToken: () => true,
    } as any);

    const response = await app.inject({
      method: "POST",
      url: "/logs/clear",
    });

    expect(response.statusCode).toBe(200);
    expect(writeFile).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      scope: "bridge",
      cleared: true,
    });

    await app.close();
  });

  it("returns security response when auth guard blocks access", async () => {
    const app = Fastify();
    const readFile = jest.fn(async () => "content");
    const writeFile = jest.fn(async () => undefined);

    await app.register(registerLogsRoute, {
      readFile,
      writeFile,
      getLogPath: () => "/tmp/bridge.log",
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
      url: "/logs",
    });

    expect(response.statusCode).toBe(403);
    expect(readFile).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      success: false,
      error: "Local-only endpoint",
    });

    await app.close();
  });
});
