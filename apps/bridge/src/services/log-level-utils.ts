/**
 * Pino log level numeric mapping.
 */
export const LOG_LEVELS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 70,
};

/**
 * Normalize a log level string to a valid pino level.
 *
 * @param value Raw level from env or config.
 * @param fallback Fallback when value is empty or invalid.
 * @returns Valid level key.
 */
export function normalizeLevel(
  value: string | undefined,
  fallback: string
): string {
  if (!value) {
    return fallback;
  }
  const key = value.toLowerCase();
  return LOG_LEVELS[key] ? key : fallback;
}

/**
 * Clamp a log level to a maximum (e.g. enforce info in production).
 * Lower numeric level = more verbose. Clamps when value is more verbose than max.
 *
 * @param value Current level.
 * @param maxLevel Minimum level (floor) - e.g. "info" excludes trace/debug.
 * @returns Clamped level.
 */
export function clampMaxLevel(value: string, maxLevel: string): string {
  const current = LOG_LEVELS[value] ?? LOG_LEVELS.info;
  const max = LOG_LEVELS[maxLevel] ?? LOG_LEVELS.info;
  return current < max ? maxLevel : value;
}
