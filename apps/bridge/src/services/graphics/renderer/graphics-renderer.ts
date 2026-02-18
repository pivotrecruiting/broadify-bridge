import type {
  GraphicsBackgroundModeT,
  GraphicsLayoutT,
} from "../graphics-schemas.js";

/**
 * Precomputed template bindings applied by the renderer.
 */
export type GraphicsTemplateBindingsT = {
  cssVariables: Record<string, string>;
  textContent: Record<string, string>;
  textTypes: Record<string, string>;
  animationClass: string;
};

export type GraphicsRenderLayerInputT = {
  layerId: string;
  html: string;
  css: string;
  values: Record<string, unknown>;
  bindings?: GraphicsTemplateBindingsT;
  layout: GraphicsLayoutT;
  backgroundMode: GraphicsBackgroundModeT;
  width: number;
  height: number;
  fps: number;
  zIndex?: number;
};

export type GraphicsRendererClearColorT = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type GraphicsRendererConfigT = {
  width: number;
  height: number;
  fps: number;
  pixelFormat: number;
  framebusName: string;
  framebusSlotCount: number;
  framebusSize: number;
  backgroundMode: GraphicsBackgroundModeT;
  clearColor?: GraphicsRendererClearColorT;
};

/**
 * Graphics renderer interface for offscreen Chromium rendering.
 * Frame transport is handled by FrameBus; this interface only exposes control-plane operations.
 */
export interface GraphicsRenderer {
  /**
   * Initialize renderer resources.
   */
  initialize(): Promise<void>;
  /**
   * Configure a renderer session before creating layers.
   *
   * @param config Session configuration payload.
   */
  configureSession(config: GraphicsRendererConfigT): Promise<void>;
  /**
   * Provide asset map to renderer for local loading.
   *
   * @param assets Map of assetId to file path and mime type.
   */
  setAssets(assets: Record<string, { filePath: string; mime: string }>): Promise<void>;
  /**
   * Render or update a layer.
   *
   * @param input Render payload.
   */
  renderLayer(input: GraphicsRenderLayerInputT): Promise<void>;
  /**
   * Update layer values.
   *
   * @param layerId Layer identifier.
   * @param values New values object.
   * @param bindings Optional precomputed bindings.
   */
  updateValues(
    layerId: string,
    values: Record<string, unknown>,
    bindings?: GraphicsTemplateBindingsT
  ): Promise<void>;
  /**
   * Update layer layout (position/scale).
   *
   * @param layerId Layer identifier.
   * @param layout Layout payload.
   */
  updateLayout(
    layerId: string,
    layout: GraphicsLayoutT,
    zIndex?: number
  ): Promise<void>;
  /**
   * Remove a layer.
   *
   * @param layerId Layer identifier.
   */
  removeLayer(layerId: string): Promise<void>;
  /**
   * Register an error callback.
   *
   * @param callback Invoked for renderer errors.
   */
  onError(callback: (error: Error) => void): void;
  /**
   * Shutdown renderer and release resources.
   */
  shutdown(): Promise<void>;
}
