import type { CanonXCResponseT } from "./canon-xc-service.js";
// Type-only import: erased at runtime, so it cannot create a module cycle
// with command-router.ts (which imports the Canon service graph).
import type { RelayCommandResult } from "../command-router.js";

/** Fallback `errorCode` when the Canon response carries no diagnostic code. */
export const CANON_XC_DEFAULT_ERROR_CODE = "canon_xc_failed";

/**
 * Maps a Canon XC service response onto the relay command result contract.
 * `ok:false` becomes `success:false`; the full response stays in `data` so
 * clients that already inspect `data.ok`/`data.rawError` keep working.
 * `error` prefers a non-empty `rawError`, otherwise the human-readable
 * `message`; `errorCode` prefers the diagnostic code, otherwise the fallback.
 */
export function canonResponseToCommandResult(
  response: CanonXCResponseT,
): RelayCommandResult {
  if (response.ok) {
    return { success: true, data: response };
  }

  const rawError =
    typeof response.rawError === "string" && response.rawError.length > 0
      ? response.rawError
      : null;

  return {
    success: false,
    error: rawError ?? response.message,
    errorCode: response.diagnostic?.code ?? CANON_XC_DEFAULT_ERROR_CODE,
    data: response,
  };
}
