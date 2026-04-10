import { EventEmitter } from "events";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { registerGraphicsBrowserInputRoute } from "./graphics-browser-input.js";

class FakeSocket extends EventEmitter {
  public send = jest.fn<void, [string]>();
  public close = jest.fn<void, [number, string]>();
}

describe("registerGraphicsBrowserInputRoute integration", () => {
  it("serves page, state and assets", async () => {
    const app = Fastify();
    await app.register(websocket);

    await app.register(registerGraphicsBrowserInputRoute, {
      enforceLocalOrToken: () => true,
      getAuthFailure: () => null,
      buildBrowserInputPageHtml: () => "<html>browser-input</html>",
      browserInputRuntime: {
        getSnapshot: () => ({
          mode: "browser_input" as const,
          ready: true,
          stateStatus: "empty" as const,
          stateValid: true,
          browserInputUrl: "http://127.0.0.1:8787/graphics/browser-input",
          browserInputWsUrl: "ws://127.0.0.1:8787/graphics/browser-input/ws",
          recommendedInputName: "Broadify Browser Input",
          transport: "websocket" as const,
          browserClientCount: 0,
          lastBrowserClientSeenAt: null,
          stateVersion: 1,
          format: { width: 1920, height: 1080, fps: 50 },
          lastError: null,
          layers: [],
        }),
        subscribe: () => () => undefined,
        markBrowserClientSeen: jest.fn(),
        registerBrowserClient: jest.fn(),
        unregisterBrowserClient: jest.fn(),
        reportError: jest.fn(),
      },
      assetRegistry: {
        getAsset: (assetId: string) =>
          assetId === "logo"
            ? {
                assetId: "logo",
                name: "Logo",
                mime: "image/png",
                size: 4,
                filePath: "/tmp/logo.png",
                createdAt: "2026-01-01T00:00:00.000Z",
              }
            : null,
      },
      readFile: async () => Buffer.from("test"),
    } as any);

    const pageResponse = await app.inject({
      method: "GET",
      url: "/graphics/browser-input",
    });
    expect(pageResponse.statusCode).toBe(200);
    expect(pageResponse.body).toContain("browser-input");

    const stateResponse = await app.inject({
      method: "GET",
      url: "/graphics/browser-input/state",
    });
    expect(stateResponse.statusCode).toBe(200);
    expect(stateResponse.json()).toMatchObject({
      mode: "browser_input",
      ready: true,
      stateStatus: "empty",
    });

    const assetResponse = await app.inject({
      method: "GET",
      url: "/graphics/browser-input/assets/logo",
    });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["content-type"]).toContain("image/png");

    const missingAssetResponse = await app.inject({
      method: "GET",
      url: "/graphics/browser-input/assets/missing",
    });
    expect(missingAssetResponse.statusCode).toBe(404);

    await app.close();
  });

  it("registers websocket clients and sends initial snapshot", async () => {
    const captured: {
      handler?: (
        connection: { socket: FakeSocket },
        request: { ip: string }
      ) => void;
    } = {};
    const fastify = {
      get: jest.fn(
        (
          path: string,
          optionsOrHandler: unknown,
          maybeHandler?: (
            connection: { socket: FakeSocket },
            request: { ip: string }
          ) => void
        ) => {
          if (path === "/graphics/browser-input/ws") {
            captured.handler =
              typeof maybeHandler === "function"
                ? maybeHandler
                : (optionsOrHandler as typeof maybeHandler);
          }
        }
      ),
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    };
    const registerBrowserClient = jest.fn();
    const unregisterBrowserClient = jest.fn();

    await registerGraphicsBrowserInputRoute(fastify as any, {
      enforceLocalOrToken: () => true,
      getAuthFailure: () => null,
      buildBrowserInputPageHtml: () => "<html></html>",
      browserInputRuntime: {
        getSnapshot: () => ({
          mode: "browser_input" as const,
          ready: true,
          stateStatus: "empty" as const,
          stateValid: true,
          browserInputUrl: "http://127.0.0.1:8787/graphics/browser-input",
          browserInputWsUrl: "ws://127.0.0.1:8787/graphics/browser-input/ws",
          recommendedInputName: "Broadify Browser Input",
          transport: "websocket" as const,
          browserClientCount: 0,
          lastBrowserClientSeenAt: null,
          stateVersion: 1,
          format: { width: 1920, height: 1080, fps: 50 },
          lastError: null,
          layers: [],
        }),
        subscribe: () => () => undefined,
        markBrowserClientSeen: jest.fn(),
        registerBrowserClient,
        unregisterBrowserClient,
        reportError: jest.fn(),
      },
      assetRegistry: {
        getAsset: () => null,
      },
      readFile: async () => Buffer.from(""),
    } as any);

    const socket = new FakeSocket();
    captured.handler?.({ socket }, { ip: "127.0.0.1" });

    expect(registerBrowserClient).toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"browser_input.snapshot"')
    );

    socket.emit("close");
    expect(unregisterBrowserClient).toHaveBeenCalled();
  });

  it("closes unauthorized websocket clients before runtime registration", async () => {
    const captured: {
      handler?: (
        connection: { socket: FakeSocket },
        request: { ip: string }
      ) => void;
    } = {};
    const fastify = {
      get: jest.fn(
        (
          path: string,
          optionsOrHandler: unknown,
          maybeHandler?: (
            connection: { socket: FakeSocket },
            request: { ip: string }
          ) => void
        ) => {
          if (path === "/graphics/browser-input/ws") {
            captured.handler =
              typeof maybeHandler === "function"
                ? maybeHandler
                : (optionsOrHandler as typeof maybeHandler);
          }
        }
      ),
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    };
    const registerBrowserClient = jest.fn();

    await registerGraphicsBrowserInputRoute(fastify as any, {
      enforceLocalOrToken: () => true,
      getAuthFailure: () => ({ status: 401, message: "Unauthorized" }),
      buildBrowserInputPageHtml: () => "<html></html>",
      browserInputRuntime: {
        getSnapshot: () => ({
          mode: "browser_input" as const,
          ready: true,
          stateStatus: "empty" as const,
          stateValid: true,
          browserInputUrl: "http://127.0.0.1:8787/graphics/browser-input",
          browserInputWsUrl: "ws://127.0.0.1:8787/graphics/browser-input/ws",
          recommendedInputName: "Broadify Browser Input",
          transport: "websocket" as const,
          browserClientCount: 0,
          lastBrowserClientSeenAt: null,
          stateVersion: 1,
          format: { width: 1920, height: 1080, fps: 50 },
          lastError: null,
          layers: [],
        }),
        subscribe: () => () => undefined,
        markBrowserClientSeen: jest.fn(),
        registerBrowserClient,
        unregisterBrowserClient: jest.fn(),
        reportError: jest.fn(),
      },
      assetRegistry: {
        getAsset: () => null,
      },
      readFile: async () => Buffer.from(""),
    } as any);

    const socket = new FakeSocket();
    captured.handler?.({ socket }, { ip: "192.168.1.20" });

    expect(socket.close).toHaveBeenCalledWith(1008, "Forbidden");
    expect(registerBrowserClient).not.toHaveBeenCalled();
  });
});
