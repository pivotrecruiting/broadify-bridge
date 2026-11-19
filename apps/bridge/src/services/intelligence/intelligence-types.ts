import { z } from "zod";

/**
 * Conversation Intelligence usage-event contract, version 1.
 *
 * One JSON object per line in the local usage log; JSON keys are snake_case
 * like every other cross-boundary payload. The zod schemas here are the single
 * source of truth for producers (usage-event-recorder) and future consumers
 * (upload manifest, cloud ingest). Documented in
 * docs/integration/conversation-intelligence-contract.md.
 */
export const USAGE_EVENT_VERSION = 1 as const;

const usageEventBase = {
  v: z.literal(USAGE_EVENT_VERSION),
  /** Bridge wall-clock epoch milliseconds (Date.now()). */
  at: z.number().int().nonnegative(),
};

export const GraphicShownEventSchema = z
  .object({
    ...usageEventBase,
    type: z.literal("graphic_shown"),
    /** Plane identity: "studio" | "meeting-back" | "meeting-front". */
    source: z.string().min(1),
    layer_id: z.string().min(1),
    category: z.string().min(1),
    preset_id: z.string().min(1).optional(),
    report_preset_id: z.string().min(1).optional(),
  })
  .strict();

export const GraphicHiddenEventSchema = z
  .object({
    ...usageEventBase,
    type: z.literal("graphic_hidden"),
    source: z.string().min(1),
    layer_id: z.string().min(1),
    /**
     * Removal cause. Mostly the GraphicsManager remove reason vocabulary
     * (remove_layer, preset_replace, preset_expired, manual,
     * clear_all_layers) plus recorder-owned "replaced" and "shutdown".
     */
    reason: z.string().min(1),
  })
  .strict();

export const CallStartedEventSchema = z
  .object({
    ...usageEventBase,
    type: z.literal("call_started"),
    call_id: z.string().min(1),
  })
  .strict();

export const CallEndedEventSchema = z
  .object({
    ...usageEventBase,
    type: z.literal("call_ended"),
    call_id: z.string().min(1),
    reason: z.enum(["clients_gone", "engine_stopped"]),
  })
  .strict();

export const UsageEventSchema = z.discriminatedUnion("type", [
  GraphicShownEventSchema,
  GraphicHiddenEventSchema,
  CallStartedEventSchema,
  CallEndedEventSchema,
]);

export type GraphicShownEventT = z.infer<typeof GraphicShownEventSchema>;
export type GraphicHiddenEventT = z.infer<typeof GraphicHiddenEventSchema>;
export type CallStartedEventT = z.infer<typeof CallStartedEventSchema>;
export type CallEndedEventT = z.infer<typeof CallEndedEventSchema>;
export type UsageEventT = z.infer<typeof UsageEventSchema>;

export type CallEndReasonT = CallEndedEventT["reason"];
