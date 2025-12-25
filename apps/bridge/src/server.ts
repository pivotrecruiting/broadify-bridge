import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { registerStatusRoute } from "./routes/status.js";
import { registerOutputsRoute } from "./routes/outputs.js";
import { registerDevicesRoute } from "./routes/devices.js";
import { registerConfigRoute } from "./routes/config.js";
import { registerEngineRoute } from "./routes/engine.js";
import { registerVideoRoute } from "./routes/video.js";
import { registerWebSocketRoute } from "./routes/websocket.js";
import { initializeModules } from "./modules/index.js";
import type { BridgeConfigT } from "./config.js";

/**
 * Create and configure Fastify server instance
 */
export async function createServer(config: BridgeConfigT) {
  const logger = {
    level: process.env.NODE_ENV === "production" ? "info" : "debug",
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              translateTime: "HH:MM:ss Z",
              ignore: "pid,hostname",
            },
          },
  };

  const server = Fastify({
    logger,
  });

  // Register CORS plugin
  await server.register(cors, {
    origin: true, // Allow all origins (for development)
    // For production: origin: ["http://localhost:3000", "https://yourdomain.com"]
  });
  server.log.info("[Server] CORS plugin registered");

  // Register WebSocket plugin
  await server.register(websocket);
  server.log.info("[Server] WebSocket plugin registered");

  // Initialize device modules
  initializeModules();
  server.log.info("[Server] Device modules initialized");

  // Register routes
  await server.register(registerStatusRoute, { config });
  await server.register(registerDevicesRoute);
  await server.register(registerOutputsRoute);
  await server.register(registerConfigRoute);
  await server.register(registerEngineRoute);
  await server.register(registerVideoRoute);
  await server.register(registerWebSocketRoute);
  server.log.info("[Server] All routes registered");

  // Note: Engine connection is now controlled by the Web-App
  // The Web-App handles auto-connect and stores config in localStorage
  // Bridge no longer auto-connects on startup

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
