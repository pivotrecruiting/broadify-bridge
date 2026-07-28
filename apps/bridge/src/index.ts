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

// Last-resort handlers: without these, a single unhandled rejection kills the
// bridge with no log line and no helper cleanup (Node >= 15 hard-exits). Log,
// then reuse the SIGTERM path so the graceful shutdown in server.ts runs and
// helpers (camera, recorder!) are stopped; force-exit if that hangs.
let fatalErrorHandled = false;
const handleFatalError = (kind: string, error: unknown): void => {
  console.error(`[Bridge] ${kind}:`, error);
  if (fatalErrorHandled) {
    return;
  }
  fatalErrorHandled = true;
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => {
    process.exit(1);
  }, 30_000).unref();
};
process.on("uncaughtException", (error) => {
  handleFatalError("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  handleFatalError("unhandledRejection", reason);
});

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
      // stopped gracefully; force-exit if that shutdown hangs. The budget
      // must cover MP4 finalization on death-while-recording (~20s).
      process.kill(process.pid, "SIGTERM");
      setTimeout(() => {
        process.exit(0);
      }, 30_000).unref();
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
