import { execFileSync } from "child_process";

const VCAM_APP_BUNDLE_ID = "com.broadify.vcam";
const VCAM_APP_EXECUTABLE_NAME = "BroadifyVCam";

/**
 * Quit the macOS VCam container app if it is running.
 *
 * The CMIO system extension remains registered with macOS, but closing the
 * container app avoids stale activation state during development restarts.
 */
export function quitVcamHelperApp(): void {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    execFileSync(
      "osascript",
      ["-e", `tell application id "${VCAM_APP_BUNDLE_ID}" to quit`],
      { stdio: "ignore" },
    );
  } catch {
    // The app may not be running or may not be registered with LaunchServices.
  }

  try {
    execFileSync("pkill", ["-x", VCAM_APP_EXECUTABLE_NAME], {
      stdio: "ignore",
    });
  } catch {
    // No matching process.
  }
}
