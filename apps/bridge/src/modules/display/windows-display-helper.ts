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
const WINDOWS_DISPLAY_DISCOVERY_ARGS = ["--list-displays"];

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
): Error => {
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
  return new Error(
    `Native Windows display helper spawn failed (code=${code ?? "unknown"})`,
  );
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
        error: new Error(
          `Native Windows display discovery timed out after ${WINDOWS_DISPLAY_DISCOVERY_TIMEOUT_MS}ms`,
        ),
      });
    }, WINDOWS_DISPLAY_DISCOVERY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish({ error: new Error("Native display helper response too large") });
      }
    });

    child.stderr?.on("data", () => undefined);

    child.on("error", (error) =>
      finish({ error: logSpawnFailure(error, helperPath, helperFileSize) }),
    );
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({
          error: new Error(
            `Native display helper exited with code ${code ?? "unknown"}`,
          ),
        });
        return;
      }
      try {
        finish({ displays: parseNativeWindowsDisplayList(stdout.trim()) });
      } catch (error) {
        finish({
          error: new Error(
            `Invalid native display helper response: ${error instanceof Error ? error.message : String(error)}`,
          ),
        });
      }
    });
  });
};
