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
  getRenderer: () => GraphicsRenderer;
  layers: Map<string, GraphicsLayerStateT>;
  categoryToLayer: Map<GraphicsCategoryT, string>;
  getActivePreset: () => GraphicsActivePresetT | null;
  setActivePreset: (preset: GraphicsActivePresetT | null) => void;
  publishStatus: (reason: string) => void;
};

/**
 * Preset lifecycle manager.
 *
 * Handles timer state, preset replacement/removal, and preset-event publishing.
 */
export class GraphicsPresetService {
  constructor(private readonly deps: GraphicsPresetServiceDepsT) {}

  /**
   * Handle preset compatibility before rendering an incoming layer.
   *
   * @param presetId Incoming preset id.
   * @param category Incoming category.
   */
  async prepareBeforeRender(
    presetId: string | undefined,
    category: GraphicsCategoryT
  ): Promise<void> {
    const activePreset = this.deps.getActivePreset();
    if (presetId) {
      await this.removeLayersNotInPreset(presetId);
      const existingLayerId = this.deps.categoryToLayer.get(category);
      if (!existingLayerId) {
        return;
      }
      const existingLayer = this.deps.layers.get(existingLayerId);
      if (existingLayer?.presetId !== presetId) {
        return;
      }
      await removeLayerWithRenderer(
        {
          renderer: this.deps.getRenderer(),
          layers: this.deps.layers,
          categoryToLayer: this.deps.categoryToLayer,
        },
        existingLayerId,
        "preset_resend"
      );
      if (activePreset?.presetId === presetId) {
        activePreset.layerIds.delete(existingLayerId);
      }
      return;
    }

    if (activePreset) {
      await this.removePresetById(activePreset.presetId, "send_non_preset");
    }
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
      getBridgeContext().logger.info(`[Graphics] Preset activated: ${presetId}`);
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
      this.deps.publishStatus("preset_started");
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
    getBridgeContext().logger.info(
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
    reason: RemovePresetReasonT = "manual"
  ): Promise<void> {
    const layersToRemove = Array.from(this.deps.layers.values()).filter(
      (layer) => layer.presetId === presetId
    );
    const activePreset = this.deps.getActivePreset();
    const wasActive = activePreset?.presetId === presetId;

    for (const layer of layersToRemove) {
      await removeLayerWithRenderer(
        {
          renderer: this.deps.getRenderer(),
          layers: this.deps.layers,
          categoryToLayer: this.deps.categoryToLayer,
        },
        layer.layerId,
        "preset_remove"
      );
    }

    if (wasActive) {
      this.clearActivePreset();
    }

    if (layersToRemove.length > 0) {
      getBridgeContext().logger.info(
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

    await this.removePresetById(presetId, "expired");
    getBridgeContext().logger.info(`[Graphics] Preset expired: ${presetId}`);
  }

  private async removeLayersNotInPreset(presetId: string): Promise<void> {
    const layersToRemove = Array.from(this.deps.layers.values()).filter(
      (layer) => layer.presetId !== presetId
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

    for (const layer of layersToRemove) {
      await removeLayerWithRenderer(
        {
          renderer: this.deps.getRenderer(),
          layers: this.deps.layers,
          categoryToLayer: this.deps.categoryToLayer,
        },
        layer.layerId,
        "preset_replace"
      );
    }

    const activePreset = this.deps.getActivePreset();
    if (activePreset && activePreset.presetId !== presetId) {
      this.clearActivePreset();
    }

    if (layersToRemove.length > 0) {
      getBridgeContext().logger.info(
        `[Graphics] Preset replaced: ${JSON.stringify({
          newPresetId: presetId,
          removedPresets: Array.from(presetIds),
          removedNonPresetLayers: nonPresetCount,
          removedLayerCount: layersToRemove.length,
        })}`
      );
    }
  }
}
