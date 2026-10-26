import { join } from "node:path";

/**
 * How the running Windows build was installed, derived from the presence of
 * the NSIS elevate helper. electron-builder copies `elevate.exe` into
 * `resources/` only for the NSIS target; the MSI (and a portable build)
 * ship without it. electron-updater's NSIS install path needs that helper
 * (latest.yml carries `isAdminRightsRequired: true`) and would otherwise quit
 * the app without installing anything.
 */
export type WindowsInstallKindT = "nsis" | "msi_or_portable";

export const WINDOWS_ELEVATE_HELPER_FILE_NAME = "elevate.exe";

/**
 * Disable reason shown on Windows installations that cannot be updated in
 * place; app-updater.ts matches it by identity to attach the `msi_install`
 * error code.
 */
export const UPDATER_DISABLE_REASON_MSI_OR_PORTABLE =
  "Auto-update is unavailable for MSI or portable installations. Install the latest .exe installer to re-enable automatic updates.";

export type UpdaterDisableContextT = {
  disableEnv: string | undefined;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appImage: string | undefined;
  windowsInstallKind: WindowsInstallKindT | null;
};

/**
 * Detect the Windows install kind from the packaged resources directory.
 *
 * @returns `null` off Windows or without a resources path, `"nsis"` when the
 *   elevate helper is present, `"msi_or_portable"` otherwise.
 */
export function resolveWindowsInstallKind(params: {
  platform: NodeJS.Platform;
  resourcesPath: string | undefined;
  existsSync: (p: string) => boolean;
}): WindowsInstallKindT | null {
  if (params.platform !== "win32" || !params.resourcesPath) {
    return null;
  }
  return params.existsSync(join(params.resourcesPath, WINDOWS_ELEVATE_HELPER_FILE_NAME))
    ? "nsis"
    : "msi_or_portable";
}

/**
 * Resolve why auto-update should be disabled in the given runtime context.
 *
 * @param ctx Runtime context (env, platform, isPackaged, Windows install kind).
 * @returns Reason string when disabled, null when enabled.
 */
export function getUpdaterDisableReason(ctx: UpdaterDisableContextT): string | null {
  if (ctx.disableEnv === "1") {
    return "Disabled by BROADIFY_DISABLE_AUTO_UPDATE=1.";
  }

  if (!ctx.isPackaged) {
    return "Disabled in development builds.";
  }

  if (!["darwin", "win32", "linux"].includes(ctx.platform)) {
    return `Unsupported platform: ${ctx.platform}.`;
  }

  if (ctx.platform === "linux" && !ctx.appImage) {
    return "Linux auto-update requires AppImage runtime.";
  }

  if (ctx.platform === "win32" && ctx.windowsInstallKind !== "nsis") {
    return UPDATER_DISABLE_REASON_MSI_OR_PORTABLE;
  }

  return null;
}

/**
 * Sanitize update-related error messages to avoid leaking secrets.
 */
export function sanitizeUpdaterErrorMessage(message: string): string {
  return message
    .replace(/(bearer|token|authorization)\s+[A-Za-z0-9._-]+/gi, "$1 [REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]");
}

/**
 * Parse an environment variable as integer milliseconds with fallback.
 */
export function parseIntervalMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
