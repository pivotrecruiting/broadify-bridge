import { assetRegistry } from "./asset-registry.js";
import { compositeLayers } from "./composite.js";
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
} from "./graphics-schemas.js";
import { outputConfigStore } from "./output-config-store.js";
import { validateTemplate } from "./template-sanitizer.js";
import { StubOutputAdapter } from "./output-adapters/stub-output-adapter.js";
import { DecklinkKeyFillOutputAdapter } from "./output-adapters/decklink-key-fill-output-adapter.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import { getBridgeContext } from "../bridge-context.js";
import { deviceCache } from "../device-cache.js";
import { ElectronRendererClient } from "./renderer/electron-renderer-client.js";
import { StubRenderer } from "./renderer/stub-renderer.js";
import type {
  GraphicsFrameT,
  GraphicsRenderer,
} from "./renderer/graphics-renderer.js";

const MAX_ACTIVE_LAYERS = 3;
const MAX_QUEUED_PRESETS = 10;

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
      await this.outputAdapter.configure(persisted);
      this.startTicker(persisted.format.fps);
    }

    this.initialized = true;
  }

  /**
   * Configure graphics outputs.
   */
  async configureOutputs(payload: unknown): Promise<void> {
    await this.initialize();

    const config = GraphicsConfigureOutputsSchema.parse(payload);
    await this.validateOutputTargets(config.outputKey, config.targets);
    await this.validateOutputFormat(
      config.outputKey,
      config.targets,
      config.format
    );

    this.outputConfig = config;
    await this.outputAdapter.stop();
    this.outputAdapter = this.selectOutputAdapter(config.outputKey);
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
    await this.renderer.updateValues(data.layerId, data.values);
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
    if (_outputKey === "key_fill_sdi") {
      return new DecklinkKeyFillOutputAdapter();
    }
    return new StubOutputAdapter();
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
    // Format validation placeholder
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

    const outputBuffer = composite;

    this.sending = true;
    try {
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
    const { assetIds } = validateTemplate(data.bundle.html, data.bundle.css);

    for (const asset of data.bundle.assets || []) {
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
      ...(data.bundle.defaults || {}),
      ...(data.values || {}),
    };

    return {
      ...data,
      backgroundMode: enforcedBackground,
      values: initialValues,
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
