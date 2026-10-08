import { z } from "zod";

/**
 * SessionEventLog contract, schema version 1.0.0.
 *
 * Mirrors the post-production contract `session_event_log` (single source:
 * broadify-postpro/postpro/contracts/models.py, exported as JSON Schema). One
 * JSON object per line in the local session log; snake_case keys like every
 * other cross-boundary payload. Timestamps are bridge wall-clock epoch ms;
 * the post-production worker aligns them to the recording file.
 */
export const SESSION_EVENT_SCHEMA_VERSION = "1.0.0" as const;

export const SessionEventTypeSchema = z.enum([
  "recording_started",
  "recording_stopped",
  "program_changed",
  "preview_changed",
  "keyer_on_air",
  "keyer_off_air",
  "overlay_on_air",
  "overlay_off_air",
  "streaming_started",
  "streaming_stopped",
  "graphic_shown",
  "graphic_hidden",
  "graphic_updated",
]);

export const SessionEventSchema = z
  .object({
    at_ms: z.number().int().nonnegative(),
    type: SessionEventTypeSchema,
    /** Producer: "atem" | "vmix" | "rodecaster" | "meeting" | "studio" | … */
    source: z.string().min(1),
    origin: z.enum(["live", "import"]).default("live"),
    me: z.number().int().nonnegative().nullable().optional(),
    input_id: z.string().nullable().optional(),
    input_name: z.string().nullable().optional(),
    keyer: z.string().nullable().optional(),
    graphic_id: z.string().nullable().optional(),
    template_id: z.string().nullable().optional(),
    fields: z.record(z.string(), z.string()).nullable().optional(),
    /** Switcher timecode if available (ATEM: recording duration hh:mm:ss:ff). */
    timecode: z.string().nullable().optional(),
  })
  .strict();

export type SessionEventT = z.infer<typeof SessionEventSchema>;
export type SessionEventInputT = z.input<typeof SessionEventSchema>;

/** First line of every session file: identifies the session. */
export const SessionHeaderSchema = z
  .object({
    schema_version: z.literal(SESSION_EVENT_SCHEMA_VERSION),
    session_id: z.string().min(1),
    bridge_id: z.string().nullable(),
    started_at_ms: z.number().int().nonnegative(),
    switcher: z.string().min(1),
  })
  .strict();

export type SessionHeaderT = z.infer<typeof SessionHeaderSchema>;

/** Switcher events emitted by engine adapters (optional capability). */
export type SwitcherEventT = Omit<SessionEventInputT, "at_ms" | "origin"> & {
  at_ms?: number;
};
