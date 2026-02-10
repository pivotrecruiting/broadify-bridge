import type { GraphicsLayoutT } from "../graphics-schemas.js";
import type {
  GraphicsFrameT,
  GraphicsRendererConfigT,
  GraphicsRenderer,
  GraphicsRenderLayerInputT,
  GraphicsTemplateBindingsT,
} from "./graphics-renderer.js";

/**
 * Stub renderer that emits transparent frames.
 */
export class StubRenderer implements GraphicsRenderer {
  private frameCallback: ((frame: GraphicsFrameT) => void) | null = null;
  private errorCallback: ((error: Error) => void) | null = null;
  private layers = new Map<
    string,
    { width: number; height: number; buffer: Buffer }
  >();

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
    const buffer = Buffer.alloc(input.width * input.height * 4, 0);
    this.layers.set(input.layerId, {
      width: input.width,
      height: input.height,
      buffer,
    });

    this.emitFrame(input.layerId);
  }

  async updateValues(
    layerId: string,
    _values: Record<string, unknown>,
    _bindings?: GraphicsTemplateBindingsT
  ): Promise<void> {
    this.emitFrame(layerId);
  }

  async updateLayout(
    layerId: string,
    _layout: GraphicsLayoutT,
    _zIndex?: number
  ): Promise<void> {
    this.emitFrame(layerId);
  }

  async removeLayer(layerId: string): Promise<void> {
    this.layers.delete(layerId);
  }

  onFrame(callback: (frame: GraphicsFrameT) => void): void {
    this.frameCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  async shutdown(): Promise<void> {
    this.layers.clear();
    this.frameCallback = null;
    this.errorCallback = null;
  }

  private emitFrame(layerId: string): void {
    if (!this.frameCallback) {
      return;
    }
    const layer = this.layers.get(layerId);
    if (!layer) {
      return;
    }
    this.frameCallback({
      layerId,
      width: layer.width,
      height: layer.height,
      buffer: layer.buffer,
      timestamp: Date.now(),
    });
  }
}
