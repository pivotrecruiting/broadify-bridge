import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const LEGACY_APP_NAME = "electron-vite-template";
const DEFAULT_APP_NAME = "Broadify Bridge";
const RC_APP_NAME = "Broadify Bridge RC";
const DEV_APP_NAME = "Broadify Bridge Dev";

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

  // An unpackaged run executes the bare Electron binary, so neither name above
  // matches and app.getName() is still the legacy template name. Without this
  // branch the dev run falls through to DEFAULT_APP_NAME and shares the
  // Chromium profile, the bridge identity and the single-instance lock with an
  // installed production build.
  if (!app.isPackaged) {
    return DEV_APP_NAME;
  }

  const currentName = app.getName();
  if (currentName && currentName !== LEGACY_APP_NAME) {
    return currentName;
  }

  return DEFAULT_APP_NAME;
}

function isGraphicsRendererProcess(): boolean {
  return process.argv.includes("--graphics-renderer");
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

function migrateLegacyUserFiles(
  legacyUserDataPath: string,
  targetUserDataPath: string,
  { includeIdentity = true }: { includeIdentity?: boolean } = {},
): void {
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
  if (includeIdentity && legacyHasBridgeId && legacyHasRelayKey) {
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
  if (isGraphicsRendererProcess() && process.env.BRIDGE_GRAPHICS_USER_DATA_DIR) {
    app.setPath("userData", process.env.BRIDGE_GRAPHICS_USER_DATA_DIR);
    return;
  }

  const appName = resolveDesktopAppName();
  const appDataPath = app.getPath("appData");
  const targetUserDataPath = path.join(appDataPath, appName);
  const legacyUserDataPath = path.join(appDataPath, LEGACY_APP_NAME);

  app.setName(appName);
  app.setPath("userData", targetUserDataPath);

  const isDevProfile = appName === DEV_APP_NAME;

  // Dev runs used to land in DEFAULT_APP_NAME, so that profile -- not the far
  // older legacy one -- holds their current settings. Seed from it BEFORE the
  // legacy pass: migration only fills gaps, so the first source to provide a
  // file wins, and seeding afterwards would silently lose to a stale legacy
  // copy (e.g. an .env still pointing at the production relay).
  // Never the identity: a copied bridgeId would leave this run and an installed
  // build enrolled as the same bridge, which is the conflict the split prevents.
  if (isDevProfile) {
    migrateLegacyUserFiles(path.join(appDataPath, DEFAULT_APP_NAME), targetUserDataPath, {
      includeIdentity: false,
    });
  }

  migrateLegacyUserFiles(legacyUserDataPath, targetUserDataPath, {
    includeIdentity: !isDevProfile,
  });
}

bootstrapDesktopAppIdentity();
