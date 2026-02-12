import { assetRegistry } from "./asset-registry.js";
import { outputConfigStore } from "./output-config-store.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";
import type { GraphicsOutputAdapter } from "./output-adapter.js";
import type {
  GraphicsRenderer,
  GraphicsRendererConfigT,
} from "./renderer/graphics-renderer.js";
import { getBridgeContext } from "../bridge-context.js";

type GraphicsRuntimeInitServiceDepsT = {
  getRenderer: () => GraphicsRenderer;
  setRenderer: (renderer: GraphicsRenderer) => void;
  setOutputAdapter: (adapter: GraphicsOutputAdapter) => void;
  setOutputConfig: (config: GraphicsOutputConfigT | null) => void;
  createStubRenderer: () => GraphicsRenderer;
  createStubOutputAdapter: () => GraphicsOutputAdapter;
  selectOutputAdapter: (config: GraphicsOutputConfigT) => Promise<GraphicsOutputAdapter>;
  applyFrameBusConfig: (config: GraphicsOutputConfigT) => void;
  buildRendererConfig: (config: GraphicsOutputConfigT) => GraphicsRendererConfigT;
  publishGraphicsError: (code: string, message: string) => void;
};

/**
 * Runtime initializer and startup recovery workflow for graphics services.
 *
 * This service centralizes renderer startup, fallback to stub renderer,
 * asset bootstrap, and persisted output-config recovery logic.
 */
export class GraphicsRuntimeInitService {
  constructor(private readonly deps: GraphicsRuntimeInitServiceDepsT) {}

  /**
   * Initialize graphics runtime once at process startup.
   */
  async initialize(): Promise<void> {
    await assetRegistry.initialize();
    await outputConfigStore.initialize();

    await this.initializeRendererWithFallback();
    await this.applyPersistedOutputConfigIfPresent();
  }

  private async initializeRendererWithFallback(): Promise<void> {
    let renderer = this.deps.getRenderer();
    try {
      await renderer.initialize();
      getBridgeContext().logger.info(
        `[Graphics] Renderer initialized: ${renderer.constructor.name}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Graphics] Renderer init failed, falling back to stub: ${errorMessage}`
      );
      renderer = this.deps.createStubRenderer();
      await renderer.initialize();
      this.deps.setRenderer(renderer);
      getBridgeContext().logger.info(
        `[Graphics] Renderer initialized: ${renderer.constructor.name}`
      );
    }

    renderer.onError((error) => {
      this.deps.publishGraphicsError("renderer_error", error.message);
    });
    await renderer.setAssets(assetRegistry.getAssetMap());
  }

  private async applyPersistedOutputConfigIfPresent(): Promise<void> {
    const persisted = outputConfigStore.getConfig();
    if (!persisted) {
      return;
    }

    this.deps.setOutputConfig(persisted);
    this.deps.applyFrameBusConfig(persisted);
    let stage: "renderer" | "output_helper" = "renderer";
    let nextAdapter: GraphicsOutputAdapter | null = null;
    const renderer = this.deps.getRenderer();

    try {
      await renderer.configureSession(this.deps.buildRendererConfig(persisted));
      stage = "output_helper";
      nextAdapter = await this.deps.selectOutputAdapter(persisted);
      await nextAdapter.configure(persisted);
      this.deps.setOutputAdapter(nextAdapter);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.deps.publishGraphicsError(
        stage === "renderer" ? "renderer_error" : "output_helper_error",
        errorMessage
      );
      getBridgeContext().logger.error(
        `[Graphics] Failed to apply persisted output config, falling back to stub: ${errorMessage}`
      );

      if (nextAdapter) {
        try {
          await nextAdapter.stop();
        } catch (stopError) {
          const stopMessage =
            stopError instanceof Error ? stopError.message : String(stopError);
          getBridgeContext().logger.warn(
            `[Graphics] Failed to stop failed startup output adapter: ${stopMessage}`
          );
        }
      }

      this.deps.setOutputConfig(null);
      this.deps.setOutputAdapter(this.deps.createStubOutputAdapter());
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
}
