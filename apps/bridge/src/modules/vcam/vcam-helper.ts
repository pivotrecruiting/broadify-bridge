import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

const VCAM_HELPER_PATH_ENV = "BRIDGE_VCAM_HELPER_PATH";
const VCAM_EXTENSION_MARKER_ENV = "BROADIFY_VCAM_EXTENSION_INSTALLED";
const VCAM_EXTENSION_BUNDLE_ID = "com.broadify.vcam.extension";
const DEFAULT_MACOS_VCAM_APP_PATH = "/Applications/BroadifyVCam.app";
const VCAM_APP_EXECUTABLE_NAME = "BroadifyVCam";
export const VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME = `${VCAM_EXTENSION_BUNDLE_ID}.systemextension`;
export const VCAM_EMBEDDED_EXTENSION_REL_PATH = join(
  "Contents",
  "Library",
  "SystemExtensions",
  VCAM_EMBEDDED_EXTENSION_BUNDLE_NAME,
);
export const DEFAULT_MEETING_FRAMEBUS_NAME = "broadify-meeting-framebus";
export const DEFAULT_MEETING_VCAM_FRAME_PORT = 18787;

export type VcamHelperStatusT = {
  platform: NodeJS.Platform;
  platformSupported: boolean;
  available: boolean;
  installed: boolean;
  running: boolean;
  backend: "coremediaio_camera_extension";
  framebusName: string;
  helperAppPath: string | null;
  requiresUserApproval: boolean;
  launchRequested?: boolean;
  code?: string;
  message?: string;
};

export type VcamHelperStartOptionsT = {
  framebusName?: string;
};

type SystemExtensionActivationStateT = {
  installed: boolean;
  activated: boolean;
  requiresUserApproval: boolean;
};

/**
 * Returns whether the container app bundle embeds the camera system extension.
 * macOS activates extensions from the parent app that is actually running.
 */
export function hasEmbeddedVcamSystemExtension(appPath: string): boolean {
  return existsSync(join(appPath, VCAM_EMBEDDED_EXTENSION_REL_PATH));
}

function isValidVcamAppBundle(appPath: string): boolean {
  return existsSync(appPath) && hasEmbeddedVcamSystemExtension(appPath);
}

function getDevVcamHelperCandidates(): string[] {
  return [
    join(
      process.cwd(),
      "apps",
      "bridge",
      "native",
      "vcam-helper",
      "build",
      "Release",
      "BroadifyVCam.app",
    ),
    join(
      process.cwd(),
      "native",
      "vcam-helper",
      "build",
      "Release",
      "BroadifyVCam.app",
    ),
  ];
}

function readSystemExtensionsList(): string | null {
  if (platform() !== "darwin") {
    return null;
  }

  try {
    return execFileSync("systemextensionsctl", ["list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function getSystemExtensionActivationState(): SystemExtensionActivationStateT {
  const listOutput = readSystemExtensionsList();
  if (!listOutput || !listOutput.includes(VCAM_EXTENSION_BUNDLE_ID)) {
    return {
      installed: false,
      activated: false,
      requiresUserApproval: false,
    };
  }

  const normalized = listOutput.toLowerCase();
  const activated = normalized.includes("activated enabled");
  const waitingForUser =
    normalized.includes("waiting for user") ||
    normalized.includes("awaiting user approval") ||
    normalized.includes("needs user approval");

  return {
    installed: true,
    activated,
    requiresUserApproval: waitingForUser || !activated,
  };
}

/**
 * Resolve the packaged VCam container app path (macOS scaffold).
 */
export function resolveVcamHelperAppPath(): string | null {
  const candidates: string[] = [];

  const envPath = process.env[VCAM_HELPER_PATH_ENV];
  if (envPath) {
    candidates.push(envPath);
  }

  if (platform() === "darwin") {
    candidates.push(DEFAULT_MACOS_VCAM_APP_PATH);
  }

  const resourcesPath = process.resourcesPath;
  if (process.env.NODE_ENV === "production" && resourcesPath) {
    candidates.push(join(resourcesPath, "native", "vcam-helper", "BroadifyVCam.app"));
  }

  candidates.push(...getDevVcamHelperCandidates());

  for (const candidate of candidates) {
    if (isValidVcamAppBundle(candidate)) {
      return candidate;
    }
  }

  return null;
}

function quitRunningVcamHelperApp(): void {
  if (platform() !== "darwin") {
    return;
  }

  try {
    execFileSync(
      "osascript",
      ["-e", `tell application id "com.broadify.vcam" to quit`],
      { stdio: "ignore" },
    );
  } catch {
    // App may not be running.
  }

  try {
    execFileSync("pkill", ["-x", VCAM_APP_EXECUTABLE_NAME], { stdio: "ignore" });
  } catch {
    // No matching process.
  }
}

/**
 * Returns whether the native virtual camera extension is considered available.
 *
 * V1 uses an env marker or a built container app as heuristic. Full CMIO
 * registration checks require platform APIs outside the bridge process.
 */
export function isVcamExtensionAvailable(): boolean {
  if (process.env[VCAM_EXTENSION_MARKER_ENV] === "1") {
    return true;
  }
  return getSystemExtensionActivationState().activated;
}

/**
 * Return the local virtual camera integration status.
 */
export function getVcamHelperStatus(
  options: VcamHelperStartOptionsT = {},
): VcamHelperStatusT {
  const currentPlatform = platform();
  const helperAppPath = resolveVcamHelperAppPath();
  const markerInstalled = process.env[VCAM_EXTENSION_MARKER_ENV] === "1";
  const platformSupported = currentPlatform === "darwin";
  const activationState = getSystemExtensionActivationState();
  const configuredAppPath = process.env[VCAM_HELPER_PATH_ENV] ?? DEFAULT_MACOS_VCAM_APP_PATH;
  const hasInvalidConfiguredApp =
    platformSupported &&
    existsSync(configuredAppPath) &&
    !hasEmbeddedVcamSystemExtension(configuredAppPath);
  const installed = markerInstalled || helperAppPath !== null || activationState.installed;
  const framebusName = options.framebusName || DEFAULT_MEETING_FRAMEBUS_NAME;

  if (!platformSupported) {
    return {
      platform: currentPlatform,
      platformSupported,
      available: false,
      installed: false,
      running: false,
      backend: "coremediaio_camera_extension",
      framebusName,
      helperAppPath,
      requiresUserApproval: false,
      code: "platform_not_supported",
      message: "Virtual camera is currently implemented for macOS only.",
    };
  }

  if (hasInvalidConfiguredApp) {
    return {
      platform: currentPlatform,
      platformSupported,
      available: false,
      installed: false,
      running: false,
      backend: "coremediaio_camera_extension",
      framebusName,
      helperAppPath: null,
      requiresUserApproval: true,
      code: "helper_app_invalid",
      message:
        `BroadifyVCam.app at ${configuredAppPath} is missing the embedded system extension. ` +
        "Run npm run install:vcam-helper and open only /Applications/BroadifyVCam.app.",
    };
  }

  if (!installed) {
    return {
      platform: currentPlatform,
      platformSupported,
      available: false,
      installed: false,
      running: false,
      backend: "coremediaio_camera_extension",
      framebusName,
      helperAppPath,
      requiresUserApproval: true,
      code: "helper_app_missing",
      message: "BroadifyVCam.app was not found. Build the macOS VCam helper first.",
    };
  }

  if (markerInstalled || activationState.activated) {
    return {
      platform: currentPlatform,
      platformSupported,
      available: true,
      installed,
      running: true,
      backend: "coremediaio_camera_extension",
      framebusName,
      helperAppPath,
      requiresUserApproval: false,
      code: undefined,
      message: markerInstalled
        ? "Virtual camera extension is marked as installed."
        : "Virtual camera extension is active.",
    };
  }

  return {
    platform: currentPlatform,
    platformSupported,
    available: false,
    installed,
    running: false,
    backend: "coremediaio_camera_extension",
    framebusName,
    helperAppPath,
    requiresUserApproval: activationState.requiresUserApproval || !markerInstalled,
    code: "user_activation_required",
    message: activationState.requiresUserApproval
      ? "Enable broadify Virtual Camera under System Settings → General → Login Items & Extensions → Camera Extensions."
      : "Open BroadifyVCam.app and enable the camera extension in System Settings → Login Items & Extensions.",
  };
}

/**
 * Launch the macOS VCam container app so the user can activate the extension.
 */
export async function openVcamHelperApp(
  options: VcamHelperStartOptionsT = {},
): Promise<VcamHelperStatusT> {
  const status = getVcamHelperStatus(options);
  const helperAppPath = status.helperAppPath;
  if (!status.platformSupported || !helperAppPath) {
    return status;
  }

  try {
    // macOS reuses an already running parent app. Quit stale copies first so
    // activation always uses the embedded extension from the resolved bundle.
    quitRunningVcamHelperApp();

    await new Promise<void>((resolve, reject) => {
      const child: ChildProcess = spawn("open", ["-n", helperAppPath], {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `Failed to open BroadifyVCam.app (exit code ${code ?? "null"}, signal ${signal ?? "null"}).`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  } catch (error: unknown) {
    const launchError = error instanceof Error ? error.message : String(error);
    return {
      ...getVcamHelperStatus(options),
      launchRequested: true,
      requiresUserApproval: true,
      code: "activation_requested",
      message:
        `BroadifyVCam.app could not be opened automatically (${launchError}). ` +
        "Open the app manually and approve the camera extension in System Settings.",
    };
  }

  return {
    ...getVcamHelperStatus(options),
    launchRequested: true,
    requiresUserApproval: true,
    code: "activation_requested",
    message: "BroadifyVCam.app was opened. Approve the camera extension in System Settings.",
  };
}
