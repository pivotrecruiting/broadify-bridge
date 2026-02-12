import { z } from "zod";

/**
 * Current version of the graphics output configuration schema.
 */
export const GRAPHICS_OUTPUT_CONFIG_VERSION = 1;

/**
 * Supported output modes for graphics rendering.
 */
export const GraphicsOutputKeySchema = z.enum([
  "stub",
  "key_fill_sdi",
  "key_fill_ndi",
  "video_sdi",
  "video_hdmi",
]);

/**
 * Target render format (size + frame rate).
 */
export const GraphicsFormatSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
});

/**
 * SDI/HDMI range (legal/full).
 */
export const GraphicsRangeSchema = z
  .enum(["legal", "full"])
  .optional()
  .default("legal");

/**
 * Output colorspace selection.
 */
export const GraphicsColorspaceSchema = z
  .enum(["auto", "rec601", "rec709", "rec2020"])
  .optional()
  .default("auto");

/**
 * Output target identifiers (ports or NDI stream).
 */
export const GraphicsTargetsSchema = z
  .object({
    output1Id: z.string().min(1).optional(),
    output2Id: z.string().min(1).optional(),
    ndiStreamName: z.string().min(1).optional(),
  })
  .strict();

/**
 * Output configuration payload.
 */
export const GraphicsConfigureOutputsSchema = z
  .object({
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .default(GRAPHICS_OUTPUT_CONFIG_VERSION),
    outputKey: GraphicsOutputKeySchema,
    targets: GraphicsTargetsSchema,
    format: GraphicsFormatSchema,
    range: GraphicsRangeSchema,
    colorspace: GraphicsColorspaceSchema,
  })
  .strict();

export type GraphicsOutputKeyT = z.infer<typeof GraphicsOutputKeySchema>;
export type GraphicsFormatT = z.infer<typeof GraphicsFormatSchema>;
export type GraphicsRangeT = z.infer<typeof GraphicsRangeSchema>;
export type GraphicsColorspaceT = z.infer<typeof GraphicsColorspaceSchema>;
export type GraphicsTargetsT = z.infer<typeof GraphicsTargetsSchema>;
export type GraphicsOutputConfigT = z.infer<typeof GraphicsConfigureOutputsSchema>;
