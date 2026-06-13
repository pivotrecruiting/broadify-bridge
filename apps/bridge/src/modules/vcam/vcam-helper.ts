import { existsSync } from "node:fs";
import { join } from "node:path";

const VCAM_HELPER_PATH_ENV = "BRIDGE_VCAM_HELPER_PATH";
const VCAM_EXTENSION_MARKER_ENV = "BROADIFY_VCAM_EXTENSION_INSTALLED";

/**
 * Resolve the packaged VCam container app path (macOS scaffold).
 */
export function resolveVcamHelperAppPath(): string | null {
  const envPath = process.env[VCAM_HELPER_PATH_ENV];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const resourcesPath = process.resourcesPath;
  if (process.env.NODE_ENV === "production" && resourcesPath) {
    const packaged = join(resourcesPath, "native", "vcam-helper", "BroadifyVCam.app");
    if (existsSync(packaged)) {
      return packaged;
    }
  }

  const devCandidate = join(
    process.cwd(),
    "native",
    "vcam-helper",
    "build",
    "Release",
    "BroadifyVCam.app",
  );
  if (existsSync(devCandidate)) {
    return devCandidate;
  }

  return null;
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
  return resolveVcamHelperAppPath() !== null;
}
