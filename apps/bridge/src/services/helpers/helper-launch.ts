import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getBridgeContext } from "../bridge-context.js";

/**
 * Shared launch plumbing for the native helpers (PGM now; the meeting manager
 * keeps its own copy until its next refactor): binary resolution (env
 * override, dev tree, packaged resources, macOS app bundle), launch through
 * Launch Services on macOS so the camera (TCC) prompt is attributed to the
 * signed helper app, sidecar event log path and control socket path.
 */
export type HelperSpecT = {
  /** Directory under apps/bridge/native and resources/native, e.g. "pgm-helper". */
  dirName: string;
  /** Binary name without extension, e.g. "pgm-helper". */
  binaryName: string;
  /** Environment variable overriding the binary path. */
  pathEnv: string;
  /** macOS bundle name, e.g. "Broadify Bridge PGM Helper.app". */
  macosAppName: string;
  /** macOS executable inside the bundle, e.g. "BroadifyPgmHelper". */
  macosExecutableName: string;
  /** Prefix of the control socket / pipe and of the event log file, e.g. "pgm". */
  socketPrefix: string;
};

export type HelperIdentityT = {
  path: string;
  appPath: string | null;
  codeSignatureStatus: "not_checked" | "valid" | "invalid" | "missing";
};

function moduleDirname(): string {
  try {
    // Indirect eval keeps `import.meta` out of the CommonJS transform Jest applies.
    const url = (0, eval)("import.meta.url") as string;
    return dirname(fileURLToPath(url));
  } catch {
    return process.cwd();
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function macosExecutable(spec: HelperSpecT, appPath: string): string {
  return join(appPath, "Contents", "MacOS", spec.macosExecutableName);
}

function findMacosAppPath(spec: HelperSpecT): string | null {
  const resourcesPath = process.resourcesPath;
  const candidates = uniquePaths([
    ...(process.env.NODE_ENV === "production" && resourcesPath ? [join(resourcesPath, "native", spec.dirName, spec.macosAppName)] : []),
    join(process.cwd(), "apps/bridge/native", spec.dirName, spec.macosAppName),
    join(process.cwd(), "native", spec.dirName, spec.macosAppName),
    join(moduleDirname(), "../../../native", spec.dirName, spec.macosAppName),
  ]);
  return candidates.find((candidate) => existsSync(macosExecutable(spec, candidate))) ?? null;
}

/** Resolves the helper binary; on macOS prefers the signed app bundle. */
export function resolveHelperPath(spec: HelperSpecT): string {
  const envPath = process.env[spec.pathEnv];
  if (envPath) {
    return envPath;
  }
  const binaryName = platform() === "win32" ? `${spec.binaryName}.exe` : spec.binaryName;
  const resourcesPath = process.resourcesPath;
  if (platform() === "darwin") {
    const appPath = findMacosAppPath(spec);
    if (appPath) {
      return macosExecutable(spec, appPath);
    }
    if (process.env.NODE_ENV === "production" && resourcesPath) {
      return macosExecutable(spec, join(resourcesPath, "native", spec.dirName, spec.macosAppName));
    }
  }
  if (process.env.NODE_ENV === "production" && resourcesPath) {
    return join(resourcesPath, "native", spec.dirName, binaryName);
  }
  const candidates = uniquePaths([
    join(process.cwd(), "apps/bridge/native", spec.dirName, binaryName),
    join(process.cwd(), "native", spec.dirName, binaryName),
    join(moduleDirname(), "../../../native", spec.dirName, binaryName),
  ]);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function inspectCodesign(targetPath: string): HelperIdentityT["codeSignatureStatus"] {
  if (platform() !== "darwin") {
    return "not_checked";
  }
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", targetPath], { stdio: "ignore" });
    return "valid";
  } catch {
    return existsSync(targetPath) ? "invalid" : "missing";
  }
}

export function inspectHelperIdentity(_spec: HelperSpecT, helperPath: string): HelperIdentityT {
  const marker = ".app/Contents/MacOS/";
  const index = helperPath.indexOf(marker);
  const appPath = platform() === "darwin" && index !== -1 ? helperPath.slice(0, index) + ".app" : null;
  return { path: helperPath, appPath, codeSignatureStatus: inspectCodesign(appPath ?? helperPath) };
}

export function resolveHelperEventLogPath(spec: HelperSpecT): string {
  try {
    return join(getBridgeContext().userDataDir, `${spec.socketPrefix}-helper-events.log`);
  } catch {
    return join(tmpdir(), `broadify-${spec.socketPrefix}-helper-events.log`);
  }
}

export function resolveControlSocketPath(spec: HelperSpecT): string {
  const suffix = `${process.pid}-${Date.now()}`;
  if (platform() === "win32") {
    return `\\\\.\\pipe\\broadify-${spec.socketPrefix}-${suffix}`;
  }
  return join(tmpdir(), `broadify-${spec.socketPrefix}-${suffix}.sock`);
}

export type LaunchedHelperT = {
  child: ChildProcess;
  /** True when started via `open -W -n` (stdout is swallowed; use the event log and control.ping). */
  viaLaunchServices: boolean;
};

/** Spawns the helper; on macOS with an app bundle through Launch Services so TCC attributes prompts to it. */
export function launchHelper(identity: HelperIdentityT, args: string[], env: NodeJS.ProcessEnv): LaunchedHelperT {
  const viaLaunchServices = platform() === "darwin" && identity.appPath !== null;
  const launchPath = viaLaunchServices ? "/usr/bin/open" : identity.path;
  const launchArgs = viaLaunchServices ? ["-W", "-n", identity.appPath as string, "--args", ...args] : args;
  const child = spawn(launchPath, launchArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
  return { child, viaLaunchServices };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries a ping until it answers; helper start-up briefly races the socket accept. */
export async function waitForHelperPing(
  ping: () => Promise<boolean>,
  attempts: number,
  delayMs: number,
): Promise<{ healthy: boolean; lastError: string | null }> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await ping()) {
        return { healthy: true, lastError: null };
      }
      lastError = "control.ping returned no pong";
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < attempts) {
      await sleep(delayMs);
    }
  }
  return { healthy: false, lastError };
}
