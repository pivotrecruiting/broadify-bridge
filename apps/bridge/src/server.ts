import Fastify from "fastify";
import type { BridgeConfigT } from "./config.js";
import { registerStatusRoute } from "./routes/status.js";
import { registerOutputsRoute } from "./routes/outputs.js";

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

  // Register routes
  await server.register(registerStatusRoute, { config });
  await server.register(registerOutputsRoute);

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
  } catch (err: any) {
    // Check for port already in use
    if (err?.code === "EADDRINUSE") {
      server.log.error(
        `Port ${config.port} is already in use. Please choose a different port.`
      );
      process.exit(1);
    }
    
    // If address not available and not already using 0.0.0.0, try fallback
    if (
      err?.code === "EADDRNOTAVAIL" &&
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
      } catch (fallbackErr: any) {
        if (fallbackErr?.code === "EADDRINUSE") {
          server.log.error(
            `Port ${config.port} is already in use. Please choose a different port.`
          );
        } else {
          server.log.error("Fallback to 0.0.0.0 also failed:", fallbackErr);
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

