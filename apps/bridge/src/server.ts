import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import pino from "pino";
import { registerStatusRoute } from "./routes/status.js";
import { registerOutputsRoute } from "./routes/outputs.js";
import { registerDevicesRoute } from "./routes/devices.js";
import { registerConfigRoute } from "./routes/config.js";
import { registerEngineRoute } from "./routes/engine.js";
import { registerVideoRoute } from "./routes/video.js";
import { registerWebSocketRoute } from "./routes/websocket.js";
import { registerRelayRoute } from "./routes/relay.js";
import { registerLogsRoute } from "./routes/logs.js";
import { initializeModules } from "./modules/index.js";
import { RelayClient } from "./services/relay-client.js";
import { deviceCache } from "./services/device-cache.js";
import {
  resolveUserDataDir,
  setBridgeContext,
} from "./services/bridge-context.js";
import { graphicsManager } from "./services/graphics/graphics-manager.js";
import { ensureBridgeLogFile } from "./services/log-file.js";
import { bindConsoleToLogger } from "./services/console-to-pino.js";
import type { BridgeConfigT } from "./config.js";

/**
 * Create and configure Fastify server instance.
 *
 * @param config Bridge startup config.
 * @returns Fastify server instance.
 */
export async function createServer(config: BridgeConfigT) {
  const userDataDir = resolveUserDataDir(config);
  const logPath = await ensureBridgeLogFile(userDataDir);

  const consoleLevel =
    process.env.NODE_ENV === "production" ? "info" : "debug";
  const logger = pino(
    { level: "debug" },
    pino.multistream([
      { level: consoleLevel, stream: process.stdout },
      { level: "debug", stream: pino.destination({ dest: logPath, sync: false }) },
    ])
  );
  bindConsoleToLogger(logger);

  const server = Fastify({
    logger,
    disableRequestLogging: true,
  });

  setBridgeContext({
    userDataDir,
    logPath,
    logger: {
      info: (msg: string) => server.log.info(msg),
      warn: (msg: string) => server.log.warn(msg),
      error: (msg: string) => server.log.error(msg),
    },
    bridgeId: config.bridgeId,
    bridgeName: config.bridgeName,
    pairingCode: config.pairingCode,
    pairingExpiresAt: config.pairingExpiresAt,
  });

  await graphicsManager.initialize();

  // Register CORS plugin (dev-friendly; tighten in production).
  await server.register(cors, {
    origin: true, // Allow all origins (for development)
    // For production: origin: ["http://localhost:3000", "https://yourdomain.com"]
  });
  server.log.info("[Server] CORS plugin registered");

  // Register WebSocket plugin.
  await server.register(websocket);
  server.log.info("[Server] WebSocket plugin registered");

  // Initialize device modules and device watchers.
  initializeModules();
  server.log.info("[Server] Device modules initialized");
  deviceCache.initializeWatchers();
  server.log.info("[Server] Device watchers initialized");

  // Initialize relay client if bridgeId is configured.
  // relayUrl defaults to wss://broadify-relay.fly.dev if not provided.
  let relayClient: RelayClient | undefined = undefined;
  if (config.bridgeId) {
    const relayUrl = config.relayUrl || "wss://broadify-relay.fly.dev";
    relayClient = new RelayClient(
      config.bridgeId,
      relayUrl,
      {
        info: (msg: string) => server.log.info(`[Relay] ${msg}`),
        error: (msg: string) => server.log.error(`[Relay] ${msg}`),
        warn: (msg: string) => server.log.warn(`[Relay] ${msg}`),
      },
      config.bridgeName
    );
    server.log.info(
      `[Server] Relay client initialized (relayUrl: ${relayUrl})`
    );
  } else {
    server.log.info(
      "[Server] Relay client not initialized (bridgeId not configured)"
    );
  }

  // Register routes.
  await server.register(registerStatusRoute, { config });
  await server.register(registerDevicesRoute);
  await server.register(registerOutputsRoute);
  await server.register(registerConfigRoute);
  await server.register(registerEngineRoute);
  await server.register(registerVideoRoute);
  await server.register(registerWebSocketRoute);
  await server.register(registerRelayRoute, { config, relayClient });
  await server.register(registerLogsRoute);
  server.log.info("[Server] All routes registered");

  // Note: Engine connection is now controlled by the Web-App
  // The Web-App handles auto-connect and stores config in localStorage
  // Bridge no longer auto-connects on startup

  // Store relay client in server instance for later use
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).relayClient = relayClient;

  return server;
}

/**
 * Start the server and handle graceful shutdown
 */
export async function startServer(
  server: Awaited<ReturnType<typeof createServer>>,
  config: BridgeConfigT
): Promise<void> {
  try {
    await server.listen({ host: config.host, port: config.port });
    server.log.info(
      `Bridge server listening on http://${config.host}:${config.port}`
    );

    // Start relay client after server is listening
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const relayClient = (server as any).relayClient as RelayClient | undefined;
    if (relayClient) {
      server.log.info("[Server] Starting relay client connection...");
      await relayClient.connect();
    }
  } catch (err: unknown) {
    // Check for port already in use
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = err as any;
    if (error?.code === "EADDRINUSE") {
      server.log.error(
        `Port ${config.port} is already in use. Please choose a different port.`
      );
      process.exit(1);
    }

    // If address not available and not already using 0.0.0.0, try fallback
    if (
      error?.code === "EADDRNOTAVAIL" &&
      config.host !== "0.0.0.0" &&
      config.host !== "127.0.0.1"
    ) {
      server.log.warn(
        `Address ${config.host} not available, falling back to 0.0.0.0`
      );
      try {
        await server.listen({ host: "0.0.0.0", port: config.port });
        server.log.info(
          `Bridge server listening on http://0.0.0.0:${config.port} (fallback)`
        );
      } catch (fallbackErr: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fallbackError = fallbackErr as any;
        if (fallbackError?.code === "EADDRINUSE") {
          server.log.error(
            `Port ${config.port} is already in use. Please choose a different port.`
          );
        } else {
          server.log.error("Fallback to 0.0.0.0 also failed:", fallbackError);
        }
        process.exit(1);
      }
    } else {
      server.log.error(err);
      process.exit(1);
    }
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      // Disconnect relay client
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relayClient = (server as any).relayClient as
        | RelayClient
        | undefined;
      if (relayClient) {
        server.log.info("[Server] Disconnecting relay client...");
        await relayClient.disconnect();
      }

      server.log.info("[Graphics] Shutting down renderer...");
      try {
        await graphicsManager.shutdown();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        server.log.warn(
          `[Graphics] Shutdown encountered an error: ${message}`
        );
      }

      await server.close();
      server.log.info("Server closed");
      process.exit(0);
    } catch (err) {
      server.log.error(err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
