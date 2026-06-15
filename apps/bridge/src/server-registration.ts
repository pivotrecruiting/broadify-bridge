import type { RelayClient } from "./services/relay-client.js";
import type { BridgeConfigT } from "./config.js";

const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;

// Fastify's concrete register type becomes overly specific once the server is
// instantiated with a custom logger. This narrow escape hatch keeps the helper
// callable with the real server instance while route/plugin values stay typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RegisterServerT = { register: (...args: any[]) => unknown };

type RouteRegistrarsT = {
  registerStatusRoute: typeof import("./routes/status.js").registerStatusRoute;
  registerDevicesRoute: typeof import("./routes/devices.js").registerDevicesRoute;
  registerOutputsRoute: typeof import("./routes/outputs.js").registerOutputsRoute;
  registerConfigRoute: typeof import("./routes/config.js").registerConfigRoute;
  registerEngineRoute: typeof import("./routes/engine.js").registerEngineRoute;
  registerVideoRoute: typeof import("./routes/video.js").registerVideoRoute;
  registerGraphicsBrowserInputRoute: typeof import("./routes/graphics-browser-input.js").registerGraphicsBrowserInputRoute;
  registerWebSocketRoute: typeof import("./routes/websocket.js").registerWebSocketRoute;
  registerRelayRoute: typeof import("./routes/relay.js").registerRelayRoute;
  registerLogsRoute: typeof import("./routes/logs.js").registerLogsRoute;
};

type PluginDepsT = {
  corsPlugin: typeof import("@fastify/cors").default;
  websocketPlugin: typeof import("@fastify/websocket").default;
};

/**
 * Register Fastify plugins used by the bridge server.
 */
export async function registerServerPlugins(
  server: RegisterServerT,
  deps: PluginDepsT,
): Promise<void> {
  await server.register(deps.corsPlugin, {
    origin: true,
  });

  await server.register(deps.websocketPlugin, {
    options: {
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    },
  });
}

/**
 * Register all bridge routes in the canonical order.
 */
export async function registerServerRoutes(
  server: RegisterServerT,
  params: {
    config: BridgeConfigT;
    relayClient?: RelayClient;
    routes: RouteRegistrarsT;
  },
): Promise<void> {
  const { routes } = params;

  await server.register(routes.registerStatusRoute, { config: params.config });
  await server.register(routes.registerDevicesRoute);
  await server.register(routes.registerOutputsRoute);
  await server.register(routes.registerConfigRoute);
  await server.register(routes.registerEngineRoute);
  await server.register(routes.registerVideoRoute);
  await server.register(routes.registerGraphicsBrowserInputRoute);
  await server.register(routes.registerWebSocketRoute);
  await server.register(routes.registerRelayRoute, {
    config: params.config,
    relayClient: params.relayClient,
  });
  await server.register(routes.registerLogsRoute);
}
