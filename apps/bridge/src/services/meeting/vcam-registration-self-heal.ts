import { execFile as nodeExecFile } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { join } from "node:path";

import { getBridgeContext } from "../bridge-context.js";

/**
 * Runtime self-heal for an unregistered Windows virtual-camera DLL.
 *
 * The NSIS installer registers broadify-vcam.dll via regsvr32 (HKLM, needs
 * elevation; see build/windows-installer.nsh). The MSI target registers
 * nothing, and older per-user NSIS installs silently failed to register. The
 * meeting-helper then fails output.vcam.start with REGDB_E_CLASSNOTREG
 * (0x80040154) - or with a different HRESULT when the CLSID still points at
 * a DLL path that no longer exists (stale registration after a move/
 * uninstall). Instead of leaving the operator with a dead camera, probe the
 * registry, request ONE elevated regsvr32 run (UAC prompt), verify the
 * registry again and retry the start exactly once. Declined/failed elevation
 * logs the exact admin command and surfaces the original error. Never loops:
 * one attempt per bridge session, re-armed only after a verified success.
 */

const VCAM_CLASS_NOT_REGISTERED_PATTERN = /0x80040154|REGDB_E_CLASSNOTREG/i;
// Must match apps/bridge/native/vcam-helper/windows/vcam_guid.h and
// build/windows-installer.nsh.
export const VCAM_CLSID = "{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}";
const VCAM_INPROC_SERVER_KEY = `HKLM\\SOFTWARE\\Classes\\CLSID\\${VCAM_CLSID}\\InprocServer32`;
// Generous budget: the UAC prompt waits for a human.
const REGSVR32_TIMEOUT_MS = 60_000;
const REG_QUERY_TIMEOUT_MS = 10_000;
// regsvr32 exit codes (Microsoft KB 249873). Exit code 1 is left unmapped:
// it is also what PowerShell returns for a declined UAC prompt.
const REGSVR32_EXIT_MESSAGES: Record<number, string> = {
  2: "OleInitialize failed",
  3: "the DLL could not be loaded (missing file or dependency)",
  4: "DllRegisterServer entry point not found",
  5: "DllRegisterServer failed (access denied - elevation missing?)",
};

let selfHealAttemptedThisSession = false;

type LoggerT = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type ExecFileCallbackT = (
  error: Error | null,
  stdout?: string | Buffer,
  stderr?: string | Buffer,
) => void;

/** Minimal execFile shape so tests can inject a fake without monkeypatching. */
export type ExecFileLikeT = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
  callback: ExecFileCallbackT,
) => unknown;

/** Injectable dependencies (all optional; defaults are the real node APIs). */
export type VcamSelfHealDepsT = {
  execFile?: ExecFileLikeT;
  existsSync?: (path: string) => boolean;
  resolveDllPath?: () => string;
  platform?: NodeJS.Platform;
};

/** Result of probing the CLSID registration in the 64-bit HKLM view. */
export type VcamRegistrationProbeT =
  | { state: "registered"; dllPath: string }
  | { state: "stale"; dllPath: string }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

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

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toText = (value: string | Buffer | undefined): string =>
  value === undefined ? "" : value.toString();

/**
 * Parse the default value of `reg query ... /ve` output, e.g.
 * `    (Default)    REG_SZ    C:\Program Files\...\broadify-vcam.dll`.
 */
export function parseRegQueryDefaultValue(stdout: string): string | null {
  const match = /\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(stdout);
  return match ? match[1].trim() : null;
}

/**
 * Probe `HKLM\SOFTWARE\Classes\CLSID\{CLSID}\InprocServer32` in the 64-bit
 * registry view (the one the Frame Server reads) via reg.exe.
 */
export function probeVcamRegistration(
  deps: VcamSelfHealDepsT = {},
): Promise<VcamRegistrationProbeT> {
  const execFile = deps.execFile ?? nodeExecFile;
  const existsSync = deps.existsSync ?? nodeExistsSync;
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", VCAM_INPROC_SERVER_KEY, "/ve", "/reg:64"],
      { timeout: REG_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const out = toText(stdout);
        const err = toText(stderr);
        if (error) {
          // reg.exe exits 1 when the key/value does not exist.
          if (/unable to find the specified registry key/i.test(err + out)) {
            resolve({ state: "missing" });
            return;
          }
          resolve({ state: "unknown", reason: toErrorMessage(error) });
          return;
        }
        const dllPath = parseRegQueryDefaultValue(out);
        if (dllPath === null) {
          resolve({ state: "missing" });
          return;
        }
        resolve(
          existsSync(dllPath)
            ? { state: "registered", dllPath }
            : { state: "stale", dllPath },
        );
      },
    );
  });
}

function runElevatedRegsvr32(
  dllPath: string,
  execFile: ExecFileLikeT,
): Promise<void> {
  // PowerShell Start-Process -Verb RunAs is the only shell-free way to raise
  // a UAC prompt from an unelevated process; -Wait blocks until regsvr32
  // finished and -PassThru + exit propagates regsvr32's own exit code (a
  // declined UAC prompt throws inside PowerShell and exits non-zero too).
  const escapedDllPath = dllPath.replace(/'/g, "''");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$p = Start-Process -FilePath regsvr32.exe -ArgumentList '/s','${escapedDllPath}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
      ],
      { timeout: REGSVR32_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (!error) {
          resolve();
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number" && code in REGSVR32_EXIT_MESSAGES) {
          reject(
            new Error(
              `regsvr32 exit code ${code}: ${REGSVR32_EXIT_MESSAGES[code]}`,
            ),
          );
          return;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Run a virtual-camera start, self-healing a missing DLL registration once.
 *
 * On a start failure (win32 only) the CLSID registration is probed: a missing
 * or stale (file gone) InprocServer32 entry triggers ONE elevated regsvr32 of
 * the packaged DLL, a registry re-check and exactly one retry of startVcam.
 * A registration that looks intact is left alone. If the probe itself is
 * unavailable, the legacy trigger (REGDB_E_CLASSNOTREG in the error text)
 * decides. Every other failure - and a declined/failed elevation - rethrows
 * the original error. The once-per-session guard is re-armed only after a
 * verified registration AND a successful retry.
 */
export async function runVcamStartWithRegistrationSelfHeal<T>(
  startVcam: () => Promise<T>,
  deps: VcamSelfHealDepsT = {},
): Promise<T> {
  try {
    return await startVcam();
  } catch (error: unknown) {
    const platform = deps.platform ?? process.platform;
    if (platform !== "win32" || selfHealAttemptedThisSession) {
      throw error;
    }
    const logger = getLogger();
    const message = toErrorMessage(error);
    const execFile = deps.execFile ?? nodeExecFile;
    const existsSync = deps.existsSync ?? nodeExistsSync;
    const dllPath = (deps.resolveDllPath ?? resolveVcamHelperDllPath)();

    const probe = await probeVcamRegistration({ execFile, existsSync });
    if (probe.state === "registered") {
      logger.info(
        `[Meeting] VCam CLSID is registered (${probe.dllPath} exists); no registration self-heal for: ${message}`,
      );
      throw error;
    }
    if (
      probe.state === "unknown" &&
      !VCAM_CLASS_NOT_REGISTERED_PATTERN.test(message)
    ) {
      logger.warn(
        `[Meeting] VCam registration probe unavailable (${probe.reason}); error does not indicate a missing class, no self-heal`,
      );
      throw error;
    }

    // Mark before running so a second failure in this session never
    // re-prompts, regardless of how this attempt ends.
    selfHealAttemptedThisSession = true;
    if (!existsSync(dllPath)) {
      logger.warn(
        `[Meeting] VCam registration self-heal skipped: DLL not found at ${dllPath} (unpackaged dev run?)`,
      );
      throw error;
    }
    const reason =
      probe.state === "stale"
        ? `CLSID points at a missing file (${probe.dllPath})`
        : probe.state === "missing"
          ? "CLSID is not registered in HKLM (64-bit view)"
          : `registry probe unavailable (${probe.reason}), error reports 0x80040154`;
    logger.warn(
      `[Meeting] Virtual camera ${reason}; requesting elevated regsvr32 for ${dllPath}`,
    );
    try {
      await runElevatedRegsvr32(dllPath, execFile);
    } catch (healError: unknown) {
      logger.error(
        `[Meeting] VCam registration self-heal failed (${toErrorMessage(healError)}). Register manually from an elevated prompt: regsvr32 "${dllPath}"`,
      );
      throw error;
    }

    const verify = await probeVcamRegistration({ execFile, existsSync });
    if (verify.state === "missing" || verify.state === "stale") {
      const detail =
        verify.state === "missing"
          ? "still not registered"
          : `stale (${verify.dllPath})`;
      logger.error(
        `[Meeting] VCam registration self-heal: regsvr32 reported success but the CLSID is ${detail}. Register manually from an elevated prompt: regsvr32 "${dllPath}"`,
      );
      throw error;
    }
    if (verify.state === "unknown") {
      logger.warn(
        `[Meeting] VCam registration could not be verified after regsvr32 (${verify.reason}); retrying virtual camera start once anyway`,
      );
    } else {
      logger.info(
        `[Meeting] VCam DLL registered (${verify.dllPath}); retrying virtual camera start once`,
      );
    }
    const result = await startVcam();
    if (verify.state === "registered") {
      // Verified heal + working camera: allow a future heal should the
      // registration get lost again later in this session.
      selfHealAttemptedThisSession = false;
    }
    return result;
  }
}
