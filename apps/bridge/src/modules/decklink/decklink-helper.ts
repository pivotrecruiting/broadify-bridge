import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBridgeContext } from "../../services/bridge-context.js";

const DEFAULT_HELPER_TIMEOUT_MS = 4000;
const HELPER_PATH_ENV = "DECKLINK_HELPER_PATH";

export type DecklinkHelperEvent = {
  type: "devices" | "device_added" | "device_removed";
  devices: unknown[];
};

export type DecklinkDisplayModeT = {
  name: string;
  id: number;
  width: number;
  height: number;
  fps: number;
  frameDuration: number;
  timeScale: number;
  fieldDominance: string;
  connection: string;
  pixelFormats: string[];
};

export type DecklinkDisplayModeQueryT = {
  width?: number;
  height?: number;
  fps?: number;
  requireKeying?: boolean;
};

const getLogger = () => {
  try {
    return getBridgeContext().logger;
  } catch {
    return {
      info: (msg: string) => console.info(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
  }
};

/**
 * Resolve the DeckLink helper binary path.
 *
 * @returns Absolute path to the helper binary.
 */
export function resolveDecklinkHelperPath(): string {
  const envPath = process.env[HELPER_PATH_ENV];
  if (envPath) {
    return envPath;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Dev path: repo-local helper binary
  const devPath = join(
    __dirname,
    "../../../../native/decklink-helper/decklink-helper"
  );

  // Production path: packaged resources
  const resourcesPath = process.resourcesPath;
  const prodPath = resourcesPath
    ? join(resourcesPath, "native", "decklink-helper", "decklink-helper")
    : "";

  if (process.env.NODE_ENV === "production" && prodPath) {
    return prodPath;
  }

  return devPath;
}

/**
 * Execute the DeckLink helper in list mode.
 *
 * @returns Array of raw device objects from helper output.
 */
export async function listDecklinkDevices(): Promise<unknown[]> {
  if (platform() !== "darwin") {
    return [];
  }

  const logger = getLogger();
  const helperPath = resolveDecklinkHelperPath();
  try {
    await access(helperPath, constants.X_OK);
  } catch {
    logger.warn(
      `[DecklinkHelper] Helper not found or not executable at ${helperPath}`
    );
    return [];
  }

  return new Promise((resolve) => {
    const processRef = spawn(helperPath, ["--list"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      processRef.kill("SIGTERM");
      resolve([]);
    }, DEFAULT_HELPER_TIMEOUT_MS);

    processRef.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    processRef.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    processRef.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        logger.warn(
          `[DecklinkHelper] Helper exited with code ${code}: ${stderr.trim()}`
        );
        resolve([]);
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (error) {
        logger.warn(
          `[DecklinkHelper] Failed to parse helper output: ${error instanceof Error ? error.message : String(error)}`
        );
        resolve([]);
      }
    });

    processRef.on("error", (error) => {
      clearTimeout(timeout);
      logger.warn(
        `[DecklinkHelper] Failed to start helper: ${error instanceof Error ? error.message : String(error)}`
      );
      resolve([]);
    });
  });
}

/**
 * Execute the DeckLink helper to list display modes.
 *
 * @param deviceId DeckLink device ID.
 * @param outputPortId DeckLink output port ID.
 * @param query Optional filtering for width/height/fps/keying.
 * @returns Display modes supported by the given output.
 */
export async function listDecklinkDisplayModes(
  deviceId: string,
  outputPortId: string,
  query: DecklinkDisplayModeQueryT = {}
): Promise<DecklinkDisplayModeT[]> {
  if (platform() !== "darwin") {
    return [];
  }

  const logger = getLogger();
  const helperPath = resolveDecklinkHelperPath();
  try {
    await access(helperPath, constants.X_OK);
  } catch {
    logger.warn(
      `[DecklinkHelper] Helper not found or not executable at ${helperPath}`
    );
    return [];
  }

  return new Promise((resolve) => {
    const args = ["--list-modes", "--device", deviceId, "--output-port", outputPortId];

    if (typeof query.width === "number" && query.width > 0) {
      args.push("--width", String(query.width));
    }
    if (typeof query.height === "number" && query.height > 0) {
      args.push("--height", String(query.height));
    }
    if (typeof query.fps === "number" && query.fps > 0) {
      args.push("--fps", String(query.fps));
    }
    if (query.requireKeying) {
      args.push("--keying");
    }

    const processRef = spawn(helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      processRef.kill("SIGTERM");
      resolve([]);
    }, DEFAULT_HELPER_TIMEOUT_MS);

    processRef.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    processRef.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    processRef.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        logger.warn(
          `[DecklinkHelper] list-modes exited with code ${code}: ${stderr.trim()}`
        );
        resolve([]);
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as unknown;
        resolve(Array.isArray(parsed) ? (parsed as DecklinkDisplayModeT[]) : []);
      } catch (error) {
        logger.warn(
          `[DecklinkHelper] Failed to parse list-modes output: ${error instanceof Error ? error.message : String(error)}`
        );
        resolve([]);
      }
    });

    processRef.on("error", (error) => {
      clearTimeout(timeout);
      logger.warn(
        `[DecklinkHelper] Failed to start list-modes: ${error instanceof Error ? error.message : String(error)}`
      );
      resolve([]);
    });
  });
}

/**
 * Watch DeckLink devices via helper process and stream events.
 *
 * @param onEvent Callback invoked for each helper event line.
 * @returns Unsubscribe function to stop the helper process.
 */
export function watchDecklinkDevices(
  onEvent: (event: DecklinkHelperEvent) => void
): () => void {
  if (platform() !== "darwin") {
    return () => undefined;
  }

  const logger = getLogger();
  const helperPath = resolveDecklinkHelperPath();
  if (!helperPath) {
    logger.warn("[DecklinkHelper] Unable to resolve helper path");
    return () => undefined;
  }
  try {
    accessSync(helperPath, constants.X_OK);
  } catch {
    logger.warn(
      `[DecklinkHelper] Helper not found or not executable at ${helperPath}`
    );
    return () => undefined;
  }
  const processRef = spawn(helperPath, ["--watch"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";

  processRef.stdout.on("data", (data) => {
    buffer += data.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!line) {
        continue;
      }

      try {
        const event = JSON.parse(line) as DecklinkHelperEvent;
        onEvent(event);
      } catch (error) {
        logger.warn(
          `[DecklinkHelper] Ignoring invalid event line: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  });

  processRef.stderr.on("data", (data) => {
    logger.warn(`[DecklinkHelper] ${data.toString().trim()}`);
  });

  processRef.on("error", (error) => {
    logger.warn(
      `[DecklinkHelper] Helper failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  return () => {
    processRef.kill("SIGTERM");
  };
}
