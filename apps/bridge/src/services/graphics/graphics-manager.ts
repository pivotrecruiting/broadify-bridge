import { deviceCache } from "../device-cache.js";
import { assetRegistry } from "./asset-registry.js";
import { compositeLayers, applyBackground } from "./composite.js";
import type {
  GraphicsBackgroundModeT,
  GraphicsCategoryT,
  GraphicsLayoutT,
  GraphicsOutputConfigT,
  GraphicsOutputKeyT,
  GraphicsTargetsT,
} from "./graphics-schemas.js";
import {
  GraphicsConfigureOutputsSchema,
  GraphicsSendSchema,
  GraphicsUpdateLayoutSchema,
  GraphicsUpdateValuesSchema,
  GraphicsRemoveSchema,
} from "./graphics-schemas.js";
import { outputConfigStore } from "./output-config-store.js";
import { validateTemplate } from "./template-sanitizer.js";
import { StubOutputAdapter } from "./output-adapters/stub-output-adapter.js";
import { FfmpegSdiOutputAdapter } from "./output-adapters/ffmpeg-sdi-output-adapter.js";
import { FfmpegNdiOutputAdapter } from "./output-adapters/ffmpeg-ndi-output-adapter.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import { getBridgeContext } from "../bridge-context.js";
import { ElectronRendererClient } from "./renderer/electron-renderer-client.js";
import { StubRenderer } from "./renderer/stub-renderer.js";
import type {
  GraphicsFrameT,
  GraphicsRenderer,
} from "./renderer/graphics-renderer.js";

const MAX_ACTIVE_LAYERS = 3;

const BACKGROUND_COLORS: Record<
  GraphicsBackgroundModeT,
  { r: number; g: number; b: number }
> = {
  transparent: { r: 0, g: 0, b: 0 },
  green: { r: 0, g: 255, b: 0 },
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
};

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
  lastFrame?: GraphicsFrameT;
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
    this.validateLayerLimits(data.layerId, data.category);

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
      this.outputConfig.outputKey
    )
      ? "transparent"
      : data.backgroundMode;

    const initialValues = {
      ...(data.bundle.defaults || {}),
      ...(data.values || {}),
    };

    const existing = this.layers.get(data.layerId);
    if (existing && existing.category !== data.category) {
      this.categoryToLayer.delete(existing.category);
    }

    this.layers.set(data.layerId, {
      layerId: data.layerId,
      category: data.category,
      layout: data.layout,
      zIndex: data.zIndex,
      backgroundMode: enforcedBackground,
      values: initialValues,
      lastFrame: existing?.lastFrame,
    });

    this.categoryToLayer.set(data.category, data.layerId);

    try {
      await this.renderer.renderLayer({
        layerId: data.layerId,
        html: data.bundle.html,
        css: data.bundle.css,
        values: initialValues,
        layout: data.layout,
        backgroundMode: enforcedBackground,
        width: this.outputConfig.format.width,
        height: this.outputConfig.format.height,
        fps: this.outputConfig.format.fps,
      });
    } catch (error) {
      this.layers.delete(data.layerId);
      if (this.categoryToLayer.get(data.category) === data.layerId) {
        this.categoryToLayer.delete(data.category);
      }
      throw error;
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
  }

  /**
   * List output config and active layers.
   */
  getStatus(): {
    outputConfig: GraphicsOutputConfigT | null;
    layers: unknown[];
  } {
    const layers = Array.from(this.layers.values()).map((layer) => ({
      layerId: layer.layerId,
      category: layer.category,
      layout: layer.layout,
      zIndex: layer.zIndex,
    }));

    return {
      outputConfig: this.outputConfig,
      layers,
    };
  }

  private selectRenderer(): GraphicsRenderer {
    if (process.env.BRIDGE_GRAPHICS_RENDERER === "stub") {
      return new StubRenderer();
    }

    return new ElectronRendererClient();
  }

  private selectOutputAdapter(
    outputKey: GraphicsOutputKeyT
  ): GraphicsOutputAdapter {
    if (outputKey === "video_sdi" || outputKey === "key_fill_sdi") {
      return new FfmpegSdiOutputAdapter();
    }

    if (outputKey === "key_fill_ndi") {
      return new FfmpegNdiOutputAdapter();
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

  private async validateOutputTargets(
    outputKey: GraphicsOutputKeyT,
    targets: GraphicsTargetsT
  ): Promise<void> {
    if (outputKey === "key_fill_sdi") {
      if (!targets.output1Id || !targets.output2Id) {
        throw new Error(
          "Output 1 and Output 2 are required for Key & Fill SDI"
        );
      }
      if (targets.output1Id === targets.output2Id) {
        throw new Error("Output 1 and Output 2 must be different");
      }
    }

    if (outputKey === "video_sdi") {
      if (!targets.output1Id) {
        throw new Error("Output 1 is required for Video SDI");
      }
    }

    if (outputKey === "key_fill_ndi") {
      if (!targets.ndiStreamName) {
        throw new Error("NDI stream name is required for Key & Fill NDI");
      }
    }

    if (outputKey === "key_fill_ndi") {
      return;
    }

    const devices = await deviceCache.getDevices(false);
    const availableOutputs = new Set<string>();

    for (const device of devices) {
      const hasOutputPort = device.ports.some(
        (port) =>
          port.direction === "output" || port.direction === "bidirectional"
      );
      if (hasOutputPort) {
        availableOutputs.add(device.id);
      }
    }

    const outputIds = [targets.output1Id, targets.output2Id].filter(Boolean);
    for (const outputId of outputIds) {
      if (!outputId) {
        continue;
      }
      if (!availableOutputs.has(outputId)) {
        throw new Error(`Output target not available: ${outputId}`);
      }
    }
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
    if (this.outputConfig.outputKey === "video_sdi") {
      outputBuffer = applyBackground(composite, BACKGROUND_COLORS.black);
    }

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
}

export const graphicsManager = new GraphicsManager();
