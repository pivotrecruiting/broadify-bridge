/**
 * Provides Vite/build-time env for the app updater (fake update flow in dev).
 * Injected by Vite in the app; can be mocked in tests to avoid import.meta.
 */
export function getUpdaterEnv(): Record<string, string | boolean> {
  if (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string | boolean> }).env) {
    return (import.meta as { env: Record<string, string | boolean> }).env;
  }
  return {};
}
