import dotenv from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

const loadDotenv = () => {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  let currentDir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(currentDir, ".env");
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath });
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
};

loadDotenv();

/**
 * Bridge entry point
 * Parses CLI arguments, validates configuration, and starts the server
 */
async function main() {
  const { parseConfig } = await import("./config.js");
  const { createServer, startServer } = await import("./server.js");
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
