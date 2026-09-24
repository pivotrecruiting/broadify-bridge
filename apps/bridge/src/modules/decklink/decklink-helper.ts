import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getBridgeContext } from "../../services/bridge-context.js";
import { ReconnectScheduler } from "../../services/shared/backoff.js";

const DEFAULT_HELPER_TIMEOUT_MS = 4000;
const HELPER_PATH_ENV = "DECKLINK_HELPER_PATH";

export type DecklinkHelperEvent = {
  type: "devices" | "device_added" | "device_removed";
  devices: unknown[];
};

export type DecklinkDiagnosticsT = {
  apiAvailable?: boolean;
  helperMissing?: boolean;
  apiVersion?: string;
  helperVersion?: string;
  message?: string;
  error?: string;
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

const decklinkDiagnosticsSchema = z
  .object({
    apiAvailable: z.boolean().optional(),
    helperMissing: z.boolean().optional(),
    apiVersion: z.string().optional(),
    helperVersion: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const listEnvelopeSchema = z.object({
  devices: z.array(z.unknown()),
  diagnostics: decklinkDiagnosticsSchema.optional(),
});

const ITERATOR_UNAVAILABLE_HINT = "DeckLink iterator could not be created";

const trimToUndefined = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const diagnosticsFromStderr = (
  stderr: string,
  base: DecklinkDiagnosticsT,
): DecklinkDiagnosticsT => {
  const message = trimToUndefined(stderr);
  if (!message) {
    return base;
  }
  return {
    ...base,
    apiAvailable: message.includes(ITERATOR_UNAVAILABLE_HINT)
      ? false
      : base.apiAvailable,
    message: base.message ?? message,
    error: base.error ?? message,
  };
};

/** Test-only override; set to non-null in tests to bypass import.meta. */
let testHelperPathOverride: string | null = null;

function getModuleDirname(): string {
  try {
    const url = (0, eval)("import.meta.url") as string;
    return dirname(fileURLToPath(url));
  } catch {
    return "/tmp";
  }
}

/**
 * Resolve the DeckLink helper binary path.
 *
 * @returns Absolute path to the helper binary.
 */
export function resolveDecklinkHelperPath(): string {
  if (testHelperPathOverride !== null) {
    return testHelperPathOverride;
  }
  const envPath = process.env[HELPER_PATH_ENV];
  if (envPath) {
    return envPath;
  }

  const __dirname = getModuleDirname();

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
 * Test-only: override helper path for resolveDecklinkHelperPath. Call with null to reset.
 * @internal
 */
export function __setDecklinkHelperPathForTesting(path: string | null): void {
  testHelperPathOverride = path;
}

/**
 * Execute the DeckLink helper in list mode.
 *
 * @returns Array of raw device objects from helper output.
 */
export async function listDecklinkDevices(): Promise<unknown[]> {
  const result = await listDecklinkDevicesWithDiagnostics();
  return result.devices;
}

/**
 * Execute the DeckLink helper in list mode and preserve diagnostics.
 *
 * @returns Raw device objects and helper/API diagnostics.
 */
export async function listDecklinkDevicesWithDiagnostics(): Promise<{
  devices: unknown[];
  diagnostics: DecklinkDiagnosticsT;
}> {
  if (platform() !== "darwin") {
    return {
      devices: [],
      diagnostics: { apiAvailable: false, helperMissing: false },
    };
  }

  const logger = getLogger();
  const helperPath = resolveDecklinkHelperPath();
  try {
    await access(helperPath, constants.X_OK);
  } catch {
    logger.warn(
      `[DecklinkHelper] Helper not found or not executable at ${helperPath}`
    );
    return {
      devices: [],
      diagnostics: {
        apiAvailable: false,
        helperMissing: true,
        message: `Helper not found or not executable at ${helperPath}`,
      },
    };
  }

  return new Promise((resolve) => {
    const processRef = spawn(helperPath, ["--list"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      processRef.kill("SIGTERM");
      resolve({
        devices: [],
        diagnostics: {
          apiAvailable: false,
          helperMissing: false,
          message: "DeckLink helper timed out",
          error: "DeckLink helper timed out",
        },
      });
    }, DEFAULT_HELPER_TIMEOUT_MS);

    processRef.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    processRef.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    processRef.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        const stderrMessage = trimToUndefined(stderr);
        logger.warn(
          `[DecklinkHelper] Helper exited with code ${code}: ${stderr.trim()}`
        );
        resolve({
          devices: [],
          diagnostics: {
            apiAvailable: false,
            helperMissing: false,
            message: stderrMessage,
            error: stderrMessage,
          },
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (Array.isArray(parsed)) {
          resolve({
            devices: parsed,
            diagnostics: diagnosticsFromStderr(stderr, {
              apiAvailable: true,
              helperMissing: false,
            }),
          });
          return;
        }

        const envelope = listEnvelopeSchema.safeParse(parsed);
        if (envelope.success) {
          resolve({
            devices: envelope.data.devices,
            diagnostics: diagnosticsFromStderr(stderr, {
              apiAvailable: true,
              helperMissing: false,
              ...envelope.data.diagnostics,
            }),
          });
          return;
        }

        resolve({
          devices: [],
          diagnostics: diagnosticsFromStderr(stderr, {
            apiAvailable: false,
            helperMissing: false,
            error: "Unknown helper list output shape",
          }),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          `[DecklinkHelper] Failed to parse helper output: ${message}`
        );
        resolve({
          devices: [],
          diagnostics: diagnosticsFromStderr(stderr, {
            apiAvailable: false,
            helperMissing: false,
            error: message,
          }),
        });
      }
    });

    processRef.on("error", (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[DecklinkHelper] Failed to start helper: ${message}`
      );
      resolve({
        devices: [],
        diagnostics: {
          apiAvailable: false,
          helperMissing: true,
          message,
          error: message,
        },
      });
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

    processRef.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    processRef.stderr?.on("data", (data) => {
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
  const scheduler = new ReconnectScheduler({
    baseMs: 1000,
    maxMs: 30_000,
    jitterRatio: 0,
    maxAttempts: 8,
  });
  let processRef: ReturnType<typeof spawn> | null = null;
  let unsubscribed = false;

  const startWatch = () => {
    if (unsubscribed) {
      return;
    }
    processRef = spawn(helperPath, ["--watch"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let exitHandled = false;

    processRef.stdout?.on("data", (data) => {
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

    processRef.stderr?.on("data", (data) => {
      logger.warn(`[DecklinkHelper] ${data.toString().trim()}`);
    });

    processRef.on("error", (error) => {
      logger.warn(
        `[DecklinkHelper] Helper failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitHandled) {
        return;
      }
      exitHandled = true;
      logger.warn(
        `[DecklinkHelper] Watch process exited (code ${code}, signal ${signal})`
      );
      if (unsubscribed) {
        return;
      }
      const scheduled = scheduler.schedule(() => startWatch());
      if (!scheduled) {
        logger.error(
          "[DecklinkHelper] Watch process restart attempts exhausted",
        );
      }
    };
    processRef.on("exit", handleExit);
    processRef.on("close", handleExit);
  };

  startWatch();

  return () => {
    unsubscribed = true;
    scheduler.cancel();
    processRef?.kill("SIGTERM");
  };
}
