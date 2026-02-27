export type EngineConnectValidationResultT =
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      body: {
        type: "atem";
        ip: string;
        port: number;
      };
    };

/**
 * Validate desktop IPC input for engine connect and build bridge request body.
 *
 * Desktop UI currently supports ATEM only, so the engine type is fixed.
 */
export function validateEngineConnectInput(
  ip?: string,
  port?: number,
): EngineConnectValidationResultT {
  if (!ip) {
    return {
      success: false,
      error: "IP address is required",
    };
  }

  if (!port) {
    return {
      success: false,
      error: "Port is required",
    };
  }

  return {
    success: true,
    body: {
      type: "atem",
      ip,
      port,
    },
  };
}
