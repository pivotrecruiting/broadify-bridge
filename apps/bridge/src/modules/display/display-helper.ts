import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DISPLAY_HELPER_PATH_ENV = "BRIDGE_DISPLAY_HELPER_PATH";

/**
 * Resolve the native Display helper binary path.
 *
 * Used when BRIDGE_DISPLAY_NATIVE_HELPER=1 to run the C++/SDL2 helper
 * instead of the Electron Display Helper.
 *
 * @returns Absolute path to the display-helper binary.
 */
export function resolveDisplayHelperPath(): string {
  const envPath = process.env[DISPLAY_HELPER_PATH_ENV];
  if (envPath) {
    return envPath;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Dev path: repo-local helper binary
  const devPath = join(
    __dirname,
    "../../../../native/display-helper/display-helper"
  );

  // Production path: packaged resources
  const resourcesPath = process.resourcesPath;
  const prodPath = resourcesPath
    ? join(resourcesPath, "native", "display-helper", "display-helper")
    : "";

  if (process.env.NODE_ENV === "production" && prodPath) {
    return prodPath;
  }

  return devPath;
}
