import { readFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP_APP_VERSION_ENV_KEY = "BROADIFY_DESKTOP_APP_VERSION";
const DEFAULT_VERSION = "0.1.0";

/**
 * Resolve the effective app version exposed by the bridge runtime.
 *
 * When the bridge is launched by the Electron desktop app, the desktop version
 * is injected via environment variable and takes precedence. Standalone bridge
 * runs fall back to local package manifests.
 *
 * @returns Effective app version string.
 */
export function getRuntimeAppVersion(): string {
  const envVersion = process.env[DESKTOP_APP_VERSION_ENV_KEY]?.trim();
  if (envVersion) {
    return envVersion;
  }

  const packagePaths = [
    join(process.cwd(), "..", "..", "package.json"),
    join(process.cwd(), "..", "package.json"),
    join(process.cwd(), "package.json"),
  ];

  for (const packagePath of packagePaths) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
        version?: unknown;
      };
      if (typeof packageJson.version === "string" && packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return DEFAULT_VERSION;
}
