/**
 * Stable error codes of the live program subsystem. The web app maps them to
 * UI states; the codes never change once shipped (snake_case, like the other
 * subsystems' helper codes).
 */
export const PGM_ERROR_CODES = [
  "pgm_disabled",
  "pgm_unsupported_bridge",
  "pgm_not_implemented",
  "pgm_viewer_limit",
  "pgm_no_signal",
  "pgm_sdp_invalid",
  "pgm_session_not_found",
  "input_not_found",
  "device_in_use",
  "camera_permission_denied",
  "encoder_unavailable",
  "helper_not_reachable",
] as const;

export type PgmErrorCodeT = (typeof PGM_ERROR_CODES)[number];

export class PgmError extends Error {
  readonly code: PgmErrorCodeT;
  readonly data?: Record<string, unknown>;

  constructor(code: PgmErrorCodeT, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "PgmError";
    this.code = code;
    this.data = data;
  }

  toJSON(): { code: PgmErrorCodeT; message: string; data?: Record<string, unknown> } {
    return { code: this.code, message: this.message, data: this.data };
  }
}

export function isPgmError(error: unknown): error is PgmError {
  return error instanceof PgmError;
}
