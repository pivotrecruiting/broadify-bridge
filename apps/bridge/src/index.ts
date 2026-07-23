import dotenv from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadDefaultConfig } from "./default-config-loader.js";

loadDefaultConfig();

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

// Orphan watchdog: the desktop app passes its PID via env (a ppid comparison
// is unreliable - the bridge is spawned detached and re-parented). When the
// desktop app is gone, exit instead of living on as an orphan that keeps the
// port bound and helper processes (camera!) alive.
const bridgeParentPid = Number.parseInt(process.env.BRIDGE_PARENT_PID ?? "", 10);
if (Number.isFinite(bridgeParentPid) && bridgeParentPid > 0) {
  let parentDeathHandled = false;
  setInterval(() => {
    try {
      process.kill(bridgeParentPid, 0);
    } catch {
      if (parentDeathHandled) {
        return;
      }
      parentDeathHandled = true;
      // Reuse the SIGTERM path so helpers (meeting helper, renderers) are
      // stopped gracefully; force-exit if that shutdown hangs.
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => {
        process.exit(0);
      }, 10_000).unref();
    }
  }, 2000).unref();
}

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
