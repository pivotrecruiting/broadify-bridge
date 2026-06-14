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

export const MeetingKeyerConfigureSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.enum(["modnet", "vision_person_segmentation"]).optional(),
    background_mode: z
      .enum(["transparent", "gradient", "solid_light", "checkerboard"])
      .optional(),
    background_type: z.enum(["mode"]).optional(),
    background_template_id: z.string().nullable().optional(),
    background_template_name: z.string().nullable().optional(),
    quality_mode: z.enum(["fast", "balanced", "accurate"]).optional(),
    mask_erode_px: z.number().min(0).max(3).optional(),
    mask_dilate_px: z.number().int().min(0).max(8).optional(),
    mask_feather_px: z.number().int().min(0).max(3).optional(),
    dynamic_dilation: z.boolean().optional(),
    temporal_blend_enabled: z.boolean().optional(),
    fresh_mask_age_ms: z.number().min(0).max(500).optional(),
    max_mask_age_ms: z.number().min(0).max(2000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.fresh_mask_age_ms === undefined ||
      value.max_mask_age_ms === undefined ||
      value.fresh_mask_age_ms <= value.max_mask_age_ms,
    "fresh_mask_age_ms must be less than or equal to max_mask_age_ms",
  );

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
