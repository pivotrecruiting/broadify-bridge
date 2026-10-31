import { app } from "electron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { logAppInfo } from "./app-logger.js";

let envLoaded = false;
// Keys the release workflow writes into the packaged .env per channel. They
// always win over userData/.env so a channel switch (stable <-> RC) cannot be
// undone by values a previous install persisted. The web app URL belongs here
// because RC builds open the dev web app while stable builds open production.
const RELEASE_MANAGED_ENV_KEYS = [
  "BROADIFY_UPDATER_CHANNEL",
  "RELAY_URL",
  "BRIDGE_RELAY_JWKS_URL",
  "PRODUCTION_STUDIO_CONTROL_WEBAPP_URL",
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
 * Log which keys userData/.env defines. Only key names are logged, never
 * values, so support can see which overrides are active without leaking
 * tokens or URLs into the app log.
 */
const logUserEnvKeyNames = (userEnvPath: string): void => {
  if (!fs.existsSync(userEnvPath)) {
    return;
  }

  try {
    const parsed = dotenv.parse(fs.readFileSync(userEnvPath));
    const keys = Object.keys(parsed).sort();
    if (keys.length === 0) {
      return;
    }
    logAppInfo(`[Env] userData/.env keys: ${keys.join(", ")}`);
  } catch {
    // Ignore malformed userData env files.
  }
};

/**
 * Load environment variables from known runtime locations.
 *
 * Load order (with override: false, earlier files win; later files fill in
 * missing vars):
 * - Dev (unpackaged): project .env (cwd) | userData/.env | packaged resources.
 * - Packaged: userData/.env | packaged resources. The current working
 *   directory is never consulted: it is not meaningful for an installed app
 *   ("/" on macOS, install dir or a shortcut's "Start in" folder on Windows)
 *   and must not be able to inject configuration into a release.
 *
 * In both modes the release-managed keys (RELEASE_MANAGED_ENV_KEYS) from the
 * packaged resource .env win over persisted userData/.env values.
 */
export const loadAppEnv = (): void => {
  if (envLoaded) {
    return;
  }
  envLoaded = true;

  const candidates: string[] = [];
  let userEnvPath: string | null = null;
  const resourceEnvPaths: string[] = [];
  const isPackaged = app.isPackaged;

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
  // Packaged builds never read the cwd.
  if (!isPackaged) {
    candidates.push(path.join(process.cwd(), ".env"));
  }
  if (userEnvPath) {
    candidates.push(userEnvPath);
  }
  candidates.push(...resourceEnvPaths);

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

  // Packaged: load userData first, then packaged resources. With override: false,
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

  if (userEnvPath) {
    logUserEnvKeyNames(userEnvPath);
  }
};
