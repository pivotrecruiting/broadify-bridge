import { z } from "zod";

const MAX_DURATION_MS = 60 * 60 * 1000;

/**
 * Layout parameters for a layer.
 */
export const GraphicsLayoutSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    scale: z.number().finite().positive(),
  })
  .strict();

/**
 * Asset descriptor (data is optional for updates).
 */
export const GraphicsAssetSchema = z
  .object({
    assetId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1),
    mime: z.string().min(1),
    data: z.string().optional(),
  })
  .strict();

/**
 * Bundle containing HTML/CSS and schema/defaults metadata.
 */
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

/**
 * Supported background modes when alpha is not available.
 */
export const GraphicsBackgroundModeSchema = z.enum([
  "transparent",
  "green",
  "black",
  "white",
]);

/**
 * Layer categories (one active layer per category).
 */
export const GraphicsCategorySchema = z.enum([
  "lower-thirds",
  "overlays",
  "slides",
]);

/**
 * Payload for creating/updating a graphics layer.
 */
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

/**
 * Payload for updating layer values.
 */
export const GraphicsUpdateValuesSchema = z
  .object({
    layerId: z.string().min(1),
    values: z.record(z.unknown()),
  })
  .strict();

/**
 * Payload for updating layer layout.
 */
export const GraphicsUpdateLayoutSchema = z
  .object({
    layerId: z.string().min(1),
    layout: GraphicsLayoutSchema,
    zIndex: z.number().int().optional(),
  })
  .strict();

/**
 * Payload for removing a layer.
 */
export const GraphicsRemoveSchema = z
  .object({
    layerId: z.string().min(1),
  })
  .strict();

/**
 * Payload for removing a preset.
 */
export const GraphicsRemovePresetSchema = z
  .object({
    presetId: z.string().min(1),
  })
  .strict();

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
