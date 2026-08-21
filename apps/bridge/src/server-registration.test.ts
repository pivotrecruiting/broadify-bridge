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
        options: { origin: expect.any(Function) },
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

    // The origin callback must reflect only allowlisted origins - never act
    // like `origin: true` (which reflects any page and enables local CSRF).
    const corsOptions = calls[0]?.options as {
      origin: (
        origin: string | undefined,
        callback: (error: Error | null, allow: boolean) => void,
      ) => void;
    };
    const evaluateOrigin = (origin: string | undefined): boolean => {
      let allowed = false;
      corsOptions.origin(origin, (_error, allow) => {
        allowed = allow;
      });
      return allowed;
    };

    expect(evaluateOrigin("https://app.broadify.de")).toBe(true);
    expect(evaluateOrigin("http://localhost:3000")).toBe(true);
    expect(evaluateOrigin(undefined)).toBe(true);
    expect(evaluateOrigin("https://evil.example")).toBe(false);
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
      registerMeetingCameraRoute: Symbol("meeting-camera"),
      registerMeetingMediaRoute: Symbol("meeting-media"),
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
      { plugin: routes.registerMeetingCameraRoute, options: undefined },
      { plugin: routes.registerMeetingMediaRoute, options: undefined },
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
      registerMeetingCameraRoute: Symbol("meeting-camera"),
      registerMeetingMediaRoute: Symbol("meeting-media"),
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
