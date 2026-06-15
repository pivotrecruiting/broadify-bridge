import {
  registerServerPlugins,
  registerServerRoutes,
} from "./server-registration.js";

describe("registerServerPlugins", () => {
  it("registers cors and websocket plugin with expected options", async () => {
    const calls: Array<{ plugin: unknown; options?: unknown }> = [];
    const register = jest.fn(async (plugin: unknown, options?: unknown) => {
      calls.push({ plugin, options });
    });

    const corsPlugin = Symbol("cors");
    const websocketPlugin = Symbol("websocket");

    await registerServerPlugins({ register } as never, {
      corsPlugin: corsPlugin as any,
      websocketPlugin: websocketPlugin as any,
    });

    expect(calls).toEqual([
      {
        plugin: corsPlugin,
        options: { origin: true },
      },
      {
        plugin: websocketPlugin,
        options: {
          options: {
            maxPayload: 2 * 1024 * 1024,
          },
        },
      },
    ]);
  });
});

describe("registerServerRoutes", () => {
  it("registers all routes in canonical order with expected options", async () => {
    const calls: Array<{ plugin: unknown; options?: unknown }> = [];
    const register = jest.fn(async (plugin: unknown, options?: unknown) => {
      calls.push({ plugin, options });
    });

    const routes = {
      registerStatusRoute: Symbol("status"),
      registerDevicesRoute: Symbol("devices"),
      registerOutputsRoute: Symbol("outputs"),
      registerConfigRoute: Symbol("config"),
      registerEngineRoute: Symbol("engine"),
      registerVideoRoute: Symbol("video"),
      registerGraphicsBrowserInputRoute: Symbol("graphics-browser-input"),
      registerWebSocketRoute: Symbol("ws"),
      registerRelayRoute: Symbol("relay"),
      registerLogsRoute: Symbol("logs"),
    };

    const config = {
      host: "127.0.0.1",
      port: 8000,
      relayEnabled: false,
    };
    const relayClient = { id: "relay-client" } as any;

    await registerServerRoutes({ register } as never, {
      config: config as any,
      relayClient,
      routes: routes as any,
    });

    expect(calls).toEqual([
      { plugin: routes.registerStatusRoute, options: { config } },
      { plugin: routes.registerDevicesRoute, options: undefined },
      { plugin: routes.registerOutputsRoute, options: undefined },
      { plugin: routes.registerConfigRoute, options: undefined },
      { plugin: routes.registerEngineRoute, options: undefined },
      { plugin: routes.registerVideoRoute, options: undefined },
      { plugin: routes.registerGraphicsBrowserInputRoute, options: undefined },
      { plugin: routes.registerWebSocketRoute, options: undefined },
      {
        plugin: routes.registerRelayRoute,
        options: { config, relayClient },
      },
      { plugin: routes.registerLogsRoute, options: undefined },
    ]);
  });

  it("registers relay route with undefined relayClient when not provided", async () => {
    const calls: Array<{ plugin: unknown; options?: unknown }> = [];
    const register = jest.fn(async (plugin: unknown, options?: unknown) => {
      calls.push({ plugin, options });
    });

    const routes = {
      registerStatusRoute: Symbol("status"),
      registerDevicesRoute: Symbol("devices"),
      registerOutputsRoute: Symbol("outputs"),
      registerConfigRoute: Symbol("config"),
      registerEngineRoute: Symbol("engine"),
      registerVideoRoute: Symbol("video"),
      registerGraphicsBrowserInputRoute: Symbol("graphics-browser-input"),
      registerWebSocketRoute: Symbol("ws"),
      registerRelayRoute: Symbol("relay"),
      registerLogsRoute: Symbol("logs"),
    };

    const config = { host: "127.0.0.1", port: 8000, relayEnabled: false };

    await registerServerRoutes({ register } as never, {
      config: config as any,
      routes: routes as any,
    });

    const relayCall = calls.find((c) => c.plugin === routes.registerRelayRoute);
    expect(relayCall?.options).toEqual({ config, relayClient: undefined });
  });
});
