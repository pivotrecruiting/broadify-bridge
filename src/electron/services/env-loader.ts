import { app } from "electron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

let envLoaded = false;
const RELEASE_MANAGED_ENV_KEYS = [
  "BROADIFY_UPDATER_CHANNEL",
  "RELAY_URL",
  "BRIDGE_RELAY_JWKS_URL",
];

const loadEnvFile = (envPath: string): boolean => {
  if (!envPath || !fs.existsSync(envPath)) {
    return false;
  }
  const result = dotenv.config({ path: envPath, override: false });
  return !result.error;
};

const applyReleaseManagedEnvOverrides = (envPath: string): void => {
  if (!envPath || !fs.existsSync(envPath)) {
    return;
  }

  try {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    for (const key of RELEASE_MANAGED_ENV_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim() !== "") {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore malformed resource env files.
  }
};

/**
 * Load environment variables from known runtime locations.
 *
 * Load order: dev project .env | userData | packaged resources.
 * With override: false, earlier files win; later files fill in missing vars.
 * Prod: userData (may be old) + packaged bridge/.env fills in BRIDGE_GRAPHICS_* etc.
 */
export const loadAppEnv = (): void => {
  if (envLoaded) {
    return;
  }
  envLoaded = true;

  const candidates: string[] = [];
  let userEnvPath: string | null = null;
  const resourceEnvPaths: string[] = [];
  const projectEnv = path.join(process.cwd(), ".env");
  const isDev = process.env.NODE_ENV !== "production";

  try {
    const userDataDir = app.getPath("userData");
    userEnvPath = path.join(userDataDir, ".env");
  } catch {
    // Ignore userData lookup errors.
  }

  if (process.resourcesPath) {
    resourceEnvPaths.push(
      path.join(process.resourcesPath, "bridge", "dist", ".env")
    );
    resourceEnvPaths.push(path.join(process.resourcesPath, "bridge", ".env"));
  }

  // Dev: project .env first so local overrides (e.g. BRIDGE_GRAPHICS_*) are used.
  if (isDev) {
    candidates.push(projectEnv);
  }
  if (userEnvPath) {
    candidates.push(userEnvPath);
  }
  candidates.push(...resourceEnvPaths);
  if (!candidates.includes(projectEnv)) {
    candidates.push(projectEnv);
  }

  if (userEnvPath && !fs.existsSync(userEnvPath)) {
    const seedSource = resourceEnvPaths.find((envPath) =>
      fs.existsSync(envPath)
    );
    if (seedSource) {
      try {
        fs.copyFileSync(seedSource, userEnvPath);
      } catch {
        // Ignore seed failures.
      }
    }
  }

  // Prod: load userData first, then packaged resources. With override: false,
  // packaged vars (e.g. BRIDGE_GRAPHICS_*) fill in for keys userData doesn't have.
  // Dev: project first wins; others fill in. Never break – load all to merge.
  for (const candidate of candidates) {
    loadEnvFile(candidate);
  }

  // Always let packaged release-managed values win over persisted userData/.env.
  // This keeps RC/test builds pinned to their intended relay and update channel.
  for (const envPath of resourceEnvPaths) {
    applyReleaseManagedEnvOverrides(envPath);
  }
};
