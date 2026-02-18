import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG_FILENAME = "default.json";

/**
 * Default config schema.
 * Values are applied to process.env only when not already set (env takes precedence).
 */
interface DefaultConfigT {
  graphics?: {
    renderer?: string;
    framebusName?: string;
  };
  relay?: {
    jwksUrl?: string;
  };
}

/**
 * Resolve path to default config file.
 * - Production: config is packaged at bridge/config/default.json (cwd = resources/bridge)
 * - Dev: config is at project root config/default.json (cwd = apps/bridge, go up twice)
 */
function resolveDefaultConfigPath(): string | null {
  const cwd = process.cwd();

  // Production: config packaged alongside bridge at bridge/config/
  const packagedPath = path.join(cwd, "config", DEFAULT_CONFIG_FILENAME);
  if (existsSync(packagedPath)) {
    return packagedPath;
  }

  // Dev: config at project root config/
  const devPath = path.join(cwd, "..", "..", "config", DEFAULT_CONFIG_FILENAME);
  if (existsSync(devPath)) {
    return devPath;
  }

  return null;
}

/**
 * Load default config and apply graphics values to process.env.
 * Legacy renderer mode flags were removed; runtime is single-renderer only.
 * Only sets env vars that are not already defined (allows override via env).
 */
export function loadDefaultConfig(): void {
  const configPath = resolveDefaultConfigPath();
  if (!configPath) {
    return;
  }

  let parsed: DefaultConfigT;
  try {
    const raw = readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw) as DefaultConfigT;
  } catch {
    return;
  }

  const g = parsed.graphics;
  if (!g) {
    return;
  }

  if (g.renderer !== undefined && process.env.BRIDGE_GRAPHICS_RENDERER === undefined) {
    process.env.BRIDGE_GRAPHICS_RENDERER = g.renderer;
  }
  if (g.framebusName !== undefined && process.env.BRIDGE_FRAMEBUS_NAME === undefined) {
    process.env.BRIDGE_FRAMEBUS_NAME = g.framebusName;
  }

  const r = parsed.relay;
  if (r?.jwksUrl !== undefined && process.env.BRIDGE_RELAY_JWKS_URL === undefined) {
    process.env.BRIDGE_RELAY_JWKS_URL = r.jwksUrl;
  }
}
