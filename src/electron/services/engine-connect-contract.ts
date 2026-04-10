export type DesktopEngineTypeT = "atem" | "vmix";

export type EngineConnectValidationResultT =
  | {
      success: false;
      error: string;
    }
  | {
      success: true;
      body: {
        type: DesktopEngineTypeT;
        ip: string;
        port: number;
      };
    };

/**
 * Validate desktop IPC input for engine connect and build bridge request body.
 *
 * Desktop UI currently supports ATEM and vMix.
 */
export function validateEngineConnectInput(
  type?: DesktopEngineTypeT,
  ip?: string,
  port?: number,
): EngineConnectValidationResultT {
  const engineType = type ?? "atem";

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
      type: engineType,
      ip,
      port,
    },
  };
}
