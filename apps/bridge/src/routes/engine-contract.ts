import { z } from "zod";
import { EngineErrorCode } from "../services/engine/engine-errors.js";

/**
 * Connect request schema.
 * All fields are required - no fallback to runtimeConfig.
 */
export const ConnectRequestSchema = z.object({
  type: z.enum(["atem", "tricaster", "vmix"]),
  ip: z.string().ip({ version: "v4" }),
  port: z.number().int().min(1).max(65535),
});

export const VmixActionRequestSchema = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("script_start"),
    scriptName: z.string().trim().min(1).max(256),
  }),
  z.object({
    actionType: z.literal("script_stop"),
    scriptName: z.string().trim().min(1).max(256),
  }),
]);

/**
 * Map domain engine errors to HTTP status codes.
 */
export function mapEngineErrorToStatusCode(code: EngineErrorCode): number {
  if (
    code === EngineErrorCode.ALREADY_CONNECTED ||
    code === EngineErrorCode.ALREADY_CONNECTING
  ) {
    return 409; // Conflict
  }

  if (
    code === EngineErrorCode.CONNECTION_TIMEOUT ||
    code === EngineErrorCode.DEVICE_UNREACHABLE
  ) {
    return 504; // Gateway Timeout
  }

  if (
    code === EngineErrorCode.CONNECTION_REFUSED ||
    code === EngineErrorCode.NETWORK_ERROR
  ) {
    return 503; // Service Unavailable
  }

  if (
    code === EngineErrorCode.INVALID_IP ||
    code === EngineErrorCode.INVALID_PORT
  ) {
    return 400; // Bad Request
  }

  return 500;
}
