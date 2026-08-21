import { execFile as nodeExecFile } from "node:child_process";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  realpathSync as nodeRealpathSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { dirname, join, win32 as winPath } from "node:path";

import { z } from "zod";

import { getBridgeContext } from "../bridge-context.js";
import { getRuntimeAppVersion } from "../runtime-app-version.js";

/**
 * Runtime self-heal for an unregistered Windows virtual-camera DLL.
 *
 * The NSIS installer registers broadify-vcam.dll via regsvr32 (HKLM, needs
 * elevation; see build/windows-installer.nsh). The MSI target registers
 * nothing, and older per-user NSIS installs silently failed to register. The
 * meeting-helper then fails output.vcam.start with REGDB_E_CLASSNOTREG
 * (0x80040154) - or with a different HRESULT when the CLSID still points at
 * a DLL path that no longer exists or at a different install (stale
 * registration after a move/uninstall). Instead of leaving the operator with
 * a dead camera, probe the registry, request ONE elevated regsvr32 run (UAC
 * prompt), verify the registry again and retry the start exactly once.
 *
 * Rules (see docs/bridge/features/virtual-camera-windows.md):
 * - The registry probe is locale-independent: reg.exe localizes the value
 *   label ("(Default)" / "(Standard)" / "(Par défaut)") and its error text,
 *   so the parser keys on the REG_SZ / REG_EXPAND_SZ type token and the
 *   exit code only. A probe that cannot be parsed is `unknown`, never
 *   `missing`.
 * - The unattended auto-arm path never elevates (`allowElevation: false`):
 *   it only logs the diagnosis and the exact admin command.
 * - At most ONE UAC prompt per install: a marker file in userDataDir
 *   remembers a failed attempt per app version + DLL path across process
 *   restarts. A verified success clears the marker.
 */

const VCAM_CLASS_NOT_REGISTERED_PATTERN = /0x80040154|REGDB_E_CLASSNOTREG/i;
// Must match apps/bridge/native/vcam-helper/windows/vcam_guid.h and
// build/windows-installer.nsh.
export const VCAM_CLSID = "{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}";
const VCAM_INPROC_SERVER_KEY = `HKLM\\SOFTWARE\\Classes\\CLSID\\${VCAM_CLSID}\\InprocServer32`;
/** Marker file (under the bridge userDataDir) remembering a failed heal. */
export const VCAM_SELF_HEAL_MARKER_FILE = "vcam-self-heal.json";
// Generous budget: the UAC prompt waits for a human.
const REGSVR32_TIMEOUT_MS = 60_000;
const REG_QUERY_TIMEOUT_MS = 10_000;
/** Upper bound for raw reg.exe output quoted in log lines and reasons. */
const RAW_OUTPUT_LOG_LIMIT = 300;
const DEFAULT_WINDIR = "C:\\Windows";
// regsvr32 exit codes (Microsoft KB 249873). Exit code 1 is left unmapped:
// it is also what PowerShell returns for a declined UAC prompt.
const REGSVR32_EXIT_MESSAGES: Record<number, string> = {
  2: "OleInitialize failed",
  3: "the DLL could not be loaded (missing file or dependency)",
  4: "DllRegisterServer entry point not found",
  5: "DllRegisterServer failed (access denied - elevation missing?)",
};

/**
 * In-process guard on top of the persisted marker: covers the window while
 * a prompt is open and installs whose userDataDir is not writable.
 */
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

/** Minimal synchronous file API used for the self-heal marker. */
export type VcamSelfHealMarkerFsT = {
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, body: string) => void;
  unlinkSync: (path: string) => void;
  mkdirSync: (path: string) => void;
};

/** Injectable dependencies (all optional; defaults are the real node APIs). */
export type VcamSelfHealDepsT = {
  execFile?: ExecFileLikeT;
  existsSync?: (path: string) => boolean;
  /** Resolves the canonical on-disk path; falls back to the input on error. */
  realpathSync?: (path: string) => string;
  resolveDllPath?: () => string;
  platform?: NodeJS.Platform;
  /** Environment used for %VAR% expansion and the Sysnative pin. */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether a UAC prompt may be raised. Defaults to true (explicit operator
   * action). The unattended auto-arm path passes false: diagnosis only.
   */
  allowElevation?: boolean;
  /** Marker file location; defaults to `<userDataDir>/vcam-self-heal.json`. */
  markerPath?: string;
  markerFs?: VcamSelfHealMarkerFsT;
  appVersion?: string;
  now?: () => number;
};

/** Result of probing the CLSID registration in the 64-bit HKLM view. */
export type VcamRegistrationProbeT =
  | { state: "registered"; dllPath: string }
  | { state: "stale"; dllPath: string; installedDllPath: string }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

type ProbeWithRawT = { probe: VcamRegistrationProbeT; raw: string };

const VcamSelfHealMarkerSchema = z.object({
  app_version: z.string().min(1),
  dll_path: z.string().min(1),
  attempted_at: z.number().int().nonnegative(),
  // "pending" is written before the prompt opens so a process that dies
  // while the prompt is up still counts as the one attempt.
  outcome: z.enum(["pending", "failed"]),
});

type VcamSelfHealMarkerT = z.infer<typeof VcamSelfHealMarkerSchema>;

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

/** Test-only reset of the in-process guard (simulates a new process). @internal */
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

/** Collapse whitespace and cap the length so a log line stays one line. */
const truncateRaw = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > RAW_OUTPUT_LOG_LIMIT
    ? `${collapsed.slice(0, RAW_OUTPUT_LOG_LIMIT)}…`
    : collapsed;
};

/** Case-insensitive environment lookup (Windows semantics). */
const lookupEnv = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
};

/** Expand `%VAR%` references the way REG_EXPAND_SZ consumers do. */
export function expandEnvironmentStrings(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(/%([^%]+)%/g, (token, name: string) => {
    const resolved = lookupEnv(env, name);
    return resolved === undefined ? token : resolved;
  });
}

/**
 * Parse the default value of `reg query ... /ve` output without relying on
 * the localized value label: the first line carrying a REG_SZ /
 * REG_EXPAND_SZ type token yields the remainder after the token, e.g.
 * `    (Standard)    REG_SZ    C:\Program Files\...\broadify-vcam.dll`.
 * REG_EXPAND_SZ values are expanded against `env`.
 */
export function parseRegQueryDefaultValue(
  stdout: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*\S.*?\s+(REG_EXPAND_SZ|REG_SZ)\s+(.+?)\s*$/i.exec(line);
    if (!match) {
      continue;
    }
    const value = match[2].trim();
    if (!value) {
      return null;
    }
    return match[1].toUpperCase() === "REG_EXPAND_SZ"
      ? expandEnvironmentStrings(value, env)
      : value;
  }
  return null;
}

/**
 * Canonical form for comparing two Windows file paths: realpath where the
 * file exists (resolves 8.3 names and symlinks), win32-normalized, no
 * trailing separator, case-folded.
 */
function canonicalizeWindowsPath(
  path: string,
  existsSync: (path: string) => boolean,
  realpathSync: (path: string) => string,
): string {
  let resolved = path;
  if (existsSync(path)) {
    try {
      resolved = realpathSync(path);
    } catch {
      // Keep the original spelling; normalization below still applies.
    }
  }
  return winPath
    .normalize(resolved)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

const isExitCodeOne = (error: Error): boolean =>
  (error as { code?: unknown }).code === 1;

function probeVcamRegistrationWithRaw(
  deps: VcamSelfHealDepsT,
): Promise<ProbeWithRawT> {
  const execFile = deps.execFile ?? nodeExecFile;
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const realpathSync = deps.realpathSync ?? nodeRealpathSync.native;
  const env = deps.env ?? process.env;
  const installedDllPath = (deps.resolveDllPath ?? resolveVcamHelperDllPath)();
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", VCAM_INPROC_SERVER_KEY, "/ve", "/reg:64"],
      { timeout: REG_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const out = toText(stdout);
        const err = toText(stderr);
        const raw = truncateRaw(`${out}\n${err}`);
        if (error) {
          // reg.exe exits 1 for "key or value not found" in every locale;
          // the error text itself is localized and therefore not inspected.
          if (isExitCodeOne(error) && !/REG_/i.test(out + err)) {
            resolve({ probe: { state: "missing" }, raw });
            return;
          }
          const reason = raw
            ? `${toErrorMessage(error)}; output: ${raw}`
            : toErrorMessage(error);
          resolve({ probe: { state: "unknown", reason }, raw });
          return;
        }
        const dllPath = parseRegQueryDefaultValue(out, env);
        if (dllPath === null) {
          // A successful query we cannot read is NOT evidence of a missing
          // registration (localized or unexpected reg.exe output).
          resolve({
            probe: {
              state: "unknown",
              reason: `could not parse reg.exe output: ${raw || "<empty>"}`,
            },
            raw,
          });
          return;
        }
        if (!existsSync(dllPath)) {
          resolve({ probe: { state: "stale", dllPath, installedDllPath }, raw });
          return;
        }
        const samePath =
          canonicalizeWindowsPath(dllPath, existsSync, realpathSync) ===
          canonicalizeWindowsPath(installedDllPath, existsSync, realpathSync);
        resolve({
          probe: samePath
            ? { state: "registered", dllPath }
            : { state: "stale", dllPath, installedDllPath },
          raw,
        });
      },
    );
  });
}

/**
 * Probe `HKLM\SOFTWARE\Classes\CLSID\{CLSID}\InprocServer32` in the 64-bit
 * registry view (the one the Frame Server reads) via reg.exe.
 *
 * `registered` requires the registered file to exist AND to be the packaged
 * DLL (`resolveDllPath`); any other existing file is `stale`.
 */
export async function probeVcamRegistration(
  deps: VcamSelfHealDepsT = {},
): Promise<VcamRegistrationProbeT> {
  return (await probeVcamRegistrationWithRaw(deps)).probe;
}

/**
 * Pick the 64-bit regsvr32: from a 32-bit process `System32` is redirected
 * to SysWOW64, `Sysnative` is the un-redirected alias (same pin as
 * build/windows-installer.nsh). From a 64-bit process Sysnative does not
 * exist and System32 already is the 64-bit directory.
 */
export function resolveRegsvr32Path(
  env: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean,
): string {
  const windir =
    lookupEnv(env, "WINDIR") ?? lookupEnv(env, "SystemRoot") ?? DEFAULT_WINDIR;
  const sysnative = winPath.join(windir, "Sysnative", "regsvr32.exe");
  return existsSync(sysnative)
    ? sysnative
    : winPath.join(windir, "System32", "regsvr32.exe");
}

/** Build the PowerShell command that raises the UAC prompt. @internal */
export function buildElevatedRegsvr32Command(
  regsvr32Path: string,
  dllPath: string,
): string {
  // PowerShell Start-Process -Verb RunAs is the only shell-free way to raise
  // a UAC prompt from an unelevated process; -Wait blocks until regsvr32
  // finished and -PassThru + exit propagates regsvr32's own exit code (a
  // declined UAC prompt throws inside PowerShell and exits non-zero too).
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return `$p = Start-Process -FilePath ${quote(regsvr32Path)} -ArgumentList '/s',${quote(dllPath)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
}

function runElevatedRegsvr32(
  regsvr32Path: string,
  dllPath: string,
  execFile: ExecFileLikeT,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        buildElevatedRegsvr32Command(regsvr32Path, dllPath),
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

const defaultMarkerFs: VcamSelfHealMarkerFsT = {
  readFileSync: (path) => nodeReadFileSync(path, "utf8"),
  writeFileSync: (path, body) => nodeWriteFileSync(path, body, "utf8"),
  unlinkSync: (path) => nodeUnlinkSync(path),
  mkdirSync: (path) => nodeMkdirSync(path, { recursive: true }),
};

function resolveMarkerPath(deps: VcamSelfHealDepsT): string | null {
  if (deps.markerPath) {
    return deps.markerPath;
  }
  try {
    return join(getBridgeContext().userDataDir, VCAM_SELF_HEAL_MARKER_FILE);
  } catch {
    return null;
  }
}

type MarkerStoreT = {
  read: () => VcamSelfHealMarkerT | null;
  write: (outcome: VcamSelfHealMarkerT["outcome"]) => void;
  clear: () => void;
};

function createMarkerStore(
  deps: VcamSelfHealDepsT,
  dllPath: string,
  logger: LoggerT,
): MarkerStoreT {
  const markerPath = resolveMarkerPath(deps);
  const fs = deps.markerFs ?? defaultMarkerFs;
  const existsSync = deps.existsSync ?? nodeExistsSync;
  const appVersion = deps.appVersion ?? getRuntimeAppVersion();
  const now = deps.now ?? (() => Date.now());
  return {
    read: () => {
      if (!markerPath || !existsSync(markerPath)) {
        return null;
      }
      try {
        const parsed = VcamSelfHealMarkerSchema.safeParse(
          JSON.parse(fs.readFileSync(markerPath)),
        );
        if (!parsed.success) {
          return null;
        }
        // A marker for another version or install location is obsolete:
        // an update re-registers the DLL, so one more attempt is allowed.
        return parsed.data.app_version === appVersion &&
          parsed.data.dll_path === dllPath
          ? parsed.data
          : null;
      } catch {
        // A corrupt marker only costs one extra prompt; never fail the start.
        return null;
      }
    },
    write: (outcome) => {
      if (!markerPath) {
        return;
      }
      try {
        fs.mkdirSync(dirname(markerPath));
        const marker: VcamSelfHealMarkerT = {
          app_version: appVersion,
          dll_path: dllPath,
          attempted_at: now(),
          outcome,
        };
        fs.writeFileSync(markerPath, JSON.stringify(marker));
      } catch (error: unknown) {
        logger.warn(
          `[Meeting] VCam self-heal marker could not be written (${toErrorMessage(error)}); relying on the in-process guard`,
        );
      }
    },
    clear: () => {
      if (!markerPath || !existsSync(markerPath)) {
        return;
      }
      try {
        fs.unlinkSync(markerPath);
      } catch {
        // Leaving a stale "failed" marker only suppresses a future prompt.
      }
    },
  };
}

const describeProbe = (probe: VcamRegistrationProbeT): string => {
  switch (probe.state) {
    case "stale":
      return `CLSID points at ${probe.dllPath} instead of the installed ${probe.installedDllPath}`;
    case "missing":
      return "CLSID is not registered in HKLM (64-bit view)";
    case "unknown":
      return `registry probe unavailable (${probe.reason}), error reports 0x80040154`;
    case "registered":
      return `CLSID is registered (${probe.dllPath})`;
  }
};

const adminCommand = (dllPath: string): string =>
  `Register manually from an elevated prompt: regsvr32 "${dllPath}"`;

/**
 * Run a virtual-camera start, self-healing a missing DLL registration once.
 *
 * On a start failure (win32 only) the CLSID registration is probed: a missing
 * or stale (file gone / different install) InprocServer32 entry triggers ONE
 * elevated regsvr32 of the packaged DLL, a registry re-check and exactly one
 * retry of startVcam. A registration that looks intact is left alone. If the
 * probe itself is unavailable, the legacy trigger (REGDB_E_CLASSNOTREG in
 * the error text) decides. Every other failure - and a declined/failed
 * elevation - rethrows the original error.
 *
 * With `allowElevation: false` (unattended auto-arm) nothing is ever
 * prompted: the diagnosis and the admin command are logged instead. A failed
 * attempt is persisted per app version + DLL path so the operator sees at
 * most one UAC prompt per install; only a verified heal clears it.
 */
export async function runVcamStartWithRegistrationSelfHeal<T>(
  startVcam: () => Promise<T>,
  deps: VcamSelfHealDepsT = {},
): Promise<T> {
  try {
    return await startVcam();
  } catch (error: unknown) {
    const platform = deps.platform ?? process.platform;
    if (platform !== "win32") {
      throw error;
    }
    const allowElevation = deps.allowElevation ?? true;
    if (allowElevation && selfHealAttemptedThisSession) {
      throw error;
    }
    const logger = getLogger();
    const message = toErrorMessage(error);
    const execFile = deps.execFile ?? nodeExecFile;
    const existsSync = deps.existsSync ?? nodeExistsSync;
    const env = deps.env ?? process.env;
    const dllPath = (deps.resolveDllPath ?? resolveVcamHelperDllPath)();
    const probeDeps: VcamSelfHealDepsT = {
      ...deps,
      execFile,
      existsSync,
      env,
      resolveDllPath: () => dllPath,
    };

    const probe = await probeVcamRegistration(probeDeps);
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

    const diagnosis = describeProbe(probe);
    if (!allowElevation) {
      logger.warn(
        `[Meeting] vcam_not_registered: ${diagnosis}; unattended start never prompts for elevation. ${adminCommand(dllPath)}`,
      );
      throw error;
    }

    const marker = createMarkerStore(deps, dllPath, logger);
    const previous = marker.read();
    if (previous) {
      selfHealAttemptedThisSession = true;
      logger.warn(
        `[Meeting] vcam_not_registered: ${diagnosis}; a self-heal for this install already ${previous.outcome === "failed" ? "failed" : "ran"} at ${new Date(previous.attempted_at).toISOString()}, not prompting again. ${adminCommand(dllPath)}`,
      );
      throw error;
    }

    // Mark before running so a second failure in this session - or a
    // process that dies while the prompt is open - never re-prompts.
    selfHealAttemptedThisSession = true;
    if (!existsSync(dllPath)) {
      logger.warn(
        `[Meeting] VCam registration self-heal skipped: DLL not found at ${dllPath} (unpackaged dev run?)`,
      );
      throw error;
    }
    marker.write("pending");
    const regsvr32Path = resolveRegsvr32Path(env, existsSync);
    logger.warn(
      `[Meeting] Virtual camera ${diagnosis}; requesting elevated ${regsvr32Path} for ${dllPath}`,
    );
    try {
      await runElevatedRegsvr32(regsvr32Path, dllPath, execFile);
    } catch (healError: unknown) {
      marker.write("failed");
      logger.error(
        `[Meeting] VCam registration self-heal failed (${toErrorMessage(healError)}). ${adminCommand(dllPath)}`,
      );
      throw error;
    }

    const { probe: verify, raw } = await probeVcamRegistrationWithRaw(probeDeps);
    if (verify.state === "missing" || verify.state === "stale") {
      marker.write("failed");
      const detail =
        verify.state === "missing"
          ? "still not registered"
          : `stale (${verify.dllPath})`;
      logger.error(
        `[Meeting] VCam registration self-heal: regsvr32 reported success but the CLSID is ${detail}. installed=${dllPath} reg.exe output="${raw || "<empty>"}". ${adminCommand(dllPath)}`,
      );
      throw error;
    }
    if (verify.state === "unknown") {
      logger.warn(
        `[Meeting] VCam registration could not be verified after regsvr32 (${verify.reason}); installed=${dllPath} reg.exe output="${raw || "<empty>"}"; retrying virtual camera start once anyway`,
      );
    } else {
      logger.info(
        `[Meeting] VCam DLL registered (${verify.dllPath}); retrying virtual camera start once`,
      );
    }
    let result: T;
    try {
      result = await startVcam();
    } catch (retryError: unknown) {
      marker.write("failed");
      throw retryError;
    }
    // The camera works again: forget the attempt. After a VERIFIED heal the
    // in-process guard is re-armed too, should the registration get lost
    // again later in this session.
    marker.clear();
    if (verify.state === "registered") {
      selfHealAttemptedThisSession = false;
    }
    return result;
  }
}
