import { assetRegistry } from "./asset-registry.js";
import type {
  GraphicsBackgroundModeT,
  GraphicsCategoryT,
  GraphicsLayoutT,
  GraphicsOutputConfigT,
  GraphicsOutputKeyT,
  GraphicsTargetsT,
  GraphicsSendPayloadT,
} from "./graphics-schemas.js";
import type { DeviceDescriptorT } from "@broadify/protocol";
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
import { sanitizeTemplateCss, validateTemplate } from "./template-sanitizer.js";
import { StubOutputAdapter } from "./output-adapters/stub-output-adapter.js";
import { DecklinkKeyFillOutputAdapter } from "./output-adapters/decklink-key-fill-output-adapter.js";
import { DecklinkVideoOutputAdapter } from "./output-adapters/decklink-video-output-adapter.js";
import { DisplayVideoOutputAdapter } from "./output-adapters/display-output-adapter.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import { getBridgeContext } from "../bridge-context.js";
import { isDevelopmentMode } from "../dev-mode.js";
import { deviceCache } from "../device-cache.js";
import { listDecklinkDisplayModes } from "../../modules/decklink/decklink-helper.js";
import { ElectronRendererClient } from "./renderer/electron-renderer-client.js";
import { StubRenderer } from "./renderer/stub-renderer.js";
import type {
  GraphicsRenderer,
  GraphicsRendererConfigT,
} from "./renderer/graphics-renderer.js";
import type { TemplateBindingsT } from "./template-bindings.js";
import { deriveTemplateBindings } from "./template-bindings.js";
import { createTestPatternPayload } from "./test-pattern.js";
import {
  KEY_FILL_PIXEL_FORMAT_PRIORITY,
  VIDEO_PIXEL_FORMAT_PRIORITY,
  supportsAnyPixelFormat,
} from "./output-format-policy.js";
import {
  applyFrameBusEnv,
  buildFrameBusConfig,
  type FrameBusConfigT,
} from "./framebus/framebus-config.js";
import {
  GraphicsError,
  type GraphicsErrorCodeT,
} from "./graphics-errors.js";

const MAX_ACTIVE_LAYERS = 3;

const OUTPUT_KEYS_WITH_ALPHA: GraphicsOutputKeyT[] = [
  "key_fill_sdi",
  "key_fill_ndi",
];

type GraphicsLayerStateT = {
  layerId: string;
  category: GraphicsCategoryT;
  layout: GraphicsLayoutT;
  zIndex: number;
  backgroundMode: GraphicsBackgroundModeT;
  values: Record<string, unknown>;
  bindings: TemplateBindingsT;
  schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  presetId?: string;
};

type GraphicsActivePresetT = {
  presetId: string;
  durationMs: number | null;
  layerIds: Set<string>;
  pendingStart: boolean;
  startedAt: number | null;
  expiresAt: number | null;
  timer: NodeJS.Timeout | null;
};

type PreparedLayerT = GraphicsSendPayloadT & {
  backgroundMode: GraphicsBackgroundModeT;
  values: Record<string, unknown>;
  bindings: TemplateBindingsT;
};

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

  constructor() {
    this.renderer = this.selectRenderer();
    this.outputAdapter = new StubOutputAdapter();
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

    await assetRegistry.initialize();
    await outputConfigStore.initialize();

    try {
      await this.renderer.initialize();
      getBridgeContext().logger.info(
        `[Graphics] Renderer initialized: ${this.renderer.constructor.name}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Graphics] Renderer init failed, falling back to stub: ${errorMessage}`
      );
      this.renderer = new StubRenderer();
      await this.renderer.initialize();
      getBridgeContext().logger.info(
        `[Graphics] Renderer initialized: ${this.renderer.constructor.name}`
      );
    }

    this.renderer.onError((error) => {
      this.publishGraphicsError("renderer_error", error.message);
    });
    await this.renderer.setAssets(assetRegistry.getAssetMap());

    const persisted = outputConfigStore.getConfig();
    if (persisted) {
      this.outputConfig = persisted;
      this.applyFrameBusConfig(persisted);
      let stage: "renderer" | "output_helper" = "renderer";
      try {
        await this.renderer.configureSession(this.buildRendererConfig(persisted));
        stage = "output_helper";
        this.outputAdapter = await this.selectOutputAdapter(persisted);
        await this.outputAdapter.configure(persisted);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.publishGraphicsError(
          stage === "renderer" ? "renderer_error" : "output_helper_error",
          errorMessage
        );
        getBridgeContext().logger.error(
          `[Graphics] Failed to apply persisted output config, falling back to stub: ${errorMessage}`
        );
        this.outputConfig = null;
        this.outputAdapter = new StubOutputAdapter();
        try {
          await outputConfigStore.clear();
          getBridgeContext().logger.warn(
            "[Graphics] Cleared persisted output config after startup failure"
          );
        } catch (clearError) {
          const clearMessage =
            clearError instanceof Error ? clearError.message : String(clearError);
          getBridgeContext().logger.warn(
            `[Graphics] Failed to clear persisted output config: ${clearMessage}`
          );
        }
      }
    }

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
        await this.validateOutputTargets(config.outputKey, config.targets);
        await this.validateOutputFormat(
          config.outputKey,
          config.targets,
          config.format
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.failGraphics("output_config_error", message);
      }
    }

    this.outputConfig = config;
    this.applyFrameBusConfig(config);
    try {
      await this.renderer.configureSession(this.buildRendererConfig(config));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failGraphics("renderer_error", message);
    }
    await this.outputAdapter.stop();
    this.outputAdapter = await this.selectOutputAdapter(config);
    await outputConfigStore.setConfig(config);
    try {
      await this.outputAdapter.configure(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failGraphics("output_helper_error", message);
    }
  }

  /**
   * Shutdown graphics renderer and output resources.
   *
   * @returns Promise resolved once resources are released.
   */
  async shutdown(): Promise<void> {
    this.clearActivePreset();
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
          payload: this.summarizeRawPayload(payload),
          outputConfig: this.outputConfig,
        })}`
      );
      throw error;
    }

    getBridgeContext().logger.info(
      `[Graphics] graphics_send payload ${JSON.stringify({
        payload: this.summarizeSendPayload(data),
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
        getBridgeContext().logger.error(
          `[Graphics] Bundle manifest render format mismatch ${JSON.stringify({
            renderInfo,
            outputFormat: this.outputConfig.format,
            layerId: data.layerId,
            category: data.category,
            presetId: data.presetId ?? null,
          })}`
        );
        throw new Error("Bundle manifest render format mismatch");
      }
    }

    const prepared = await this.prepareLayer(data);
    const durationMs = typeof data.durationMs === "number" ? data.durationMs : null;
    const hasDuration = durationMs !== null;

    if (prepared.presetId) {
      await this.removeLayersNotInPreset(prepared.presetId);
      const existingLayerId = this.categoryToLayer.get(prepared.category);
      if (existingLayerId) {
        const existingLayer = this.layers.get(existingLayerId);
        if (existingLayer?.presetId === prepared.presetId) {
          try {
            await this.renderer.removeLayer(existingLayerId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            getBridgeContext().logger.warn(
              `[Graphics] Failed to remove layer ${existingLayerId} (preset_resend): ${message}`
            );
          }
          this.layers.delete(existingLayerId);
          this.categoryToLayer.delete(prepared.category);
          if (this.activePreset?.presetId === prepared.presetId) {
            this.activePreset.layerIds.delete(existingLayerId);
          }
        }
      }
    } else if (this.activePreset) {
      await this.removePresetById(this.activePreset.presetId, "send_non_preset");
    }

    await this.renderPreparedLayer(prepared);

    let shouldPublishPreset = false;

    if (prepared.presetId) {
      if (!this.activePreset || this.activePreset.presetId !== prepared.presetId) {
        this.activePreset = {
          presetId: prepared.presetId,
          durationMs: durationMs ?? null,
          layerIds: new Set([prepared.layerId]),
          pendingStart: Boolean(durationMs && durationMs > 0),
          startedAt: null,
          expiresAt: null,
          timer: null,
        };
        getBridgeContext().logger.info(
          `[Graphics] Preset activated: ${prepared.presetId}`
        );
        shouldPublishPreset = true;
      } else {
        this.activePreset.layerIds.add(prepared.layerId);
        shouldPublishPreset = true;
      }

      if (hasDuration) {
        if (durationMs > 0) {
          this.resetActivePresetTimer(durationMs);
          shouldPublishPreset = true;
        } else {
          this.clearActivePresetTimer();
          this.activePreset.durationMs = null;
          this.activePreset.pendingStart = false;
          this.activePreset.startedAt = null;
          this.activePreset.expiresAt = null;
          shouldPublishPreset = true;
        }
      }
    }

    if (shouldPublishPreset) {
      this.publishGraphicsStatus("preset_update");
    }
  }

  /**
   * Update values for an existing layer.
   *
   * @param payload Untrusted update payload.
   * @returns Promise resolved after values are applied.
   */
  async updateValues(payload: unknown): Promise<void> {
    await this.initialize();

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

    const data = GraphicsRemoveSchema.parse(payload);
    const layer = this.layers.get(data.layerId);
    if (!layer) {
      return;
    }

    await this.renderer.removeLayer(data.layerId);
    this.layers.delete(data.layerId);
    if (this.categoryToLayer.get(layer.category) === data.layerId) {
      this.categoryToLayer.delete(layer.category);
    }
    if (layer.presetId && this.activePreset?.presetId === layer.presetId) {
      this.activePreset.layerIds.delete(layer.layerId);
      if (this.activePreset.layerIds.size === 0) {
        const clearedPresetId = this.activePreset.presetId;
        this.clearActivePreset();
        getBridgeContext().logger.info(
          `[Graphics] Preset cleared via layer remove: ${clearedPresetId}`
        );
        this.publishGraphicsStatus("preset_cleared");
      }
    }
  }

  /**
   * Remove a preset.
   *
   * @param payload Untrusted preset removal payload.
   * @returns Promise resolved after preset removal.
   */
  async removePreset(payload: unknown): Promise<void> {
    await this.initialize();

    const data = GraphicsRemovePresetSchema.parse(payload);
    await this.removePresetById(data.presetId, "manual");
  }

  /**
   * Render the built-in test pattern, replacing any active layers.
   *
   * @returns Promise resolved after test pattern is sent.
   */
  async sendTestPattern(): Promise<void> {
    await this.initialize();
    await this.clearAllLayers();
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
    const activePresets = activePreset ? [activePreset] : [];

    return {
      outputConfig: this.outputConfig,
      layers,
      activePreset,
      activePresets,
    };
  }

  private selectRenderer(): GraphicsRenderer {
    if (process.env.BRIDGE_GRAPHICS_RENDERER === "stub") {
      return new StubRenderer();
    }

    return new ElectronRendererClient();
  }

  private buildRendererConfig(
    config: GraphicsOutputConfigT
  ): GraphicsRendererConfigT {
    const frameBusConfig = this.frameBusConfig;
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

  private async selectOutputAdapter(
    config: GraphicsOutputConfigT
  ): Promise<GraphicsOutputAdapter> {
    if (isDevelopmentMode()) {
      return new StubOutputAdapter();
    }
    if (config.outputKey === "key_fill_sdi") {
      return new DecklinkKeyFillOutputAdapter();
    }
    if (config.outputKey === "video_sdi") {
      return new DecklinkVideoOutputAdapter();
    }
    if (config.outputKey === "video_hdmi") {
      // HDMI output can target DeckLink or external display outputs on macOS.
      const outputId = config.targets.output1Id;
      const portMatch = outputId ? await this.findPortById(outputId) : null;
      if (portMatch?.device.type === "display") {
        return new DisplayVideoOutputAdapter();
      }
      return new DecklinkVideoOutputAdapter();
    }
    return new StubOutputAdapter();
  }

  private async findPortById(
    portId: string
  ): Promise<{ device: DeviceDescriptorT; port: DeviceDescriptorT["ports"][number] } | null> {
    const devices = await deviceCache.getDevices();
    return this.findPort(devices, portId);
  }

  private validateLayerLimits(
    layerId: string,
    category: GraphicsCategoryT
  ): void {
    const existingLayer = this.layers.get(layerId);
    const layerInCategory = this.categoryToLayer.get(category);
    if (layerInCategory && layerInCategory !== layerId) {
      throw new Error(`Layer already active for category ${category}`);
    }

    if (!existingLayer) {
      const activeLayers = this.layers.size;
      if (activeLayers >= MAX_ACTIVE_LAYERS) {
        throw new Error("Maximum active layers reached");
      }
    }
  }

  private async clearAllLayers(): Promise<void> {
    const layers = Array.from(this.layers.values());
    for (const layer of layers) {
      try {
        await this.renderer.removeLayer(layer.layerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getBridgeContext().logger.warn(
          `[Graphics] Failed to remove layer ${layer.layerId}: ${message}`
        );
      }
    }
    this.layers.clear();
    this.categoryToLayer.clear();
    this.clearActivePreset();
    this.publishGraphicsStatus("clear_all_layers");
  }

  /**
   * Validate output format against port capabilities
   *
   * Checks if the requested format (width, height, fps) is supported
   * by the selected output ports/devices.
   */
  private async validateOutputFormat(
    _outputKey: GraphicsOutputKeyT,
    _targets: GraphicsTargetsT,
    _format: { width: number; height: number; fps: number }
  ): Promise<void> {
    if (_outputKey === "stub" || _outputKey === "key_fill_ndi") {
      return;
    }

    const outputIds = [_targets.output1Id];

    const devices = await deviceCache.getDevices();
    const requireKeying = _outputKey === "key_fill_sdi";
    const preferredFormats =
      _outputKey === "key_fill_sdi"
        ? KEY_FILL_PIXEL_FORMAT_PRIORITY
        : VIDEO_PIXEL_FORMAT_PRIORITY;

    for (const outputId of outputIds) {
      if (!outputId) {
        continue;
      }
      const outputMatch = this.findPort(devices, outputId);
      // Only DeckLink devices report full mode lists today.
      if (!outputMatch) {
        continue;
      }

      if (outputMatch.device.type === "display") {
        const modes = outputMatch.port.capabilities.modes ?? [];
        if (modes.length === 0) {
          getBridgeContext().logger.warn(
            `[Graphics] Display output has no mode list; skipping format validation for ${outputId}`
          );
          continue;
        }
        const hasMatch = modes.some(
          (mode) =>
            mode.width === _format.width &&
            mode.height === _format.height &&
            Math.abs(mode.fps - _format.fps) < 0.01
        );
        if (!hasMatch) {
          throw new Error("Output format not supported by selected display");
        }
        continue;
      }

      if (outputMatch.device.type !== "decklink") {
        continue;
      }

      const modes = await listDecklinkDisplayModes(
        outputMatch.device.id,
        outputId,
        {
          width: _format.width,
          height: _format.height,
          fps: _format.fps,
          requireKeying,
        }
      );

      if (modes.length === 0) {
        throw new Error("Output format not supported by selected device");
      }

      const hasSupportedFormat = modes.some((mode) =>
        supportsAnyPixelFormat(mode.pixelFormats, preferredFormats)
      );

      if (!hasSupportedFormat) {
        throw new Error("Output pixel format not supported by selected device");
      }
    }
  }

  private async validateOutputTargets(
    outputKey: GraphicsOutputKeyT,
    targets: GraphicsTargetsT
  ): Promise<void> {
    if (outputKey === "key_fill_sdi") {
      if (!targets.output1Id || !targets.output2Id) {
        throw new Error("Output 1 and Output 2 are required for Key & Fill SDI");
      }
      if (targets.output1Id === targets.output2Id) {
        throw new Error("Output 1 and Output 2 must be different");
      }

      const devices = await deviceCache.getDevices();
      const output1Match = this.findPort(devices, targets.output1Id);
      const output2Match = this.findPort(devices, targets.output2Id);
      if (!output1Match || !output2Match) {
        throw new Error("Invalid output ports selected");
      }
      if (output1Match.device.id !== output2Match.device.id) {
        throw new Error("Output ports must belong to the same device");
      }
      if (output1Match.port.type !== "sdi" || output2Match.port.type !== "sdi") {
        throw new Error("Key & Fill SDI requires SDI output ports");
      }
      if (output1Match.port.role !== "fill") {
        throw new Error("Output 1 must be the SDI Fill port");
      }
      if (output2Match.port.role !== "key") {
        throw new Error("Output 2 must be the SDI Key port");
      }
      if (!output1Match.port.status.available || !output2Match.port.status.available) {
        throw new Error("Selected output ports are not available");
      }
    }
    if (outputKey === "video_sdi") {
      if (!targets.output1Id) {
        throw new Error("Output 1 is required for Video SDI");
      }
      const devices = await deviceCache.getDevices();
      const output1Match = this.findPort(devices, targets.output1Id);
      if (!output1Match) {
        throw new Error("Invalid output port selected");
      }
      if (output1Match.port.type !== "sdi") {
        throw new Error("Video SDI requires an SDI output port");
      }
      if (output1Match.port.role === "key") {
        throw new Error("Video SDI cannot use the SDI Key port");
      }
      if (!output1Match.port.status.available) {
        throw new Error("Selected output port is not available");
      }
    }

    if (outputKey === "video_hdmi") {
      if (!targets.output1Id) {
        throw new Error("Output 1 is required for Video HDMI");
      }
      const devices = await deviceCache.getDevices();
      const output1Match = this.findPort(devices, targets.output1Id);
      if (!output1Match) {
        throw new Error("Invalid output port selected");
      }
      if (
        output1Match.port.type !== "hdmi" &&
        output1Match.port.type !== "displayport" &&
        output1Match.port.type !== "thunderbolt"
      ) {
        throw new Error(
          "Video HDMI requires an HDMI/DisplayPort/Thunderbolt output port"
        );
      }
      if (!output1Match.port.status.available) {
        throw new Error("Selected output port is not available");
      }
    }
  }

  private findPort(
    devices: DeviceDescriptorT[],
    portId: string
  ): { device: DeviceDescriptorT; port: DeviceDescriptorT["ports"][number] } | null {
    for (const device of devices) {
      const port = device.ports.find((entry) => entry.id === portId);
      if (port) {
        return { device, port };
      }
    }
    return null;
  }

  private summarizeSendPayload(
    data: GraphicsSendPayloadT
  ): Record<string, unknown> {
    const manifest = data.bundle?.manifest ?? {};
    const render =
      typeof (manifest as Record<string, unknown>).render === "object" &&
      (manifest as Record<string, unknown>).render !== null
        ? (manifest as Record<string, unknown>).render
        : null;
    const values = data.values ?? {};
    const schema =
      typeof data.bundle?.schema === "object" && data.bundle.schema !== null
        ? data.bundle.schema
        : {};
    const defaults =
      typeof data.bundle?.defaults === "object" && data.bundle.defaults !== null
        ? data.bundle.defaults
        : {};
    const assets = Array.isArray(data.bundle?.assets) ? data.bundle.assets : [];

    return {
      layerId: data.layerId,
      category: data.category,
      presetId: data.presetId ?? null,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
      backgroundMode: data.backgroundMode,
      layout: data.layout,
      zIndex: data.zIndex,
      manifest: {
        name: (manifest as Record<string, unknown>).name ?? null,
        version: (manifest as Record<string, unknown>).version ?? null,
        type: (manifest as Record<string, unknown>).type ?? null,
        render,
      },
      htmlLength:
        typeof data.bundle?.html === "string" ? data.bundle.html.length : 0,
      cssLength: typeof data.bundle?.css === "string" ? data.bundle.css.length : 0,
      schemaKeys: Object.keys(schema),
      defaultsKeys: Object.keys(defaults),
      valuesKeys: Object.keys(values),
      valuesCount: Object.keys(values).length,
      assetsCount: assets.length,
      assetIds: assets.map((asset) => asset.assetId),
    };
  }

  private summarizeRawPayload(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const record = payload as Record<string, unknown>;
    const bundle =
      typeof record.bundle === "object" && record.bundle !== null
        ? (record.bundle as Record<string, unknown>)
        : null;
    const values =
      typeof record.values === "object" && record.values !== null
        ? (record.values as Record<string, unknown>)
        : null;
    const manifest =
      bundle && typeof bundle.manifest === "object" && bundle.manifest !== null
        ? (bundle.manifest as Record<string, unknown>)
        : null;

    return {
      layerId: record.layerId ?? null,
      category: record.category ?? null,
      presetId: record.presetId ?? null,
      durationMs: record.durationMs ?? null,
      backgroundMode: record.backgroundMode ?? null,
      layout: record.layout ?? null,
      zIndex: record.zIndex ?? null,
      manifest: {
        name: manifest?.name ?? null,
        version: manifest?.version ?? null,
        type: manifest?.type ?? null,
        render: manifest?.render ?? null,
      },
      htmlLength: typeof bundle?.html === "string" ? bundle.html.length : 0,
      cssLength: typeof bundle?.css === "string" ? bundle.css.length : 0,
      valuesKeys: values ? Object.keys(values) : [],
    };
  }

  private async prepareLayer(
    data: GraphicsSendPayloadT
  ): Promise<PreparedLayerT> {
    // Sanitize CSS before validation to avoid style/script injection vectors.
    const sanitizedCss = sanitizeTemplateCss(data.bundle.css);
    const sanitizedBundle = {
      ...data.bundle,
      css: sanitizedCss,
    };
    // Validate template HTML/CSS against a safe subset (no scripts/externals).
    const { assetIds } = validateTemplate(data.bundle.html, sanitizedCss);

    for (const asset of sanitizedBundle.assets || []) {
      await assetRegistry.storeAsset(asset);
    }

    for (const assetId of assetIds) {
      if (!assetRegistry.getAsset(assetId)) {
        throw new Error(`Missing asset reference: ${assetId}`);
      }
    }

    // Provide renderer a resolved asset map (file paths only, no raw data).
    await this.renderer.setAssets(assetRegistry.getAssetMap());

    // If output supports alpha, enforce transparent background regardless of payload.
    const enforcedBackground = OUTPUT_KEYS_WITH_ALPHA.includes(
      this.outputConfig?.outputKey ?? "stub"
    )
      ? "transparent"
      : data.backgroundMode;

    const initialValues = {
      ...(sanitizedBundle.defaults || {}),
      ...(data.values || {}),
    };

    const bindings = deriveTemplateBindings(sanitizedBundle, initialValues);

    return {
      ...data,
      bundle: sanitizedBundle,
      backgroundMode: enforcedBackground,
      values: initialValues,
      bindings,
    };
  }

  private async renderPreparedLayer(data: PreparedLayerT): Promise<void> {
    this.validateLayerLimits(data.layerId, data.category);

    const existing = this.layers.get(data.layerId);
    if (existing && existing.category !== data.category) {
      this.categoryToLayer.delete(existing.category);
    }

    this.layers.set(data.layerId, {
      layerId: data.layerId,
      category: data.category,
      layout: data.layout,
      zIndex: data.zIndex,
      backgroundMode: data.backgroundMode,
      values: data.values,
      bindings: data.bindings,
      schema: { ...(data.bundle.schema || {}) },
      defaults: { ...(data.bundle.defaults || {}) },
      presetId: data.presetId,
    });

    this.categoryToLayer.set(data.category, data.layerId);

    try {
      await this.renderer.renderLayer({
        layerId: data.layerId,
        html: data.bundle.html,
        css: data.bundle.css,
        values: data.values,
        bindings: data.bindings,
        layout: data.layout,
        backgroundMode: data.backgroundMode,
        width: this.outputConfig?.format.width ?? 1920,
        height: this.outputConfig?.format.height ?? 1080,
        fps: this.outputConfig?.format.fps ?? 50,
        zIndex: data.zIndex,
      });
      this.maybeStartPresetTimers([data.layerId]);
    } catch (error) {
      this.layers.delete(data.layerId);
      if (this.categoryToLayer.get(data.category) === data.layerId) {
        this.categoryToLayer.delete(data.category);
      }
      throw error;
    }
  }

  private maybeStartPresetTimers(layerIds: string[]): void {
    if (!this.activePreset) {
      return;
    }

    if (!this.activePreset.pendingStart) {
      return;
    }

    const hasActiveLayer = layerIds.some((layerId) =>
      this.activePreset?.layerIds.has(layerId)
    );

    if (!hasActiveLayer) {
      return;
    }

    const startedAt = Date.now();
    const presetId = this.activePreset.presetId;
    this.activePreset.pendingStart = false;
    this.activePreset.startedAt = startedAt;
    this.activePreset.expiresAt = startedAt + (this.activePreset.durationMs ?? 0);
    this.activePreset.timer = setTimeout(() => {
      void this.expireActivePreset(presetId);
    }, this.activePreset.durationMs ?? 0);
    this.publishGraphicsStatus("preset_started");
  }

  private resetActivePresetTimer(durationMs: number): void {
    if (!this.activePreset) {
      return;
    }
    this.clearActivePresetTimer();
    this.activePreset.durationMs = durationMs;
    this.activePreset.pendingStart = true;
    this.activePreset.startedAt = null;
    this.activePreset.expiresAt = null;
  }

  private clearActivePresetTimer(): void {
    if (this.activePreset?.timer) {
      clearTimeout(this.activePreset.timer);
      this.activePreset.timer = null;
    }
  }

  private clearActivePreset(): void {
    this.clearActivePresetTimer();
    this.activePreset = null;
  }

  private async expireActivePreset(presetId: string): Promise<void> {
    if (!this.activePreset || this.activePreset.presetId !== presetId) {
      return;
    }

    await this.removePresetById(presetId, "expired");
    getBridgeContext().logger.info(`[Graphics] Preset expired: ${presetId}`);
  }

  private async removeLayersNotInPreset(presetId: string): Promise<void> {
    const layersToRemove = Array.from(this.layers.values()).filter(
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
      try {
        await this.renderer.removeLayer(layer.layerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getBridgeContext().logger.warn(
          `[Graphics] Failed to remove layer ${layer.layerId} (preset_replace): ${message}`
        );
      }
      this.layers.delete(layer.layerId);
      if (this.categoryToLayer.get(layer.category) === layer.layerId) {
        this.categoryToLayer.delete(layer.category);
      }
    }

    if (this.activePreset && this.activePreset.presetId !== presetId) {
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

  private async removePresetById(
    presetId: string,
    reason: "manual" | "expired" | "replace" | "send_non_preset" = "manual"
  ): Promise<void> {
    const layersToRemove = Array.from(this.layers.values()).filter(
      (layer) => layer.presetId === presetId
    );
    const wasActive = this.activePreset?.presetId === presetId;

    for (const layer of layersToRemove) {
      try {
        await this.renderer.removeLayer(layer.layerId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getBridgeContext().logger.warn(
          `[Graphics] Failed to remove layer ${layer.layerId} (preset_remove): ${message}`
        );
      }
      this.layers.delete(layer.layerId);
      if (this.categoryToLayer.get(layer.category) === layer.layerId) {
        this.categoryToLayer.delete(layer.category);
      }
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
      this.publishGraphicsStatus("preset_removed");
    }
  }

  private publishGraphicsStatus(reason: string): void {
    const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
    if (!publishBridgeEvent) {
      return;
    }
    const status = this.getStatus();
    getBridgeContext().logger.info(
      `[Graphics] Publish status: ${reason}`
    );
    publishBridgeEvent({
      event: "graphics_status",
      data: {
        reason,
        activePreset: status.activePreset,
        activePresets: status.activePresets,
      },
    });
  }

  private publishGraphicsError(code: string, message: string): void {
    const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
    if (!publishBridgeEvent) {
      return;
    }
    getBridgeContext().logger.error(
      `[Graphics] Error reported: ${code} ${message}`
    );
    publishBridgeEvent({
      event: "graphics_error",
      data: {
        code,
        message,
      },
    });
  }

  private failGraphics(code: GraphicsErrorCodeT, message: string): never {
    this.publishGraphicsError(code, message);
    throw new GraphicsError(code, message);
  }

  private applyFrameBusConfig(config: GraphicsOutputConfigT): void {
    const requestedPixelFormat =
      process.env.BRIDGE_FRAME_PIXEL_FORMAT ??
      process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT;
    if (requestedPixelFormat && requestedPixelFormat !== "1") {
      getBridgeContext().logger.warn(
        `[Graphics] FrameBus pixel format ${requestedPixelFormat} not supported; enforcing RGBA8`
      );
    }

    const previous = this.frameBusConfig;
    const next = buildFrameBusConfig(config, previous);
    this.frameBusConfig = next;
    applyFrameBusEnv(next);

    const changed =
      !previous ||
      previous.name !== next.name ||
      previous.slotCount !== next.slotCount ||
      previous.pixelFormat !== next.pixelFormat ||
      previous.width !== next.width ||
      previous.height !== next.height ||
      previous.fps !== next.fps;

    if (changed) {
      getBridgeContext().logger.info(
        `[Graphics] FrameBus config ${JSON.stringify({
          name: next.name,
          slotCount: next.slotCount,
          pixelFormat: next.pixelFormat,
          width: next.width,
          height: next.height,
          fps: next.fps,
          size: next.size,
        })}`
      );
    }
  }
}

export const graphicsManager = new GraphicsManager();
