import { z } from "zod";

export const GRAPHICS_OUTPUT_CONFIG_VERSION = 1;

const MAX_DURATION_MS = 60 * 60 * 1000;

export const GraphicsOutputKeySchema = z.enum([
  "stub",
  "key_fill_sdi",
  "key_fill_split_sdi",
  "key_fill_ndi",
  "video_sdi",
  "video_hdmi",
]);

export const GraphicsFormatSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
});

export const GraphicsRangeSchema = z
  .enum(["legal", "full"])
  .optional()
  .default("legal");

export const GraphicsColorspaceSchema = z
  .enum(["auto", "rec601", "rec709", "rec2020"])
  .optional()
  .default("auto");

export const GraphicsTargetsSchema = z
  .object({
    output1Id: z.string().min(1).optional(),
    output2Id: z.string().min(1).optional(),
    ndiStreamName: z.string().min(1).optional(),
  })
  .strict();

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

export const GraphicsLayoutSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    scale: z.number().finite().positive(),
  })
  .strict();

export const GraphicsAssetSchema = z
  .object({
    assetId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1),
    mime: z.string().min(1),
    data: z.string().optional(),
  })
  .strict();

export const GraphicsBundleSchema = z
  .object({
    manifest: z.record(z.unknown()),
    html: z.string().min(1),
    css: z.string().optional().default(""),
    schema: z.record(z.unknown()).optional().default({}),
    defaults: z.record(z.unknown()).optional().default({}),
    assets: z.array(GraphicsAssetSchema).optional().default([]),
  })
  .strict();

export const GraphicsBackgroundModeSchema = z.enum([
  "transparent",
  "green",
  "black",
  "white",
]);

export const GraphicsCategorySchema = z.enum([
  "lower-thirds",
  "overlays",
  "slides",
]);

export const GraphicsSendSchema = z
  .object({
    layerId: z.string().min(1),
    category: GraphicsCategorySchema,
    backgroundMode: GraphicsBackgroundModeSchema,
    layout: GraphicsLayoutSchema,
    zIndex: z.number().int(),
    bundle: GraphicsBundleSchema,
    values: z.record(z.unknown()).optional().default({}),
    presetId: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative().max(MAX_DURATION_MS).optional(),
  })
  .strict();

export const GraphicsUpdateValuesSchema = z
  .object({
    layerId: z.string().min(1),
    values: z.record(z.unknown()),
  })
  .strict();

export const GraphicsUpdateLayoutSchema = z
  .object({
    layerId: z.string().min(1),
    layout: GraphicsLayoutSchema,
    zIndex: z.number().int().optional(),
  })
  .strict();

export const GraphicsRemoveSchema = z
  .object({
    layerId: z.string().min(1),
  })
  .strict();

export const GraphicsRemovePresetSchema = z
  .object({
    presetId: z.string().min(1),
    clearQueue: z.boolean().optional(),
  })
  .strict();

export type GraphicsOutputKeyT = z.infer<typeof GraphicsOutputKeySchema>;
export type GraphicsFormatT = z.infer<typeof GraphicsFormatSchema>;
export type GraphicsRangeT = z.infer<typeof GraphicsRangeSchema>;
export type GraphicsColorspaceT = z.infer<typeof GraphicsColorspaceSchema>;
export type GraphicsTargetsT = z.infer<typeof GraphicsTargetsSchema>;
export type GraphicsOutputConfigT = z.infer<typeof GraphicsConfigureOutputsSchema>;
export type GraphicsLayoutT = z.infer<typeof GraphicsLayoutSchema>;
export type GraphicsAssetT = z.infer<typeof GraphicsAssetSchema>;
export type GraphicsBundleT = z.infer<typeof GraphicsBundleSchema>;
export type GraphicsBackgroundModeT = z.infer<typeof GraphicsBackgroundModeSchema>;
export type GraphicsCategoryT = z.infer<typeof GraphicsCategorySchema>;
export type GraphicsSendPayloadT = z.infer<typeof GraphicsSendSchema>;
export type GraphicsUpdateValuesPayloadT = z.infer<
  typeof GraphicsUpdateValuesSchema
>;
export type GraphicsUpdateLayoutPayloadT = z.infer<
  typeof GraphicsUpdateLayoutSchema
>;
export type GraphicsRemovePayloadT = z.infer<typeof GraphicsRemoveSchema>;
export type GraphicsRemovePresetPayloadT = z.infer<
  typeof GraphicsRemovePresetSchema
>;
