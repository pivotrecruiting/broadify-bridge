/**
 * SSOT aggregator for graphics schemas and inferred types.
 *
 * The schemas are split by concern (`output` and `layer/preset`) to keep
 * module size and change surface small while preserving existing imports.
 */
export {
  GRAPHICS_OUTPUT_CONFIG_VERSION,
  GraphicsOutputKeySchema,
  GraphicsFormatSchema,
  GraphicsRangeSchema,
  GraphicsColorspaceSchema,
  GraphicsTargetsSchema,
  GraphicsConfigureOutputsSchema,
  type GraphicsOutputKeyT,
  type GraphicsFormatT,
  type GraphicsRangeT,
  type GraphicsColorspaceT,
  type GraphicsTargetsT,
  type GraphicsOutputConfigT,
} from "./schemas/output-schemas.js";

export {
  GraphicsLayoutSchema,
  GraphicsAssetSchema,
  GraphicsBundleSchema,
  GraphicsBackgroundModeSchema,
  GraphicsCategorySchema,
  GraphicsSendSchema,
  GraphicsUpdateValuesSchema,
  GraphicsUpdateLayoutSchema,
  GraphicsRemoveSchema,
  GraphicsRemovePresetSchema,
  type GraphicsLayoutT,
  type GraphicsAssetT,
  type GraphicsBundleT,
  type GraphicsBackgroundModeT,
  type GraphicsCategoryT,
  type GraphicsSendPayloadT,
  type GraphicsUpdateValuesPayloadT,
  type GraphicsUpdateLayoutPayloadT,
  type GraphicsRemovePayloadT,
  type GraphicsRemovePresetPayloadT,
} from "./schemas/layer-schemas.js";
