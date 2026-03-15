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
