import type {
  GraphicsBackgroundModeT,
  GraphicsLayoutT,
} from "../graphics-schemas.js";

export type GraphicsFrameT = {
  layerId: string;
  width: number;
  height: number;
  buffer: Buffer;
  timestamp: number;
};

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

/**
 * Graphics renderer interface for offscreen Chromium rendering.
 */
export interface GraphicsRenderer {
  /**
   * Initialize renderer resources.
   */
  initialize(): Promise<void>;
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
   * Register a frame callback.
   *
   * Legacy fallback path when FrameBus output is disabled.
   *
   * @param callback Invoked for each rendered frame.
   */
  onFrame(callback: (frame: GraphicsFrameT) => void): void;
  /**
   * Shutdown renderer and release resources.
   */
  shutdown(): Promise<void>;
}
