import { join } from "node:path";

const DISPLAY_HELPER_PATH_ENV = "BRIDGE_DISPLAY_HELPER_PATH";

/**
 * Resolve the native Display helper binary path.
 *
 * Used when BRIDGE_DISPLAY_NATIVE_HELPER=1 to run the C++/SDL2 helper
 * instead of the Electron Display Helper.
 *
 * Bridge is always spawned with cwd = apps/bridge (see bridge-process-manager),
 * so process.cwd() is the most reliable source for the helper path.
 *
 * @returns Absolute path to the display-helper binary.
 */
export function resolveDisplayHelperPath(): string {
  const envPath = process.env[DISPLAY_HELPER_PATH_ENV];
  if (envPath) {
    return envPath;
  }

  // Production: packaged resources (Electron)
  const resourcesPath = process.resourcesPath;
  if (process.env.NODE_ENV === "production" && resourcesPath) {
    return join(resourcesPath, "native", "display-helper", "display-helper");
  }

  // Dev: Bridge runs with cwd = apps/bridge (bridge-process-manager spawn)
  const cwdPath = join(process.cwd(), "native", "display-helper", "display-helper");
  return cwdPath;
}
