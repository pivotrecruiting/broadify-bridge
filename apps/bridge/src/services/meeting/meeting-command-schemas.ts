import { z } from "zod";

/**
 * Zod schemas for meeting_* relay command payloads.
 *
 * Detailed value validation happens in the native helper; these schemas only
 * constrain the routing-relevant shape.
 */

export const MeetingEngineStartSchema = z
  .object({
    width: z.number().int().min(160).max(7680).optional(),
    height: z.number().int().min(120).max(4320).optional(),
    fps: z.number().int().min(1).max(240).optional(),
  })
  .strict();

export const MeetingPassthroughSchema = z.record(z.unknown());

export const MeetingProgramUpdateSchema = z.object({
  section: z.enum(["cornerbug", "graphics", "speaker_layout", "media_layer"]),
  values: z.record(z.unknown()),
});

export const MeetingButtonModeSchema = z.object({
  mode: z.enum(["meeting", "studio"]),
});

export const MeetingButtonTriggerSchema = z.object({
  mode: z.enum(["meeting", "studio"]),
  buttonId: z.string().trim().min(1).max(128),
});

export const MeetingOutputConfigureSchema = z.object({
  target: z.enum(["framebus", "virtual_camera"]),
  action: z.enum(["start", "stop", "configure"]),
  settings: z.record(z.unknown()).optional(),
});

export const MeetingGraphicsConfigureOutputsSchema = z
  .object({
    width: z.number().int().min(160).max(7680).optional(),
    height: z.number().int().min(120).max(4320).optional(),
    fps: z.number().int().min(1).max(240).optional(),
  })
  .strict();
