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
    // Absolute local path of an uploaded company background image ("" clears).
    background_image_path: z.string().optional(),
    quality_mode: z.enum(["fast", "balanced", "accurate"]).optional(),
    performance_mode: z
      .enum(["high_quality", "quality", "balanced", "performance"])
      .optional(),
    mask_erode_px: z.number().min(0).max(3).optional(),
    mask_dilate_px: z.number().int().min(0).max(8).optional(),
    mask_feather_px: z.number().int().min(0).max(3).optional(),
    dynamic_dilation: z.boolean().optional(),
    temporal_blend_enabled: z.boolean().optional(),
    edge_stabilization_enabled: z.boolean().optional(),
    edge_stabilization_strength: z.number().min(0).max(1).optional(),
    fresh_mask_age_ms: z.number().min(0).max(500).optional(),
    max_mask_age_ms: z.number().min(0).max(2000).optional(),
    // Conference mode: never keys, and lets the native compositor draw content
    // over the un-keyed camera. Forwarded to the helper's keyer.configure.
    conference_mode: z.boolean().optional(),
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
  section: z.enum(["camera", "cornerbug", "graphics", "speaker_layout", "media_layer"]),
  values: z.record(z.unknown()),
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

// An absolute path (POSIX "/..." or Windows "X:\...") ending in .mp4, with no
// parent-directory traversal or NUL bytes. The native recorder deletes the
// target before writing, so this guards the relay boundary against a
// compromised client deleting/clobbering arbitrary files: only the honest
// meeting_recording_pick_path flow (or an equally well-formed path) is allowed.
const isSafeRecordingPath = (filePath: string): boolean => {
  if (filePath.includes("\0") || filePath.includes("..")) {
    return false;
  }
  if (!/\.mp4$/i.test(filePath)) {
    return false;
  }
  const isPosixAbsolute = filePath.startsWith("/");
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(filePath);
  return isPosixAbsolute || isWindowsAbsolute;
};

export const MeetingRecordingStartSchema = z
  .object({
    file_path: z
      .string()
      .min(1)
      .refine(isSafeRecordingPath, {
        message:
          "file_path must be an absolute .mp4 path without parent traversal",
      }),
    mic_device_id: z.string().optional(),
  })
  .strict();

export const MeetingCallControlSchema = z.object({
  platform: z.enum(["teams", "zoom"]),
  action: z.enum(["mic_toggle", "speaker_toggle", "hangup"]),
});

export const ConferenceDisplayStartSchema = z.object({
  match_name: z.string().max(128).optional(),
  match_width: z.number().int().positive().max(16384).optional(),
  match_height: z.number().int().positive().max(16384).optional(),
});
