export type UpdaterDisableContextT = {
  disableEnv: string | undefined;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  appImage: string | undefined;
};

/**
 * Resolve why auto-update should be disabled in the given runtime context.
 *
 * @param ctx Runtime context (env, platform, isPackaged).
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

  return null;
}

/**
 * Sanitize update-related error messages to avoid leaking secrets.
 */
export function sanitizeUpdaterErrorMessage(message: string): string {
  return message
    .replace(/(bearer|token|authorization)\s+[A-Za-z0-9._\-]+/gi, "$1 [REDACTED]")
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
