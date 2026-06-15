import { z } from "zod";

/**
 * Zod schemas for relay command payloads (non-graphics commands).
 */
export const EmptyPayloadSchema = z.object({}).strict();

export const PairingCodeSchema = z
  .object({
    pairingCode: z.string().trim().min(4).max(32),
  })
  .strict();

export const ListOutputsSchema = z
  .object({
    refresh: z.boolean().optional(),
  })
  .strict();

export const EngineConnectSchema = z
  .object({
    type: z.enum(["atem", "tricaster", "vmix"]),
    ip: z.string().ip({ version: "v4" }),
    port: z.number().int().min(1).max(65535),
  })
  .strict();

export const MacroIdSchema = z
  .object({
    macroId: z.number().int(),
  })
  .strict();

export const VmixActionSchema = z
  .discriminatedUnion("actionType", [
    z.object({
      actionType: z.literal("script_start"),
      scriptName: z.string().trim().min(1).max(256),
    }).strict(),
    z.object({
      actionType: z.literal("script_stop"),
      scriptName: z.string().trim().min(1).max(256),
    }).strict(),
  ]);

/**
 * Parse a relay payload with a schema and normalize errors.
 */
export const parseRelayPayload = <T>(
  schema: z.ZodType<T>,
  payload: unknown,
  errorMessage: string
): T => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(errorMessage);
  }
  return parsed.data;
};
