import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const LEGACY_APP_NAME = "electron-vite-template";
const DEFAULT_APP_NAME = "Broadify Bridge";
const RC_APP_NAME = "Broadify Bridge RC";

// The bridge identity is two coupled files: the bridgeId and the relay auth
// keypair. The keyId is derived from the bridgeId, so they MUST stay together.
const BRIDGE_ID_FILE = "bridge-id.json";
const RELAY_IDENTITY_FILE = path.join("security", "relay-bridge-identity.json");

// Other user files that are safe to migrate independently (no auth coupling).
const MIGRATED_USER_FILES = [
  ".env",
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

function copyLegacyFileIfAbsent(
  legacyUserDataPath: string,
  targetUserDataPath: string,
  relativePath: string,
): void {
  const sourcePath = path.join(legacyUserDataPath, relativePath);
  const targetPath = path.join(targetUserDataPath, relativePath);
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return;
  }

  try {
    // Create the parent directory so nested files (e.g. security/) can migrate.
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  } catch {
    // Best-effort migration only. Startup must not fail because a legacy
    // preference file could not be copied.
  }
}

function migrateLegacyUserFiles(legacyUserDataPath: string, targetUserDataPath: string): void {
  if (legacyUserDataPath === targetUserDataPath || !fs.existsSync(legacyUserDataPath)) {
    return;
  }

  fs.mkdirSync(targetUserDataPath, { recursive: true });

  // Migrate the bridge identity atomically. Copying bridge-id.json without the
  // relay keypair resurrects a bridgeId whose keyId no longer matches the
  // enrolled public key -> "Invalid bridge auth signature" with no recovery
  // path. If the legacy profile is missing the keypair, migrate neither and let
  // the target generate a fresh, self-consistent identity that can be paired.
  const legacyHasBridgeId = fs.existsSync(path.join(legacyUserDataPath, BRIDGE_ID_FILE));
  const legacyHasRelayKey = fs.existsSync(path.join(legacyUserDataPath, RELAY_IDENTITY_FILE));
  if (legacyHasBridgeId && legacyHasRelayKey) {
    copyLegacyFileIfAbsent(legacyUserDataPath, targetUserDataPath, BRIDGE_ID_FILE);
    copyLegacyFileIfAbsent(legacyUserDataPath, targetUserDataPath, RELAY_IDENTITY_FILE);
  }

  for (const fileName of MIGRATED_USER_FILES) {
    copyLegacyFileIfAbsent(legacyUserDataPath, targetUserDataPath, fileName);
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
