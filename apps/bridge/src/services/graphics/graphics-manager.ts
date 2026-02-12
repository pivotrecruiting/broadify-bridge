import type {
  GraphicsCategoryT,
  GraphicsOutputConfigT,
  GraphicsSendPayloadT,
} from "./graphics-schemas.js";
import {
  GraphicsConfigureOutputsSchema,
  GraphicsSendSchema,
  GraphicsUpdateLayoutSchema,
  GraphicsUpdateValuesSchema,
  GraphicsRemoveSchema,
  GraphicsRemovePresetSchema,
  GRAPHICS_OUTPUT_CONFIG_VERSION,
} from "./graphics-schemas.js";
import { outputConfigStore } from "./output-config-store.js";
import { StubOutputAdapter } from "./output-adapters/stub-output-adapter.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import { getBridgeContext } from "../bridge-context.js";
import { isDevelopmentMode } from "../dev-mode.js";
import { ElectronRendererClient } from "./renderer/electron-renderer-client.js";
import { StubRenderer } from "./renderer/stub-renderer.js";
import type {
  GraphicsRenderer,
  GraphicsRendererConfigT,
} from "./renderer/graphics-renderer.js";
import { deriveTemplateBindings } from "./template-bindings.js";
import { createTestPatternPayload } from "./test-pattern.js";
import { type FrameBusConfigT } from "./framebus/framebus-config.js";
import { selectOutputAdapter } from "./graphics-output-adapter-factory.js";
import {
  validateOutputFormat,
  validateOutputTargets,
} from "./graphics-output-validation-service.js";
import {
  GraphicsError,
  type GraphicsErrorCodeT,
} from "./graphics-errors.js";
import type {
  GraphicsActivePresetT,
  GraphicsLayerStateT,
  GraphicsStatusSnapshotT,
} from "./graphics-manager-types.js";
import {
  clearAllLayers,
  removeLayerWithRenderer,
  renderPreparedLayer,
} from "./graphics-layer-service.js";
import {
  publishGraphicsErrorEvent,
  publishGraphicsStatusEvent,
} from "./graphics-event-publisher.js";
import { GraphicsPresetService } from "./graphics-preset-service.js";
import {
  GraphicsOutputTransitionError,
  GraphicsOutputTransitionService,
} from "./graphics-output-transition-service.js";
import { prepareLayerForRender } from "./graphics-layer-prepare-service.js";
import {
  summarizeRawPayload,
  summarizeSendPayload,
} from "./graphics-payload-diagnostics.js";
import { GraphicsRuntimeInitService } from "./graphics-runtime-init-service.js";
import {
  applyFrameBusSessionConfig,
  logFrameBusConfigChange,
  resolveFrameBusConfig,
} from "./graphics-framebus-session-service.js";

/**
 * Graphics manager orchestrates layers, rendering, and output.
 * Legacy frame compositing/ticker paths were removed; renderer + helpers operate on FrameBus.
 */
export class GraphicsManager {
  private renderer: GraphicsRenderer;
  private outputAdapter: GraphicsOutputAdapter;
  private initialized = false;
  private layers = new Map<string, GraphicsLayerStateT>();
  private categoryToLayer = new Map<GraphicsCategoryT, string>();
  private outputConfig: GraphicsOutputConfigT | null = null;
  private activePreset: GraphicsActivePresetT | null = null;
  private frameBusConfig: FrameBusConfigT | null = null;
  private presetService: GraphicsPresetService;
  private outputTransitionService: GraphicsOutputTransitionService;
  private runtimeInitService: GraphicsRuntimeInitService;

  constructor() {
    this.renderer = this.selectRenderer();
    this.outputAdapter = new StubOutputAdapter();
    this.presetService = new GraphicsPresetService({
      getRenderer: () => this.renderer,
      layers: this.layers,
      categoryToLayer: this.categoryToLayer,
      getActivePreset: () => this.activePreset,
      setActivePreset: (preset) => {
        this.activePreset = preset;
      },
      publishStatus: (reason) => {
        publishGraphicsStatusEvent(reason, this.getStatusSnapshot());
      },
    });
    this.outputTransitionService = new GraphicsOutputTransitionService({
      getRenderer: () => this.renderer,
      getRuntime: () => ({
        outputConfig: this.outputConfig,
        frameBusConfig: this.frameBusConfig,
        outputAdapter: this.outputAdapter,
      }),
      setRuntime: (runtime) => {
        this.outputConfig = runtime.outputConfig;
        this.frameBusConfig = runtime.frameBusConfig;
        this.outputAdapter = runtime.outputAdapter;
      },
      selectOutputAdapter,
      persistConfig: (config) => outputConfigStore.setConfig(config),
      clearPersistedConfig: () => outputConfigStore.clear(),
      resolveFrameBusConfig,
      buildRendererConfig: (config, frameBusConfig) =>
        this.buildRendererConfig(config, frameBusConfig),
      logFrameBusConfigChange,
    });
    this.runtimeInitService = new GraphicsRuntimeInitService({
      getRenderer: () => this.renderer,
      setRenderer: (renderer) => {
        this.renderer = renderer;
      },
      setOutputAdapter: (adapter) => {
        this.outputAdapter = adapter;
      },
      setOutputConfig: (config) => {
        this.outputConfig = config;
      },
      createStubRenderer: () => new StubRenderer(),
      createStubOutputAdapter: () => new StubOutputAdapter(),
      selectOutputAdapter,
      applyFrameBusConfig: (config) => {
        this.frameBusConfig = applyFrameBusSessionConfig(
          config,
          this.frameBusConfig
        );
      },
      buildRendererConfig: (config) => this.buildRendererConfig(config),
      publishGraphicsError: (code, message) =>
        publishGraphicsErrorEvent(code, message),
    });
  }

  /**
   * Initialize renderer, assets, and persisted output config.
   *
   * @returns Promise resolved when initialization completes.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.runtimeInitService.initialize();

    this.initialized = true;
  }

  /**
   * Configure graphics outputs.
   *
   * @param payload Untrusted output configuration payload.
   * @returns Promise resolved when outputs are configured.
   */
  async configureOutputs(payload: unknown): Promise<void> {
    await this.initialize();
    let config: GraphicsOutputConfigT;
    try {
      config = GraphicsConfigureOutputsSchema.parse(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failGraphics("output_config_error", message);
    }
    if (config.version > GRAPHICS_OUTPUT_CONFIG_VERSION) {
      this.failGraphics(
        "output_config_error",
        `Unsupported graphics output config version: ${config.version}`
      );
    }
    const devMode = isDevelopmentMode();
    if (devMode) {
      getBridgeContext().logger.warn(
        "[Graphics] DEVELOPMENT mode enabled: skipping output validation and using stub output adapter"
      );
    } else {
      try {
        await validateOutputTargets(config.outputKey, config.targets);
        await validateOutputFormat(
          config.outputKey,
          config.targets,
          config.format
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.failGraphics("output_config_error", message);
      }
    }
    try {
      await this.outputTransitionService.runAtomicTransition(config);
    } catch (error) {
      if (error instanceof GraphicsOutputTransitionError) {
        const code =
          error.stage === "renderer_configure"
            ? "renderer_error"
            : error.stage === "persist"
              ? "output_config_error"
              : "output_helper_error";
        this.failGraphics(code, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.failGraphics("output_config_error", message);
    }
  }

  /**
   * Shutdown graphics renderer and output resources.
   *
   * @returns Promise resolved once resources are released.
   */
  async shutdown(): Promise<void> {
    this.presetService.clearActivePreset();
    this.layers.clear();
    this.categoryToLayer.clear();
    this.outputConfig = null;

    try {
      await this.outputAdapter.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Graphics] Output adapter stop failed during shutdown: ${message}`
      );
    }

    try {
      await this.renderer.shutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Graphics] Renderer shutdown failed: ${message}`
      );
    }

    this.initialized = false;
  }

  /**
   * Create or update a graphics layer.
   *
   * @param payload Untrusted graphics layer payload.
   * @returns Promise resolved when the layer is scheduled for render.
   */
  async sendLayer(payload: unknown): Promise<void> {
    await this.initialize();
    await this.waitForOutputTransition();

    if (!this.outputConfig) {
      throw new Error("Outputs not configured");
    }

    let data: GraphicsSendPayloadT;
    try {
      data = GraphicsSendSchema.parse(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.error(
        `[Graphics] graphics_send payload rejected (schema): ${message} ${JSON.stringify({
          error: message,
          payload: summarizeRawPayload(payload),
          outputConfig: this.outputConfig,
        })}`
      );
      throw error;
    }

    getBridgeContext().logger.info(
      `[Graphics] graphics_send payload ${JSON.stringify({
        payload: summarizeSendPayload(data),
        outputConfig: this.outputConfig,
      })}`
    );

    if (typeof data.durationMs === "number" && !data.presetId) {
      throw new Error("Preset ID is required when durationMs is set");
    }

    const renderInfo = data.bundle.manifest?.render as
      | { width?: number; height?: number; fps?: number }
      | undefined;

    if (renderInfo) {
      if (
        (typeof renderInfo.width === "number" &&
          renderInfo.width !== this.outputConfig.format.width) ||
        (typeof renderInfo.height === "number" &&
          renderInfo.height !== this.outputConfig.format.height) ||
        (typeof renderInfo.fps === "number" &&
          renderInfo.fps !== this.outputConfig.format.fps)
      ) {
        getBridgeContext().logger.warn(
          `[Graphics] Bundle manifest render format mismatch ${JSON.stringify({
            renderInfo,
            outputFormat: this.outputConfig.format,
            layerId: data.layerId,
            category: data.category,
            presetId: data.presetId ?? null,
          })}`
        );
      }
    }

    const normalizedRender = {
      ...(renderInfo && typeof renderInfo === "object"
        ? (renderInfo as Record<string, unknown>)
        : {}),
      width: this.outputConfig.format.width,
      height: this.outputConfig.format.height,
      fps: this.outputConfig.format.fps,
    };
    const normalizedData: GraphicsSendPayloadT = {
      ...data,
      bundle: {
        ...data.bundle,
        manifest: {
          ...data.bundle.manifest,
          render: normalizedRender,
        },
      },
    };

    const prepared = await prepareLayerForRender(
      normalizedData,
      this.outputConfig.outputKey,
      this.renderer
    );
    const durationMs = typeof data.durationMs === "number" ? data.durationMs : null;
    await this.presetService.prepareBeforeRender(
      prepared.presetId,
      prepared.category
    );

    let renderedLayerIds: string[] = [];
    await renderPreparedLayer({
      renderer: this.renderer,
      layers: this.layers,
      categoryToLayer: this.categoryToLayer,
      outputFormat: this.outputConfig?.format ?? null,
      data: prepared,
      onRendered: (layerIds) => {
        renderedLayerIds = layerIds;
      },
    });

    this.presetService.syncAfterRender(
      prepared.layerId,
      prepared.presetId,
      durationMs
    );
    this.presetService.maybeStartPresetTimers(
      renderedLayerIds.length > 0 ? renderedLayerIds : [prepared.layerId]
    );
  }

  /**
   * Update values for an existing layer.
   *
   * @param payload Untrusted update payload.
   * @returns Promise resolved after values are applied.
   */
  async updateValues(payload: unknown): Promise<void> {
    await this.initialize();
    await this.waitForOutputTransition();

    const data = GraphicsUpdateValuesSchema.parse(payload);
    const layer = this.layers.get(data.layerId);
    if (!layer) {
      throw new Error("Layer not found");
    }

    layer.values = { ...layer.values, ...data.values };
    layer.bindings = deriveTemplateBindings(
      {
        schema: layer.schema,
        defaults: layer.defaults,
      },
      layer.values
    );
    await this.renderer.updateValues(data.layerId, layer.values, layer.bindings);
  }

  /**
   * Update layout for an existing layer.
   *
   * @param payload Untrusted update payload.
   * @returns Promise resolved after layout is applied.
   */
  async updateLayout(payload: unknown): Promise<void> {
    await this.initialize();
    await this.waitForOutputTransition();

    const data = GraphicsUpdateLayoutSchema.parse(payload);
    const layer = this.layers.get(data.layerId);
    if (!layer) {
      throw new Error("Layer not found");
    }

    layer.layout = data.layout;
    if (typeof data.zIndex === "number") {
      layer.zIndex = data.zIndex;
    }

    await this.renderer.updateLayout(data.layerId, data.layout, data.zIndex);
  }

  /**
   * Remove a layer.
   *
   * @param payload Untrusted remove payload.
   * @returns Promise resolved after layer removal.
   */
  async removeLayer(payload: unknown): Promise<void> {
    await this.initialize();
    await this.waitForOutputTransition();

    const data = GraphicsRemoveSchema.parse(payload);
    const layer = this.layers.get(data.layerId);
    if (!layer) {
      return;
    }

    await removeLayerWithRenderer(
      {
        renderer: this.renderer,
        layers: this.layers,
        categoryToLayer: this.categoryToLayer,
      },
      data.layerId,
      "remove_layer"
    );
    this.presetService.handleLayerRemoved(layer);
  }

  /**
   * Remove a preset.
   *
   * @param payload Untrusted preset removal payload.
   * @returns Promise resolved after preset removal.
   */
  async removePreset(payload: unknown): Promise<void> {
    await this.initialize();
    await this.waitForOutputTransition();

    const data = GraphicsRemovePresetSchema.parse(payload);
    await this.presetService.removePresetById(data.presetId, "manual");
  }

  /**
   * Render the built-in test pattern, replacing any active layers.
   *
   * @returns Promise resolved after test pattern is sent.
   */
  async sendTestPattern(): Promise<void> {
    await this.initialize();
    await this.waitForOutputTransition();
    await clearAllLayers({
      renderer: this.renderer,
      layers: this.layers,
      categoryToLayer: this.categoryToLayer,
      clearActivePreset: () => this.presetService.clearActivePreset(),
      publishStatus: (reason) =>
        publishGraphicsStatusEvent(reason, this.getStatusSnapshot()),
    });
    await this.sendLayer(createTestPatternPayload());
  }

  /**
   * List output config and active layers.
   *
   * @returns Snapshot of output configuration and layer state.
   */
  getStatus(): {
    outputConfig: GraphicsOutputConfigT | null;
    layers: unknown[];
    activePreset: {
      presetId: string;
      durationMs: number | null;
      startedAt: number | null;
      expiresAt: number | null;
      pendingStart: boolean;
      layerIds: string[];
      categories?: GraphicsCategoryT[];
    } | null;
    activePresets: Array<{
      presetId: string;
      durationMs: number | null;
      startedAt: number | null;
      expiresAt: number | null;
      pendingStart: boolean;
      layerIds: string[];
      categories?: GraphicsCategoryT[];
    }>;
  } {
    const layers = Array.from(this.layers.values()).map((layer) => ({
      layerId: layer.layerId,
      category: layer.category,
      layout: layer.layout,
      zIndex: layer.zIndex,
      presetId: layer.presetId,
    }));
    const status = this.getStatusSnapshot();

    return {
      outputConfig: this.outputConfig,
      layers,
      activePreset: status.activePreset,
      activePresets: status.activePresets,
    };
  }

  private getStatusSnapshot(): GraphicsStatusSnapshotT {
    const activePreset = this.activePreset
      ? (() => {
          const categories = new Set<GraphicsCategoryT>();
          this.activePreset?.layerIds.forEach((layerId) => {
            const layer = this.layers.get(layerId);
            if (layer?.category) {
              categories.add(layer.category);
            }
          });
          return {
            presetId: this.activePreset.presetId,
            durationMs: this.activePreset.durationMs,
            startedAt: this.activePreset.startedAt,
            expiresAt: this.activePreset.expiresAt,
            pendingStart: this.activePreset.pendingStart,
            layerIds: Array.from(this.activePreset.layerIds),
            categories: Array.from(categories),
          };
        })()
      : null;

    return {
      outputConfig: this.outputConfig,
      activePreset,
      activePresets: activePreset ? [activePreset] : [],
    };
  }

  private async waitForOutputTransition(): Promise<void> {
    await this.outputTransitionService.waitForTransition();
  }

  private selectRenderer(): GraphicsRenderer {
    if (process.env.BRIDGE_GRAPHICS_RENDERER === "stub") {
      return new StubRenderer();
    }

    return new ElectronRendererClient();
  }

  private buildRendererConfig(
    config: GraphicsOutputConfigT,
    frameBusConfig: FrameBusConfigT | null = this.frameBusConfig
  ): GraphicsRendererConfigT {
    return {
      width: config.format.width,
      height: config.format.height,
      fps: config.format.fps,
      pixelFormat: frameBusConfig?.pixelFormat ?? 1,
      framebusName: frameBusConfig?.name ?? "",
      framebusSize: frameBusConfig?.size ?? 0,
      backgroundMode: "transparent",
    };
  }

  private failGraphics(code: GraphicsErrorCodeT, message: string): never {
    publishGraphicsErrorEvent(code, message);
    throw new GraphicsError(code, message);
  }
}

export const graphicsManager = new GraphicsManager();
