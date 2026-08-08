import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { getBridgeContext } from "../bridge-context.js";

/**
 * Runtime self-heal for an unregistered Windows virtual-camera DLL.
 *
 * The MSI registers broadify-vcam.dll via regsvr32 at install time, but that
 * step needs elevation and can be skipped (per-user installs, hardened
 * environments). The meeting-helper then fails output.vcam.start with
 * REGDB_E_CLASSNOTREG (0x80040154). Instead of leaving the operator with a
 * dead camera, request ONE elevated regsvr32 run (UAC prompt) and retry the
 * start exactly once. Declined/failed elevation logs the exact admin command
 * and surfaces the original error. Never loops: one attempt per bridge
 * session.
 */

const VCAM_CLASS_NOT_REGISTERED_PATTERN = /0x80040154|REGDB_E_CLASSNOTREG/i;
// Generous budget: the UAC prompt waits for a human.
const REGSVR32_TIMEOUT_MS = 60_000;

let selfHealAttemptedThisSession = false;

type LoggerT = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

const getLogger = (): LoggerT => {
  try {
    return getBridgeContext().logger;
  } catch {
    return {
      info: (msg: string) => console.info(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
  }
};

/** Test-only reset of the once-per-session guard. @internal */
export function __resetVcamRegistrationSelfHealForTesting(): void {
  selfHealAttemptedThisSession = false;
}

/** Resolve the packaged virtual-camera DLL (electron-builder extraResources). */
export function resolveVcamHelperDllPath(): string {
  return join(
    process.resourcesPath ?? "",
    "native",
    "vcam-helper",
    "broadify-vcam.dll",
  );
}

function runElevatedRegsvr32(dllPath: string): Promise<void> {
  // PowerShell Start-Process -Verb RunAs is the only shell-free way to raise
  // a UAC prompt from an unelevated process; -Wait blocks until regsvr32
  // finished so the retry below sees the final registry state.
  const escapedDllPath = dllPath.replace(/'/g, "''");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath regsvr32.exe -ArgumentList '/s','${escapedDllPath}' -Verb RunAs -Wait`,
      ],
      { timeout: REGSVR32_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve();
        }
      },
    );
  });
}

/**
 * Run a virtual-camera start, self-healing a missing DLL registration once.
 *
 * On a REGDB_E_CLASSNOTREG failure (win32 only, once per bridge session):
 * register the packaged DLL via an elevated regsvr32 and retry startVcam
 * exactly once. Every other failure - and a declined/failed elevation -
 * rethrows the original error.
 */
export async function runVcamStartWithRegistrationSelfHeal<T>(
  startVcam: () => Promise<T>,
): Promise<T> {
  try {
    return await startVcam();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      process.platform !== "win32" ||
      !VCAM_CLASS_NOT_REGISTERED_PATTERN.test(message) ||
      selfHealAttemptedThisSession
    ) {
      throw error;
    }
    // Mark before running so a second failure in this session never
    // re-prompts, regardless of how this attempt ends.
    selfHealAttemptedThisSession = true;
    const logger = getLogger();
    const dllPath = resolveVcamHelperDllPath();
    if (!existsSync(dllPath)) {
      logger.warn(
        `[Meeting] VCam registration self-heal skipped: DLL not found at ${dllPath} (unpackaged dev run?)`,
      );
      throw error;
    }
    logger.warn(
      `[Meeting] Virtual camera class is not registered (0x80040154); requesting elevated regsvr32 for ${dllPath}`,
    );
    try {
      await runElevatedRegsvr32(dllPath);
    } catch (healError: unknown) {
      const healMessage =
        healError instanceof Error ? healError.message : String(healError);
      logger.error(
        `[Meeting] VCam registration self-heal failed (${healMessage}). Register manually from an elevated prompt: regsvr32 "${dllPath}"`,
      );
      throw error;
    }
    logger.info(
      "[Meeting] VCam DLL registered; retrying virtual camera start once",
    );
    return await startVcam();
  }
}
