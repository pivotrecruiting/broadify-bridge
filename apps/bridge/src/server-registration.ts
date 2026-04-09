import type { RelayClient } from "./services/relay-client.js";
import type { BridgeConfigT } from "./config.js";

const MAX_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;

type RegisterFnT = (plugin: any, options?: any) => any;

type RouteRegistrarsT = {
  registerStatusRoute: any;
  registerDevicesRoute: any;
  registerOutputsRoute: any;
  registerConfigRoute: any;
  registerEngineRoute: any;
  registerVideoRoute: any;
  registerGraphicsBrowserInputRoute: any;
  registerWebSocketRoute: any;
  registerRelayRoute: any;
  registerLogsRoute: any;
};

type PluginDepsT = {
  corsPlugin: any;
  websocketPlugin: any;
};

/**
 * Register Fastify plugins used by the bridge server.
 */
export async function registerServerPlugins(
  register: RegisterFnT,
  deps: PluginDepsT,
): Promise<void> {
  await register(deps.corsPlugin, {
    origin: true,
  });

  await register(deps.websocketPlugin, {
    options: {
      maxPayload: MAX_WS_PAYLOAD_BYTES,
    },
  });
}

/**
 * Register all bridge routes in the canonical order.
 */
export async function registerServerRoutes(
  register: RegisterFnT,
  params: {
    config: BridgeConfigT;
    relayClient?: RelayClient;
    routes: RouteRegistrarsT;
  },
): Promise<void> {
  const { routes } = params;

  await register(routes.registerStatusRoute, { config: params.config });
  await register(routes.registerDevicesRoute);
  await register(routes.registerOutputsRoute);
  await register(routes.registerConfigRoute);
  await register(routes.registerEngineRoute);
  await register(routes.registerVideoRoute);
  await register(routes.registerGraphicsBrowserInputRoute);
  await register(routes.registerWebSocketRoute);
  await register(routes.registerRelayRoute, {
    config: params.config,
    relayClient: params.relayClient,
  });
  await register(routes.registerLogsRoute);
}
