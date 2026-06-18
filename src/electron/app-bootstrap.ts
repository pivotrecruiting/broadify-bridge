import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const LEGACY_APP_NAME = "electron-vite-template";
const DEFAULT_APP_NAME = "Broadify Bridge";
const RC_APP_NAME = "Broadify Bridge RC";
const MIGRATED_USER_FILES = [
  ".env",
  "bridge-id.json",
  "bridge-profile.json",
  "network-config.json",
];

function resolveDesktopAppName(): string {
  const executableName = path.basename(process.execPath);
  if (executableName === RC_APP_NAME || executableName.includes("Bridge RC")) {
    return RC_APP_NAME;
  }
  if (executableName === DEFAULT_APP_NAME || executableName.includes("Broadify Bridge")) {
    return DEFAULT_APP_NAME;
  }

  const currentName = app.getName();
  if (currentName && currentName !== LEGACY_APP_NAME) {
    return currentName;
  }

  return DEFAULT_APP_NAME;
}

function migrateLegacyUserFiles(legacyUserDataPath: string, targetUserDataPath: string): void {
  if (legacyUserDataPath === targetUserDataPath || !fs.existsSync(legacyUserDataPath)) {
    return;
  }

  fs.mkdirSync(targetUserDataPath, { recursive: true });

  for (const fileName of MIGRATED_USER_FILES) {
    const sourcePath = path.join(legacyUserDataPath, fileName);
    const targetPath = path.join(targetUserDataPath, fileName);
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
      continue;
    }

    try {
      fs.copyFileSync(sourcePath, targetPath);
    } catch {
      // Best-effort migration only. Startup must not fail because a legacy
      // preference file could not be copied.
    }
  }
}

/**
 * Establish the production app identity before any service reads userData.
 *
 * The legacy template name caused production, RC and test builds to share
 * Chromium profile caches under Application Support/electron-vite-template.
 */
export function bootstrapDesktopAppIdentity(): void {
  const appName = resolveDesktopAppName();
  const appDataPath = app.getPath("appData");
  const targetUserDataPath = path.join(appDataPath, appName);
  const legacyUserDataPath = path.join(appDataPath, LEGACY_APP_NAME);

  app.setName(appName);
  app.setPath("userData", targetUserDataPath);
  migrateLegacyUserFiles(legacyUserDataPath, targetUserDataPath);
}

bootstrapDesktopAppIdentity();
