import Fastify from "fastify";
import type { BridgeConfigT } from "./config.js";
import { registerStatusRoute } from "./routes/status.js";

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
  } catch (err) {
    server.log.error(err);
    process.exit(1);
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

