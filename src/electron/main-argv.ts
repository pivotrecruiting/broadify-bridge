/**
 * CLI argument helpers for the Electron main process.
 * Extracted for testability.
 */

/**
 * Read a CLI flag value from process arguments.
 *
 * @param argv Process argument list.
 * @param flag Flag name (e.g., --renderer-entry).
 * @returns Flag value or null when missing.
 */
export function getArgValue(argv: string[], flag: string): string | null {
  const index = argv.findIndex((arg) => arg === flag);
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

/**
 * Parse argv into a simple flag map.
 *
 * @param argv Process argument list.
 * @returns Map of flag -> value or true.
 */
export function getArgMap(argv: string[]): Map<string, string | true> {
  const map = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex > -1) {
      const key = arg.slice(2, eqIndex);
      const value = arg.slice(eqIndex + 1);
      map.set(key, value);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(arg.slice(2), next);
      i += 1;
    } else {
      map.set(arg.slice(2), true);
    }
  }
  return map;
}

/**
 * Resolve the renderer entry path for graphics renderer mode.
 *
 * @param argv Process argument list.
 * @returns Renderer entry path or null.
 */
export function resolveRendererEntry(argv: string[]): string | null {
  const args = getArgMap(argv);
  const explicit = args.get("renderer-entry");
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  const direct = getArgValue(argv, "--renderer-entry");
  if (direct) {
    return direct;
  }
  return argv.find((arg) => arg.endsWith("electron-renderer-entry.js")) || null;
}
