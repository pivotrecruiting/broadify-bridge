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
      { plugin: routes.registerVideoRoute, options: { getStatus: expect.any(Function) } },
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

    // The local video status mirrors get_status: live_program and meeting
    // capability blocks side by side.
    const videoOptions = calls.find(
      (call) => call.plugin === routes.registerVideoRoute,
    )?.options as { getStatus: () => { capabilities: Record<string, unknown> } };
    const capabilities = videoOptions.getStatus().capabilities;
    expect(capabilities.live_program).toEqual(
      expect.objectContaining({ supported: expect.any(Boolean) }),
    );
    // The local status never starts the encoder probe, it only reports what
    // the relay path has already obtained: nothing here, so the probe is
    // pending and there is no recording block. A platform without a recorder
    // needs no probe and reports an empty list.
    const hasRecorder =
      process.platform === "darwin" || process.platform === "win32";
    expect(capabilities.meeting).toEqual({
      program_portrait: process.platform === "darwin",
      layer_canvas: true,
      program_formats: {
        max_width: 1920,
        max_height: 1080,
        fps: process.platform === "darwin" ? [25, 30, 50, 60] : [25, 30],
        keyer_max_fps: 30,
      },
      ...(hasRecorder
        ? { recording_probe: "pending" }
        : {
            recording_probe: "done",
            recording: { codecs: [], upload_copy: false },
          }),
      // No bridge context here: no platform address, no upload.
      recording_upload: false,
    });
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
