import { getBridgeContext } from "../bridge-context.js";
import type { GraphicsCategoryT } from "./graphics-schemas.js";
import type { GraphicsRenderer } from "./renderer/graphics-renderer.js";
import type { GraphicsLayerStateT, PreparedLayerT } from "./graphics-manager-types.js";

const MAX_ACTIVE_LAYERS = 3;

type RemoveLayerDepsT = {
  renderer: GraphicsRenderer;
  layers: Map<string, GraphicsLayerStateT>;
  categoryToLayer: Map<GraphicsCategoryT, string>;
};

type LayerStateDepsT = Pick<RemoveLayerDepsT, "layers" | "categoryToLayer">;

/**
 * Remove a layer from in-memory state only.
 *
 * @param deps Runtime dependencies.
 * @param layerId Layer identifier.
 * @returns Removed layer state or null if missing.
 */
export function removeLayerState(
  deps: LayerStateDepsT,
  layerId: string
): GraphicsLayerStateT | null {
  const layer = deps.layers.get(layerId) ?? null;
  deps.layers.delete(layerId);
  if (layer && deps.categoryToLayer.get(layer.category) === layerId) {
    deps.categoryToLayer.delete(layer.category);
  }
  return layer;
}

/**
 * Remove a layer from renderer and in-memory state.
 *
 * @param deps Runtime dependencies.
 * @param layerId Layer identifier.
 * @param reason Log reason tag.
 */
export async function removeLayerWithRenderer(
  deps: RemoveLayerDepsT,
  layerId: string,
  reason: string
): Promise<void> {
  try {
    await deps.renderer.removeLayer(layerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getBridgeContext().logger.warn(
      `[Graphics] Failed to remove layer ${layerId} (${reason}): ${message}`
    );
  }

  removeLayerState(deps, layerId);
}

/**
 * Validate that adding/updating a layer does not violate category and count limits.
 *
 * @param layers Active layers.
 * @param categoryToLayer Category lookup map.
 * @param layerId Candidate layer id.
 * @param category Candidate category.
 */
export function validateLayerLimits(
  layers: Map<string, GraphicsLayerStateT>,
  categoryToLayer: Map<GraphicsCategoryT, string>,
  layerId: string,
  category: GraphicsCategoryT
): void {
  const existingLayer = layers.get(layerId);
  const layerInCategory = categoryToLayer.get(category);
  if (layerInCategory && layerInCategory !== layerId) {
    throw new Error(`Layer already active for category ${category}`);
  }

  if (!existingLayer && layers.size >= MAX_ACTIVE_LAYERS) {
    throw new Error("Maximum active layers reached");
  }
}

type RenderPreparedLayerParamsT = {
  renderer: GraphicsRenderer;
  layers: Map<string, GraphicsLayerStateT>;
  categoryToLayer: Map<GraphicsCategoryT, string>;
  outputFormat: { width: number; height: number; fps: number } | null;
  data: PreparedLayerT;
  onRendered: (layerIds: string[]) => void;
};

type StorePreparedLayerStateParamsT = Omit<
  RenderPreparedLayerParamsT,
  "renderer" | "outputFormat" | "onRendered"
>;

/**
 * Store a prepared layer in the in-memory state without touching a renderer.
 *
 * @param params Layer state parameters.
 */
export function storePreparedLayerState(
  params: StorePreparedLayerStateParamsT
): void {
  validateLayerLimits(
    params.layers,
    params.categoryToLayer,
    params.data.layerId,
    params.data.category
  );

  const existing = params.layers.get(params.data.layerId);
  if (existing && existing.category !== params.data.category) {
    params.categoryToLayer.delete(existing.category);
  }

  params.layers.set(params.data.layerId, {
    layerId: params.data.layerId,
    category: params.data.category,
    layout: params.data.layout,
    zIndex: params.data.zIndex,
    backgroundMode: params.data.backgroundMode,
    values: params.data.values,
    bindings: params.data.bindings,
    schema: { ...(params.data.bundle.schema || {}) },
    defaults: { ...(params.data.bundle.defaults || {}) },
    presetId: params.data.presetId,
  });

  params.categoryToLayer.set(params.data.category, params.data.layerId);
}

/**
 * Store and render a prepared layer.
 *
 * @param params Render parameters and runtime dependencies.
 */
export async function renderPreparedLayer(params: RenderPreparedLayerParamsT): Promise<void> {
  storePreparedLayerState({
    layers: params.layers,
    categoryToLayer: params.categoryToLayer,
    data: params.data,
  });

  try {
    await params.renderer.renderLayer({
      layerId: params.data.layerId,
      html: params.data.bundle.html,
      css: params.data.bundle.css,
      values: params.data.values,
      bindings: params.data.bindings,
      layout: params.data.layout,
      backgroundMode: params.data.backgroundMode,
      width: params.outputFormat?.width ?? 1920,
      height: params.outputFormat?.height ?? 1080,
      fps: params.outputFormat?.fps ?? 50,
      zIndex: params.data.zIndex,
    });
    params.onRendered([params.data.layerId]);
  } catch (error) {
    removeLayerState(
      {
        layers: params.layers,
        categoryToLayer: params.categoryToLayer,
      },
      params.data.layerId
    );
    throw error;
  }
}

type ClearAllLayersParamsT = {
  renderer: GraphicsRenderer;
  layers: Map<string, GraphicsLayerStateT>;
  categoryToLayer: Map<GraphicsCategoryT, string>;
  clearActivePreset: () => void;
  publishStatus: (reason: string) => void;
};

/**
 * Remove all active layers and reset associated state.
 *
 * @param params Runtime dependencies.
 */
export async function clearAllLayers(params: ClearAllLayersParamsT): Promise<void> {
  const activeLayers = Array.from(params.layers.values());
  for (const layer of activeLayers) {
    await removeLayerWithRenderer(
      {
        renderer: params.renderer,
        layers: params.layers,
        categoryToLayer: params.categoryToLayer,
      },
      layer.layerId,
      "clear_all_layers"
    );
  }
  params.clearActivePreset();
  params.publishStatus("clear_all_layers");
}
