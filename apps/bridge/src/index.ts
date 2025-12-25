import { parseConfig } from "./config.js";
import { createServer, startServer } from "./server.js";

/**
 * Bridge entry point
 * Parses CLI arguments, validates configuration, and starts the server
 */
async function main() {
  // Parse CLI arguments (skip first two: node executable and script path)
  const args = process.argv.slice(2);
  const config = parseConfig(args);

  // Create and start server
  const server = await createServer(config);
  await startServer(server, config);
}

// Start the bridge
main().catch((error) => {
  console.error("Failed to start bridge:", error);
  process.exit(1);
});

