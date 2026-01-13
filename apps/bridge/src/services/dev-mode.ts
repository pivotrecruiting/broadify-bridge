/**
 * Resolve development mode flag from environment.
 */
export function isDevelopmentMode(): boolean {
  return String(process.env.DEVELOPMENT || "").toLowerCase() === "true";
}
