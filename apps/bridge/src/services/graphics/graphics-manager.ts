import { assetRegistry } from "./asset-registry.js";
import { applyBackground, compositeLayers } from "./composite.js";
import type {
  GraphicsBackgroundModeT,
  GraphicsCategoryT,
  GraphicsLayoutT,
  GraphicsOutputConfigT,
  GraphicsOutputKeyT,
  GraphicsTargetsT,
  GraphicsSendPayloadT,
} from "./graphics-schemas.js";
import type { DeviceDescriptorT } from "../../types.js";
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
import { DecklinkSplitOutputAdapter } from "./output-adapters/decklink-split-output-adapter.js";
import { DecklinkVideoOutputAdapter } from "./output-adapters/decklink-video-output-adapter.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import { getBridgeContext } from "../bridge-context.js";
import { isDevelopmentMode } from "../dev-mode.js";
import { deviceCache } from "../device-cache.js";
import { listDecklinkDisplayModes } from "../../modules/decklink/decklink-helper.js";
import { ElectronRendererClient } from "./renderer/electron-renderer-client.js";
import { StubRenderer } from "./renderer/stub-renderer.js";
import type {
  GraphicsFrameT,
  GraphicsRenderer,
} from "./renderer/graphics-renderer.js";
import type { TemplateBindingsT } from "./template-bindings.js";
import { deriveTemplateBindings } from "./template-bindings.js";
import { createTestPatternPayload } from "./test-pattern.js";
import {
  KEY_FILL_PIXEL_FORMAT_PRIORITY,
  VIDEO_PIXEL_FORMAT_PRIORITY,
  supportsAnyPixelFormat,
} from "./output-format-policy.js";

const MAX_ACTIVE_LAYERS = 3;
const MAX_QUEUED_PRESETS = 10;

const OUTPUT_KEYS_WITH_ALPHA: GraphicsOutputKeyT[] = [
  "key_fill_sdi",
  "key_fill_split_sdi",
  "key_fill_ndi",
];

const BACKGROUND_COLORS: Record<
  GraphicsBackgroundModeT,
  { r: number; g: number; b: number } | null
> = {
  transparent: null,
  green: { r: 0, g: 255, b: 0 },
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
};

const DEBUG_GRAPHICS = true;

const sampleRgbaBuffer = (
  buffer: Buffer,
  width: number,
  height: number
): Array<{ name: string; x: number; y: number; rgba: number[] | null }> => {
  const maxX = Math.max(0, width - 1);
  const maxY = Math.max(0, height - 1);
  const positions = [
    { name: "topLeft", x: 0, y: 0 },
    { name: "center", x: Math.floor(width / 2), y: Math.floor(height / 2) },
    { name: "bottomRight", x: maxX, y: maxY },
  ];

  return positions.map((pos) => {
    const index = (pos.y * width + pos.x) * 4;
    if (index < 0 || index + 3 >= buffer.length) {
      return { ...pos, rgba: null };
    }
    return {
      ...pos,
      rgba: [
        buffer[index],
        buffer[index + 1],
        buffer[index + 2],
        buffer[index + 3],
      ],
    };
  });
};

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
  lastFrame?: GraphicsFrameT;
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

type GraphicsQueuedPresetT = {
  presetId: string;
  durationMs: number | null;
  layers: Map<GraphicsCategoryT, PreparedLayerT>;
  enqueuedAt: number;
};

type PreparedLayerT = GraphicsSendPayloadT & {
  backgroundMode: GraphicsBackgroundModeT;
  values: Record<string, unknown>;
  bindings: TemplateBindingsT;
};

/**
 * Graphics manager orchestrates layers, rendering, and output.
 */
export class GraphicsManager {
  private renderer: GraphicsRenderer;
  private outputAdapter: GraphicsOutputAdapter;
  private initialized = false;
  private layers = new Map<string, GraphicsLayerStateT>();
  private categoryToLayer = new Map<GraphicsCategoryT, string>();
  private outputConfig: GraphicsOutputConfigT | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private sending = false;
  private droppedFrames = 0;
  private framesSent = 0;
  private outputErrors = 0;
  private lastOutputLogAt = 0;
  private lastOutputErrorLogAt = 0;
  private outputSampleLogged = false;
  private activePreset: GraphicsActivePresetT | null = null;
  private presetQueue: GraphicsQueuedPresetT[] = [];

  constructor() {
    this.renderer = this.selectRenderer();
    this.outputAdapter = new StubOutputAdapter();
  }

  /**
   * Initialize renderer, assets, and persisted output config.
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

    this.renderer.onFrame((frame) => this.handleFrame(frame));
    await this.renderer.setAssets(assetRegistry.getAssetMap());

    const persisted = outputConfigStore.getConfig();
    if (persisted) {
      this.outputConfig = persisted;
      this.outputAdapter = this.selectOutputAdapter(persisted.outputKey);
      try {
        await this.outputAdapter.configure(persisted);
        this.startTicker(persisted.format.fps);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
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
   */
  async configureOutputs(payload: unknown): Promise<void> {
    await this.initialize();

    const config = GraphicsConfigureOutputsSchema.parse(payload);
    if (config.version > GRAPHICS_OUTPUT_CONFIG_VERSION) {
      throw new Error(
        `Unsupported graphics output config version: ${config.version}`
      );
    }
    const devMode = isDevelopmentMode();
    if (devMode) {
      getBridgeContext().logger.warn(
        "[Graphics] DEVELOPMENT mode enabled: skipping output validation and using stub output adapter"
      );
    } else {
      await this.validateOutputTargets(config.outputKey, config.targets);
      await this.validateOutputFormat(
        config.outputKey,
        config.targets,
        config.format
      );
    }

    this.outputConfig = config;
    await this.outputAdapter.stop();
    this.outputAdapter = this.selectOutputAdapter(config.outputKey);
    this.outputSampleLogged = false;
    await outputConfigStore.setConfig(config);
    await this.outputAdapter.configure(config);
    this.startTicker(config.format.fps);
  }

  /**
   * Create or update a graphics layer.
   */
  async sendLayer(payload: unknown): Promise<void> {
    await this.initialize();

    if (!this.outputConfig) {
      throw new Error("Outputs not configured");
    }

    const data = GraphicsSendSchema.parse(payload);

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
        throw new Error("Bundle manifest render format mismatch");
      }
    }

    const prepared = await this.prepareLayer(data);
    const durationMs = prepared.durationMs ?? null;

    if (
      prepared.presetId &&
      this.activePreset &&
      (this.activePreset.durationMs ?? 0) > 0 &&
      this.activePreset.presetId !== prepared.presetId
    ) {
      this.enqueuePresetLayer(prepared, durationMs);
      getBridgeContext().logger.info(
        `[Graphics] Preset queued: ${prepared.presetId}`
      );
      return;
    }

    if (
      prepared.presetId &&
      this.activePreset &&
      this.activePreset.presetId === prepared.presetId &&
      (this.activePreset.durationMs ?? 0) > 0
    ) {
      const nextDuration = durationMs ?? this.activePreset.durationMs;
      if (typeof nextDuration === "number" && nextDuration > 0) {
        this.resetActivePresetTimer(nextDuration);
      }
    }

    if (
      prepared.presetId &&
      this.activePreset &&
      this.activePreset.presetId !== prepared.presetId &&
      !this.activePreset.durationMs
    ) {
      await this.removePresetById(this.activePreset.presetId);
    }

    await this.renderPreparedLayer(prepared);

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
      } else {
        this.activePreset.layerIds.add(prepared.layerId);
      }
    }
  }

  /**
   * Update values for an existing layer.
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

    await this.renderer.updateLayout(data.layerId, data.layout);
  }

  /**
   * Remove a layer.
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
        this.clearActivePreset();
      }
    }
  }

  /**
   * Remove a preset and optionally clear the queue.
   */
  async removePreset(payload: unknown): Promise<void> {
    await this.initialize();

    const data = GraphicsRemovePresetSchema.parse(payload);
    await this.removePresetById(data.presetId);

    if (data.clearQueue) {
      this.presetQueue = [];
      return;
    }

    this.presetQueue = this.presetQueue.filter(
      (item) => item.presetId !== data.presetId
    );

    if (!this.activePreset && this.presetQueue.length > 0) {
      await this.activateNextPreset();
    }
  }

  /**
   * Render the built-in test pattern, replacing any active layers.
   */
  async sendTestPattern(): Promise<void> {
    await this.initialize();
    await this.clearAllLayers();
    await this.sendLayer(createTestPatternPayload());
  }

  /**
   * List output config and active layers.
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
    } | null;
    queuedPresets: Array<{
      presetId: string;
      durationMs: number | null;
      layerIds: string[];
      enqueuedAt: number;
    }>;
  } {
    const layers = Array.from(this.layers.values()).map((layer) => ({
      layerId: layer.layerId,
      category: layer.category,
      layout: layer.layout,
      zIndex: layer.zIndex,
      presetId: layer.presetId,
    }));

    return {
      outputConfig: this.outputConfig,
      layers,
      activePreset: this.activePreset
        ? {
          presetId: this.activePreset.presetId,
          durationMs: this.activePreset.durationMs,
          startedAt: this.activePreset.startedAt,
          expiresAt: this.activePreset.expiresAt,
          pendingStart: this.activePreset.pendingStart,
          layerIds: Array.from(this.activePreset.layerIds),
        }
        : null,
      queuedPresets: this.presetQueue.map((item) => ({
        presetId: item.presetId,
        durationMs: item.durationMs,
        layerIds: Array.from(item.layers.values()).map((layer) => layer.layerId),
        enqueuedAt: item.enqueuedAt,
      })),
    };
  }

  private selectRenderer(): GraphicsRenderer {
    if (process.env.BRIDGE_GRAPHICS_RENDERER === "stub") {
      return new StubRenderer();
    }

    return new ElectronRendererClient();
  }

  private selectOutputAdapter(
    _outputKey: GraphicsOutputKeyT
  ): GraphicsOutputAdapter {
    if (isDevelopmentMode()) {
      return new StubOutputAdapter();
    }
    if (_outputKey === "key_fill_sdi") {
      return new DecklinkKeyFillOutputAdapter();
    }
    if (_outputKey === "key_fill_split_sdi") {
      return new DecklinkSplitOutputAdapter();
    }
    if (_outputKey === "video_sdi" || _outputKey === "video_hdmi") {
      return new DecklinkVideoOutputAdapter();
    }
    return new StubOutputAdapter();
  }

  private resolveBackgroundColor(
    mode: GraphicsBackgroundModeT
  ): { r: number; g: number; b: number } | null {
    return BACKGROUND_COLORS[mode] ?? null;
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
    this.presetQueue = [];
    this.clearActivePreset();
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

    const outputIds =
      _outputKey === "key_fill_split_sdi"
        ? [_targets.output1Id, _targets.output2Id]
        : [_targets.output1Id];

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
      if (!outputMatch || outputMatch.device.type !== "decklink") {
        return;
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
    if (outputKey === "key_fill_split_sdi") {
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
      if (
        output1Match.device.type !== "decklink" ||
        output2Match.device.type !== "decklink"
      ) {
        throw new Error("Key & Fill Split requires DeckLink outputs");
      }
      if (output1Match.port.type !== "sdi" || output2Match.port.type !== "sdi") {
        throw new Error("Key & Fill Split requires SDI output ports");
      }
      if (output1Match.port.role === "key" || output2Match.port.role === "key") {
        throw new Error("Key & Fill Split cannot use SDI Key ports");
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
      if (output1Match.port.type !== "hdmi") {
        throw new Error("Video HDMI requires an HDMI output port");
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

  private startTicker(fps: number): void {
    if (this.ticker) {
      clearInterval(this.ticker);
    }

    const interval = Math.max(1, Math.round(1000 / fps));
    this.ticker = setInterval(() => {
      void this.tick();
    }, interval);
  }

  private async tick(): Promise<void> {
    if (!this.outputConfig) {
      return;
    }

    if (this.sending) {
      this.droppedFrames++;
      return;
    }

    const layers = Array.from(this.layers.values())
      .filter((layer) => layer.lastFrame)
      .sort((a, b) => a.zIndex - b.zIndex);

    if (layers.length === 0) {
      return;
    }

    const width = this.outputConfig.format.width;
    const height = this.outputConfig.format.height;

    const composite = compositeLayers(
      layers.map((layer) => ({
        buffer: (layer.lastFrame as GraphicsFrameT).buffer,
        width,
        height,
      })),
      width,
      height
    );

    let outputBuffer = composite;
    if (!OUTPUT_KEYS_WITH_ALPHA.includes(this.outputConfig.outputKey)) {
      const backgroundMode = layers[0]?.backgroundMode ?? "transparent";
      const backgroundColor = this.resolveBackgroundColor(backgroundMode);
      if (backgroundColor) {
        outputBuffer = applyBackground(outputBuffer, backgroundColor);
      }
    }

    this.sending = true;
    try {
      if (DEBUG_GRAPHICS && !this.outputSampleLogged) {
        this.outputSampleLogged = true;
        const samples = sampleRgbaBuffer(outputBuffer, width, height);
        getBridgeContext().logger.info(
          `[Graphics] Debug output pixel samples ${JSON.stringify({
            outputKey: this.outputConfig.outputKey,
            width,
            height,
            samples,
          })}`
        );
      }
      await this.outputAdapter.sendFrame(
        {
          width,
          height,
          rgba: outputBuffer,
          timestamp: Date.now(),
        },
        this.outputConfig
      );
      this.framesSent++;
      this.maybeStartPresetTimer(layers.map((layer) => layer.layerId));

      const now = Date.now();
      if (now - this.lastOutputLogAt >= 5000) {
        this.lastOutputLogAt = now;
        getBridgeContext().logger.info(
          `[Graphics] Output ok: frames=${this.framesSent} dropped=${this.droppedFrames}`
        );
      }
    } catch (error) {
      this.outputErrors++;
      const now = Date.now();
      if (now - this.lastOutputErrorLogAt >= 5000) {
        this.lastOutputErrorLogAt = now;
        const message = error instanceof Error ? error.message : String(error);
        getBridgeContext().logger.error(
          `[Graphics] Output send failed: ${message}`
        );
      }
    } finally {
      this.sending = false;
    }
  }

  private handleFrame(frame: GraphicsFrameT): void {
    const layer = this.layers.get(frame.layerId);
    if (!layer) {
      return;
    }

    layer.lastFrame = frame;
  }

  private async prepareLayer(
    data: GraphicsSendPayloadT
  ): Promise<PreparedLayerT> {
    const sanitizedCss = sanitizeTemplateCss(data.bundle.css);
    const sanitizedBundle = {
      ...data.bundle,
      css: sanitizedCss,
    };
    const { assetIds } = validateTemplate(data.bundle.html, sanitizedCss);

    for (const asset of sanitizedBundle.assets || []) {
      await assetRegistry.storeAsset(asset);
    }

    for (const assetId of assetIds) {
      if (!assetRegistry.getAsset(assetId)) {
        throw new Error(`Missing asset reference: ${assetId}`);
      }
    }

    await this.renderer.setAssets(assetRegistry.getAssetMap());

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
      lastFrame: existing?.lastFrame,
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
      });
    } catch (error) {
      this.layers.delete(data.layerId);
      if (this.categoryToLayer.get(data.category) === data.layerId) {
        this.categoryToLayer.delete(data.category);
      }
      throw error;
    }
  }

  private enqueuePresetLayer(
    data: PreparedLayerT,
    durationMs: number | null
  ): void {
    const existing =
      this.presetQueue.length > 0
        ? this.presetQueue[this.presetQueue.length - 1]
        : null;

    if (existing && existing.presetId === data.presetId) {
      existing.layers.set(data.category, data);
      existing.durationMs = durationMs;
      return;
    }

    if (this.presetQueue.length >= MAX_QUEUED_PRESETS) {
      throw new Error("Preset queue is full");
    }

    const layers = new Map<GraphicsCategoryT, PreparedLayerT>();
    layers.set(data.category, data);
    this.presetQueue.push({
      presetId: data.presetId as string,
      durationMs,
      layers,
      enqueuedAt: Date.now(),
    });
  }

  private maybeStartPresetTimer(layerIds: string[]): void {
    if (!this.activePreset || !this.activePreset.pendingStart) {
      return;
    }

    const hasActiveLayer = layerIds.some((layerId) =>
      this.activePreset?.layerIds.has(layerId)
    );

    if (!hasActiveLayer) {
      return;
    }

    const startedAt = Date.now();
    this.activePreset.pendingStart = false;
    this.activePreset.startedAt = startedAt;
    this.activePreset.expiresAt = startedAt + (this.activePreset.durationMs ?? 0);
    this.activePreset.timer = setTimeout(() => {
      void this.expireActivePreset();
    }, this.activePreset.durationMs ?? 0);
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

  private async expireActivePreset(): Promise<void> {
    if (!this.activePreset) {
      return;
    }

    const layerIds = Array.from(this.activePreset.layerIds);
    const presetId = this.activePreset.presetId;
    this.clearActivePreset();

    for (const layerId of layerIds) {
      const layer = this.layers.get(layerId);
      if (!layer) continue;
      await this.renderer.removeLayer(layerId);
      this.layers.delete(layerId);
      if (this.categoryToLayer.get(layer.category) === layerId) {
        this.categoryToLayer.delete(layer.category);
      }
    }

    getBridgeContext().logger.info(`[Graphics] Preset expired: ${presetId}`);

    if (this.presetQueue.length > 0) {
      await this.activateNextPreset();
    }
  }

  private async activateNextPreset(): Promise<void> {
    const next = this.presetQueue.shift();
    if (!next) {
      return;
    }

    this.activePreset = {
      presetId: next.presetId,
      durationMs: next.durationMs ?? null,
      layerIds: new Set<string>(),
      pendingStart: Boolean(next.durationMs && next.durationMs > 0),
      startedAt: null,
      expiresAt: null,
      timer: null,
    };

    for (const layer of next.layers.values()) {
      await this.renderPreparedLayer(layer);
      if (this.activePreset?.presetId === next.presetId) {
        this.activePreset.layerIds.add(layer.layerId);
      }
    }
  }

  private async removePresetById(presetId: string): Promise<void> {
    const layersToRemove = Array.from(this.layers.values()).filter(
      (layer) => layer.presetId === presetId
    );

    for (const layer of layersToRemove) {
      await this.renderer.removeLayer(layer.layerId);
      this.layers.delete(layer.layerId);
      if (this.categoryToLayer.get(layer.category) === layer.layerId) {
        this.categoryToLayer.delete(layer.category);
      }
    }

    if (this.activePreset?.presetId === presetId) {
      this.clearActivePreset();
    }
  }
}

export const graphicsManager = new GraphicsManager();
