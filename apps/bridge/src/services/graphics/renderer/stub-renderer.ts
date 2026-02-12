import type { GraphicsLayoutT } from "../graphics-schemas.js";
import type {
  GraphicsRendererConfigT,
  GraphicsRenderer,
  GraphicsRenderLayerInputT,
  GraphicsTemplateBindingsT,
} from "./graphics-renderer.js";

/**
 * Stub renderer used for development/testing without real rendering output.
 */
export class StubRenderer implements GraphicsRenderer {
  private layers = new Set<string>();

  async initialize(): Promise<void> {
    return;
  }

  async configureSession(_config: GraphicsRendererConfigT): Promise<void> {
    return;
  }

  async setAssets(_assets: Record<string, { filePath: string; mime: string }>): Promise<void> {
    return;
  }

  async renderLayer(input: GraphicsRenderLayerInputT): Promise<void> {
    this.layers.add(input.layerId);
  }

  async updateValues(
    _layerId: string,
    _values: Record<string, unknown>,
    _bindings?: GraphicsTemplateBindingsT
  ): Promise<void> {
    return;
  }

  async updateLayout(
    _layerId: string,
    _layout: GraphicsLayoutT,
    _zIndex?: number
  ): Promise<void> {
    return;
  }

  async removeLayer(layerId: string): Promise<void> {
    this.layers.delete(layerId);
  }

  onError(callback: (error: Error) => void): void {
    void callback;
  }

  async shutdown(): Promise<void> {
    this.layers.clear();
  }
}
