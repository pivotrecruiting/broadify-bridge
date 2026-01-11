import { z } from "zod";

export const GraphicsOutputKeySchema = z.enum([
  "stub",
  "key_fill_sdi",
  "key_fill_ndi",
  "video_sdi",
]);

export const GraphicsFormatSchema = z.object({
  width: z.literal(1920),
  height: z.literal(1080),
  fps: z.literal(50),
});

export const GraphicsTargetsSchema = z
  .object({
    output1Id: z.string().min(1).optional(),
    output2Id: z.string().min(1).optional(),
    ndiStreamName: z.string().min(1).optional(),
  })
  .strict();

export const GraphicsConfigureOutputsSchema = z
  .object({
    outputKey: GraphicsOutputKeySchema,
    targets: GraphicsTargetsSchema,
    format: GraphicsFormatSchema,
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

export type GraphicsOutputKeyT = z.infer<typeof GraphicsOutputKeySchema>;
export type GraphicsFormatT = z.infer<typeof GraphicsFormatSchema>;
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
