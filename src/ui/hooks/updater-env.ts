/**
 * Provides Vite/build-time env for the app updater (fake update flow in dev).
 * Injected by Vite in the app; can be mocked in tests to avoid import.meta.
 */

/** Test-only override; set to non-null in tests to bypass import.meta. */
let testEnvOverride: Record<string, string | boolean> | null = null;

function getImportMetaEnv(): Record<string, string | boolean> | undefined {
  try {
    return (0, eval)("typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : undefined");
  } catch {
    return undefined;
  }
}

export function getUpdaterEnv(): Record<string, string | boolean> {
  if (testEnvOverride !== null) {
    return testEnvOverride;
  }
  const env = getImportMetaEnv();
  if (env) {
    return env;
  }
  return {};
}

/**
 * Test-only: override env for getUpdaterEnv. Call with null to reset.
 * @internal
 */
export function __setUpdaterEnvForTesting(env: Record<string, string | boolean> | null): void {
  testEnvOverride = env;
}
