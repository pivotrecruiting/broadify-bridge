import { getBridgeContext } from "../bridge-context.js";
import type { GraphicsCategoryT } from "./graphics-schemas.js";
import type {
  GraphicsActivePresetT,
  GraphicsLayerStateT,
} from "./graphics-manager-types.js";
import type { GraphicsRenderer } from "./renderer/graphics-renderer.js";
import { removeLayerWithRenderer } from "./graphics-layer-service.js";
import {
  clearPresetDuration,
  clearPresetTimer,
  maybeStartPresetTimer,
  setPresetDurationPending,
} from "./graphics-preset-timer.js";

type RemovePresetReasonT =
  | "manual"
  | "expired"
  | "replace"
  | "send_non_preset";

type GraphicsPresetServiceDepsT = {
  layers: Map<string, GraphicsLayerStateT>;
  categoryToLayer: Map<GraphicsCategoryT, string>;
  getActivePreset: () => GraphicsActivePresetT | null;
  setActivePreset: (preset: GraphicsActivePresetT | null) => void;
  publishStatus: (reason: string) => void;
  removeLayer?: (layerId: string, reason: string) => Promise<void>;
  getRenderer?: () => GraphicsRenderer;
};

const isBackgroundCategory = (category: GraphicsCategoryT): boolean =>
  category === "backgrounds";

const isSameReplaceGroup = (
  existingCategory: GraphicsCategoryT,
  incomingCategory: GraphicsCategoryT
): boolean =>
  isBackgroundCategory(existingCategory) ===
  isBackgroundCategory(incomingCategory);

/**
 * Preset lifecycle manager.
 *
 * Handles timer state, preset replacement/removal, and preset-event publishing.
 */
export class GraphicsPresetService {
  constructor(private readonly deps: GraphicsPresetServiceDepsT) {}

  private async removeLayer(layerId: string, reason: string): Promise<void> {
    if (this.deps.removeLayer) {
      await this.deps.removeLayer(layerId, reason);
      return;
    }

    if (!this.deps.getRenderer) {
      throw new Error("GraphicsPresetService requires removeLayer or getRenderer");
    }

    await removeLayerWithRenderer(
      {
        renderer: this.deps.getRenderer(),
        layers: this.deps.layers,
        categoryToLayer: this.deps.categoryToLayer,
      },
      layerId,
      reason
    );
  }

  /**
   * Handle preset compatibility before rendering an incoming layer.
   *
   * @param presetId Incoming preset id.
   * @param category Incoming category.
   */
  async prepareBeforeRender(
    presetId: string | undefined,
    category: GraphicsCategoryT,
    incomingLayerId?: string
  ): Promise<{ deferredLayerIds: string[] }> {
    const activePreset = this.deps.getActivePreset();
    if (presetId) {
      // The layer the incoming send is about to render is NOT torn down: the
      // renderer replaces a layer with the same id in place, so removing it
      // first only put a remove->create cycle on air - the graphic dropped to
      // the idle frame and re-entered through its enter animation. Field
      // recording: "full -> shimmer -> full -> out" on every preset switch.
      const deferredLayerIds = await this.removeLayersNotInPreset(
        presetId,
        category,
        incomingLayerId
      );
      const existingLayerId = this.deps.categoryToLayer.get(category);
      if (!existingLayerId || existingLayerId === incomingLayerId) {
        return { deferredLayerIds };
      }
      const existingLayer = this.deps.layers.get(existingLayerId);
      if (existingLayer?.presetId !== presetId) {
        return { deferredLayerIds };
      }
      await this.removeLayer(existingLayerId, "preset_resend");
      if (activePreset?.presetId === presetId) {
        activePreset.layerIds.delete(existingLayerId);
      }
      return { deferredLayerIds };
    }

    if (activePreset) {
      const deferredLayerIds = await this.removePresetLayersDeferred(
        activePreset,
        category,
        incomingLayerId
      );
      return { deferredLayerIds };
    }
    return { deferredLayerIds: [] };
  }

  /**
   * Tear down an active preset for a non-preset send, deferring layers in
   * OTHER categories so the caller can remove them after the new layer is
   * live (see removeLayersNotInPreset for the rationale).
   *
   * @param activePreset Active preset being replaced.
   * @param incomingCategory Category of the incoming layer.
   * @param incomingLayerId Layer id the incoming send will render.
   * @returns Layer ids the caller must remove after rendering.
   */
  private async removePresetLayersDeferred(
    activePreset: GraphicsActivePresetT,
    incomingCategory: GraphicsCategoryT,
    incomingLayerId?: string
  ): Promise<string[]> {
    const presetLayers = Array.from(this.deps.layers.values()).filter(
      (layer) =>
        layer.presetId === activePreset.presetId &&
        layer.layerId !== incomingLayerId
    );
    const deferred: string[] = [];
    for (const layer of presetLayers) {
      if (layer.category === incomingCategory) {
        // Same category: the layer state store allows only one layer per
        // category, so this one must go before the render.
        await this.removeLayer(layer.layerId, "preset_remove");
      } else {
        deferred.push(layer.layerId);
      }
    }
    this.clearActivePreset();
    this.deps.publishStatus("preset_removed");
    return deferred;
  }

  /**
   * Sync active preset state after a layer was rendered.
   *
   * @param layerId Rendered layer id.
   * @param presetId Optional preset id.
   * @param durationMs Optional duration.
   */
  syncAfterRender(
    layerId: string,
    presetId: string | undefined,
    durationMs: number | null
  ): void {
    if (!presetId) {
      return;
    }

    const hasDuration = durationMs !== null;
    let activePreset = this.deps.getActivePreset();
    const isNewPreset = !activePreset || activePreset.presetId !== presetId;
    let shouldPublishPreset = false;

    if (isNewPreset) {
      if (activePreset) {
        clearPresetTimer(activePreset);
      }
      activePreset = {
        presetId,
        durationMs: durationMs ?? null,
        layerIds: new Set([layerId]),
        pendingStart: Boolean(durationMs && durationMs > 0),
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      this.deps.setActivePreset(activePreset);
      getBridgeContext().logger.debug?.(
        `[Graphics] Preset activated: ${presetId}`
      );
      shouldPublishPreset = true;
    } else if (activePreset) {
      activePreset.layerIds.add(layerId);
      shouldPublishPreset = true;
    }

    if (hasDuration && activePreset) {
      if (durationMs > 0) {
        const durationChanged = activePreset.durationMs !== durationMs;
        const timerStateMissing =
          activePreset.startedAt === null &&
          activePreset.expiresAt === null &&
          activePreset.timer === null &&
          !activePreset.pendingStart;

        if (durationChanged || timerStateMissing) {
          setPresetDurationPending(activePreset, durationMs);
          shouldPublishPreset = true;
        }
      } else {
        const hasTimerState =
          activePreset.durationMs !== null ||
          activePreset.pendingStart ||
          activePreset.timer !== null ||
          activePreset.startedAt !== null ||
          activePreset.expiresAt !== null;
        if (hasTimerState) {
          clearPresetDuration(activePreset);
          shouldPublishPreset = true;
        }
      }
    }

    if (shouldPublishPreset) {
      this.deps.publishStatus("preset_update");
    }
  }

  /**
   * Start pending preset timer once required layers are rendered.
   *
   * @param layerIds Rendered layer ids.
   */
  maybeStartPresetTimers(layerIds: string[]): void {
    const activePreset = this.deps.getActivePreset();
    if (!activePreset) {
      return;
    }

    const started = maybeStartPresetTimer({
      preset: activePreset,
      renderedLayerIds: layerIds,
      onExpire: (presetId) => {
        void this.expireActivePreset(presetId);
      },
    });
    if (started) {
      getBridgeContext().logger.debug?.(
        `[Graphics] Preset timer started: ${JSON.stringify({
          presetId: activePreset.presetId,
          durationMs: activePreset.durationMs,
          layerIds: Array.from(activePreset.layerIds),
          renderedLayerIds: layerIds,
          startedAt: activePreset.startedAt,
          expiresAt: activePreset.expiresAt,
        })}`
      );
      this.deps.publishStatus("preset_started");
      return;
    }

    if (activePreset.pendingStart) {
      getBridgeContext().logger.warn(
        `[Graphics] Preset timer pending (start deferred): ${JSON.stringify({
          presetId: activePreset.presetId,
          durationMs: activePreset.durationMs,
          layerIds: Array.from(activePreset.layerIds),
          renderedLayerIds: layerIds,
        })}`
      );
    }
  }

  /**
   * Clear active preset including timer state.
   */
  clearActivePreset(): void {
    clearPresetTimer(this.deps.getActivePreset());
    this.deps.setActivePreset(null);
  }

  /**
   * Handle layer removal side effects for active preset state.
   *
   * @param layer Removed layer.
   */
  handleLayerRemoved(layer: GraphicsLayerStateT): void {
    const activePreset = this.deps.getActivePreset();
    if (!layer.presetId || !activePreset || activePreset.presetId !== layer.presetId) {
      return;
    }
    activePreset.layerIds.delete(layer.layerId);
    if (activePreset.layerIds.size > 0) {
      return;
    }

    const clearedPresetId = activePreset.presetId;
    this.clearActivePreset();
    getBridgeContext().logger.debug?.(
      `[Graphics] Preset cleared via layer remove: ${clearedPresetId}`
    );
    this.deps.publishStatus("preset_cleared");
  }

  /**
   * Remove all layers that belong to a preset.
   *
   * @param presetId Preset id.
   * @param reason Removal reason.
   */
  async removePresetById(
    presetId: string,
    reason: RemovePresetReasonT = "manual",
    excludeLayerId?: string
  ): Promise<void> {
    const layersToRemove = Array.from(this.deps.layers.values()).filter(
      (layer) =>
        layer.presetId === presetId && layer.layerId !== excludeLayerId
    );
    const activePreset = this.deps.getActivePreset();
    const wasActive = activePreset?.presetId === presetId;

    for (const layer of layersToRemove) {
      await this.removeLayer(layer.layerId, "preset_remove");
    }

    if (wasActive) {
      this.clearActivePreset();
    }

    if (layersToRemove.length > 0) {
      getBridgeContext().logger.debug?.(
        `[Graphics] Preset removed: ${JSON.stringify({
          presetId,
          reason,
          removedLayerCount: layersToRemove.length,
        })}`
      );
    }

    if (layersToRemove.length > 0 || wasActive) {
      this.deps.publishStatus("preset_removed");
    }
  }

  private async expireActivePreset(presetId: string): Promise<void> {
    const activePreset = this.deps.getActivePreset();
    if (!activePreset || activePreset.presetId !== presetId) {
      return;
    }

    getBridgeContext().logger.debug?.(
      `[Graphics] Expiring preset: ${JSON.stringify({
        presetId,
        durationMs: activePreset.durationMs,
        layerIds: Array.from(activePreset.layerIds),
        startedAt: activePreset.startedAt,
        expiresAt: activePreset.expiresAt,
      })}`
    );
    await this.removePresetById(presetId, "expired");
    getBridgeContext().logger.debug?.(
      `[Graphics] Preset expired: ${presetId}`
    );
  }

  private async removeLayersNotInPreset(
    presetId: string,
    incomingCategory: GraphicsCategoryT,
    excludeLayerId?: string
  ): Promise<string[]> {
    const layersToRemove = Array.from(this.deps.layers.values()).filter(
      (layer) =>
        layer.presetId !== presetId &&
        layer.layerId !== excludeLayerId &&
        isSameReplaceGroup(layer.category, incomingCategory)
    );
    // A layer in ANOTHER category does not conflict with the incoming render,
    // so its removal is DEFERRED until the new layer is live. Removing it
    // first dropped the output to the idle frame between two graphics - the
    // remaining field flicker after the same-id fix was exactly the
    // cross-category preset switch (overlay <-> lower third).
    const deferredLayerIds = layersToRemove
      .filter((layer) => layer.category !== incomingCategory)
      .map((layer) => layer.layerId);
    const immediateRemovals = layersToRemove.filter(
      (layer) => layer.category === incomingCategory
    );
    const presetIds = new Set<string>();
    let nonPresetCount = 0;

    for (const layer of layersToRemove) {
      if (layer.presetId) {
        presetIds.add(layer.presetId);
      } else {
        nonPresetCount += 1;
      }
    }

    for (const layer of immediateRemovals) {
      await this.removeLayer(layer.layerId, "preset_replace");
    }

    const activePreset = this.deps.getActivePreset();
    if (activePreset && activePreset.presetId !== presetId) {
      this.clearActivePreset();
    }

    if (layersToRemove.length > 0) {
      getBridgeContext().logger.debug?.(
        `[Graphics] Preset replaced: ${JSON.stringify({
          newPresetId: presetId,
          removedPresets: Array.from(presetIds),
          removedNonPresetLayers: nonPresetCount,
          removedLayerCount: layersToRemove.length,
          deferredLayerCount: deferredLayerIds.length,
        })}`
      );
    }
    return deferredLayerIds;
  }
}
