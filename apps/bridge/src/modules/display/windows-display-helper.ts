import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type { PortDescriptorT } from "@broadify/protocol";
import { getBridgeContext } from "../../services/bridge-context.js";
import { resolveDisplayHelperPath } from "./display-helper.js";
import { normalizeWindowsConnectionType } from "./display-parse-utils.js";
import type { RawDisplayInfoT } from "./display-module-utils.js";

const WINDOWS_DISPLAY_DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_HELPER_STDOUT_BYTES = 1_048_576;
/** Upper bound for buffered helper stderr; anything beyond is dropped. */
const MAX_HELPER_STDERR_BYTES = 8_192;
/** Upper bound for the stderr excerpt carried in logs and errors. */
const MAX_STDERR_EXCERPT_CHARS = 512;
const WINDOWS_DISPLAY_DISCOVERY_ARGS = ["--list-displays"];

export type WindowsDisplayHelperErrorKindT =
  | "spawn_failed"
  | "helper_missing"
  | "missing_runtime"
  | "helper_failed"
  | "timeout"
  | "invalid_response"
  | "response_too_large";

/**
 * Error raised by the native Windows display helper path.
 *
 * `kind` lets callers distinguish a missing VC++ runtime (`missing_runtime`)
 * or a missing binary (`helper_missing`) from generic failures; `exitCode` is
 * the unsigned DWORD Node reports (e.g. 3221225781 = 0xC0000135).
 */
export class WindowsDisplayHelperError extends Error {
  readonly kind: WindowsDisplayHelperErrorKindT;
  readonly exitCode?: number;
  readonly stderrExcerpt?: string;

  constructor(
    kind: WindowsDisplayHelperErrorKindT,
    message: string,
    details: { exitCode?: number; stderrExcerpt?: string } = {},
  ) {
    super(message);
    this.name = "WindowsDisplayHelperError";
    this.kind = kind;
    if (details.exitCode !== undefined) {
      this.exitCode = details.exitCode;
    }
    if (details.stderrExcerpt) {
      this.stderrExcerpt = details.stderrExcerpt;
    }
  }
}

/**
 * NTSTATUS codes the Windows loader returns when a process dies before
 * reaching `main()`. Keys are the unsigned DWORD values Node reports.
 */
export const WINDOWS_LOADER_FAILURE_EXIT_CODES: Readonly<Record<number, string>> = {
  0xc0000135: "STATUS_DLL_NOT_FOUND",
  0xc0000139: "STATUS_ENTRYPOINT_NOT_FOUND",
  0xc0000142: "STATUS_DLL_INIT_FAILED",
};

const toUnsignedExitCode = (code: number | null): number | null =>
  code === null ? null : code >>> 0;

const formatExitCodeHex = (code: number): string =>
  `0x${code.toString(16).toUpperCase().padStart(8, "0")}`;

/**
 * Classify a helper exit code: loader failures (missing runtime DLLs) versus
 * any other non-zero exit. Accepts signed or unsigned 32-bit representations.
 */
export function classifyWindowsHelperExitCode(
  code: number | null,
): "missing_runtime" | "helper_failed" {
  const unsigned = toUnsignedExitCode(code);
  if (unsigned === null) {
    return "helper_failed";
  }
  return unsigned in WINDOWS_LOADER_FAILURE_EXIT_CODES
    ? "missing_runtime"
    : "helper_failed";
}

const toStderrExcerpt = (stderr: string): string | undefined => {
  const trimmed = stderr.trim();
  return trimmed ? trimmed.slice(0, MAX_STDERR_EXCERPT_CHARS) : undefined;
};

type WindowsDisplayHelperDepsT = {
  spawn: typeof spawn;
  resolveHelperPath: () => string;
  getHelperFileSize: (helperPath: string) => number | null;
};

const getHelperFileSize = (helperPath: string): number | null => {
  try {
    return statSync(helperPath).size;
  } catch {
    return null;
  }
};

const defaultDeps: WindowsDisplayHelperDepsT = {
  spawn,
  resolveHelperPath: resolveDisplayHelperPath,
  getHelperFileSize,
};

const NativeDisplayModeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    refresh_numerator: z.number().int().positive(),
    refresh_denominator: z.number().int().positive(),
    interlaced: z.boolean(),
    preferred: z.boolean(),
  })
  .strict();

const NativeDisplaySchema = z
  .object({
    device_name: z.string().regex(/^\\\\\.\\DISPLAY\d+$/i).max(128),
    monitor_device_path: z.string().max(4_096),
    friendly_name: z.string().min(1).max(512),
    adapter_luid: z.string().regex(/^[0-9a-f]{8}:[0-9a-f]{8}$/i),
    target_id: z.number().int().nonnegative(),
    output_technology: z.number().int(),
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    primary: z.boolean(),
    modes: z.array(NativeDisplayModeSchema).max(512),
  })
  .strict();

const NativeDisplayListSchema = z
  .object({
    type: z.literal("display_list"),
    version: z.literal(1),
    displays: z.array(NativeDisplaySchema).max(32),
  })
  .strict();

type NativeDisplayT = z.infer<typeof NativeDisplaySchema>;

const isInternalOutputTechnology = (value: number): boolean =>
  value === -2_147_483_648 || value === 2_147_483_648;

const resolveConnectionType = (
  outputTechnology: number,
): PortDescriptorT["type"] =>
  normalizeWindowsConnectionType(outputTechnology) ?? "displayport";

const buildStableId = (display: NativeDisplayT): string =>
  `win-${createHash("sha256")
    .update(
      display.monitor_device_path.trim() ||
        `${display.device_name}|${display.target_id}`,
    )
    .digest("hex")
    .slice(0, 16)}`;

export const mapNativeWindowsDisplays = (
  displays: NativeDisplayT[],
): RawDisplayInfoT[] =>
  displays
    .filter(
      (display) =>
        !isInternalOutputTechnology(display.output_technology) &&
        display.width > 0 &&
        display.height > 0,
    )
    .map((display) => ({
      name: display.friendly_name,
      connectionType: resolveConnectionType(display.output_technology),
      stableId: buildStableId(display),
      nativeSelector: display.device_name,
      resolution: { width: display.width, height: display.height },
      modes: display.modes.map((mode) => ({
        width: mode.width,
        height: mode.height,
        fps: mode.refresh_numerator / mode.refresh_denominator,
        fieldDominance: mode.interlaced
          ? ("interlaced" as const)
          : ("progressive" as const),
        preferred: mode.preferred,
      })),
    }));

export const parseNativeWindowsDisplayList = (
  payload: string,
): RawDisplayInfoT[] => {
  const parsedJson = JSON.parse(payload) as unknown;
  const result = NativeDisplayListSchema.parse(parsedJson);
  return mapNativeWindowsDisplays(result.displays);
};

const sanitizeHelperPath = (helperPath: string): string => {
  const normalized = helperPath.replace(/\\/g, "/");
  const nativeResourceIndex = normalized
    .toLowerCase()
    .lastIndexOf("/native/display-helper/");
  if (nativeResourceIndex >= 0) {
    return `<resources>${normalized.slice(nativeResourceIndex)}`;
  }
  return `<external>/${basename(normalized) || "display-helper.exe"}`;
};

const getErrorField = (
  error: unknown,
  field: "code" | "errno" | "syscall",
): string | number | null => {
  if (!error || typeof error !== "object" || !(field in error)) {
    return null;
  }
  const value = (error as Record<string, unknown>)[field];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (field === "syscall") {
      return value.trim().split(/\s+/, 1)[0]?.slice(0, 64) || null;
    }
    return value.slice(0, 128);
  }
  return null;
};

const logSpawnFailure = (
  error: unknown,
  helperPath: string,
  helperFileSize: number | null,
): WindowsDisplayHelperError => {
  const code = getErrorField(error, "code");
  const details = {
    event: "windows_display_helper_spawn_failed",
    code,
    errno: getErrorField(error, "errno"),
    syscall: getErrorField(error, "syscall"),
    helper_path: sanitizeHelperPath(helperPath),
    helper_size_bytes: helperFileSize,
    arguments: WINDOWS_DISPLAY_DISCOVERY_ARGS,
  };
  getBridgeContext().logger.error(
    `[DisplayDetector] ${JSON.stringify(details)}`,
  );
  if (code === "ENOENT") {
    return new WindowsDisplayHelperError(
      "helper_missing",
      "Native Windows display helper spawn failed (code=ENOENT): helper binary not found. Reinstall the bridge.",
    );
  }
  return new WindowsDisplayHelperError(
    "spawn_failed",
    `Native Windows display helper spawn failed (code=${code ?? "unknown"})`,
  );
};

const logHelperExitFailure = (
  code: number | null,
  stderr: string,
  helperPath: string,
): WindowsDisplayHelperError => {
  const kind = classifyWindowsHelperExitCode(code);
  const unsignedCode = toUnsignedExitCode(code);
  const ntstatus =
    unsignedCode === null
      ? null
      : (WINDOWS_LOADER_FAILURE_EXIT_CODES[unsignedCode] ?? null);
  const stderrExcerpt = toStderrExcerpt(stderr);
  const details = {
    event: "windows_display_helper_failed",
    kind,
    exit_code: unsignedCode,
    exit_code_hex: unsignedCode === null ? null : formatExitCodeHex(unsignedCode),
    ntstatus,
    stderr_excerpt: stderrExcerpt ?? null,
    helper_path: sanitizeHelperPath(helperPath),
  };
  getBridgeContext().logger.error(
    `[DisplayDetector] ${JSON.stringify(details)}`,
  );
  const message =
    kind === "missing_runtime"
      ? `Native display helper could not start (${ntstatus}). The Microsoft Visual C++ runtime is missing; install vc_redist.x64 or reinstall the bridge.`
      : `Native display helper exited with code ${unsignedCode ?? "unknown"}`;
  return new WindowsDisplayHelperError(kind, message, {
    ...(unsignedCode !== null ? { exitCode: unsignedCode } : {}),
    stderrExcerpt,
  });
};

export const listNativeWindowsDisplays = async (
  dependencyOverrides: Partial<WindowsDisplayHelperDepsT> = {},
): Promise<RawDisplayInfoT[]> => {
  const deps = { ...defaultDeps, ...dependencyOverrides };
  return new Promise<RawDisplayInfoT[]>((resolve, reject) => {
    const startedAt = Date.now();
    const helperPath = deps.resolveHelperPath();
    const helperFileSize = deps.getHelperFileSize(helperPath);
    let child: ReturnType<typeof spawn>;
    try {
      child = deps.spawn(helperPath, WINDOWS_DISPLAY_DISCOVERY_ARGS, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(logSpawnFailure(error, helperPath, helperFileSize));
      return;
    }
    let stdout = "";
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;

    const finish = (
      result: { displays: RawDisplayInfoT[] } | { error: Error },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      if ("error" in result) {
        reject(result.error);
        return;
      }
      getBridgeContext().logger.info(
        `[DisplayDetector] Native Windows discovery completed in ${Date.now() - startedAt}ms (${result.displays.length} external display(s))`,
      );
      resolve(result.displays);
    };

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        error: new WindowsDisplayHelperError(
          "timeout",
          `Native Windows display discovery timed out after ${WINDOWS_DISPLAY_DISCOVERY_TIMEOUT_MS}ms`,
        ),
      });
    }, WINDOWS_DISPLAY_DISCOVERY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish({
          error: new WindowsDisplayHelperError(
            "response_too_large",
            "Native display helper response too large",
          ),
        });
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_HELPER_STDERR_BYTES) return;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      const slice = buffer.subarray(0, MAX_HELPER_STDERR_BYTES - stderrBytes);
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;
    });

    child.on("error", (error) =>
      finish({ error: logSpawnFailure(error, helperPath, helperFileSize) }),
    );
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ error: logHelperExitFailure(code, stderr, helperPath) });
        return;
      }
      try {
        finish({ displays: parseNativeWindowsDisplayList(stdout.trim()) });
      } catch (error) {
        finish({
          error: new WindowsDisplayHelperError(
            "invalid_response",
            `Invalid native display helper response: ${error instanceof Error ? error.message : String(error)}`,
          ),
        });
      }
    });
  });
};
