import { app } from "electron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

let envLoaded = false;

const loadEnvFile = (envPath: string): boolean => {
  if (!envPath || !fs.existsSync(envPath)) {
    return false;
  }
  const result = dotenv.config({ path: envPath, override: false });
  return !result.error;
};

/**
 * Load environment variables from known runtime locations.
 *
 * Priority: userData -> packaged resources -> cwd.
 * Existing process.env values are never overridden.
 */
export const loadAppEnv = (): void => {
  if (envLoaded) {
    return;
  }
  envLoaded = true;

  const candidates: string[] = [];
  let userEnvPath: string | null = null;
  const resourceEnvPaths: string[] = [];

  try {
    const userDataDir = app.getPath("userData");
    userEnvPath = path.join(userDataDir, ".env");
    candidates.push(userEnvPath);
  } catch {
    // Ignore userData lookup errors.
  }

  if (process.resourcesPath) {
    resourceEnvPaths.push(
      path.join(process.resourcesPath, "bridge", "dist", ".env")
    );
    resourceEnvPaths.push(path.join(process.resourcesPath, "bridge", ".env"));
    candidates.push(...resourceEnvPaths);
  }

  candidates.push(path.join(process.cwd(), ".env"));

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

  for (const candidate of candidates) {
    if (loadEnvFile(candidate)) {
      break;
    }
  }
};
