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

export type GraphicsRenderLayerInputT = {
  layerId: string;
  html: string;
  css: string;
  values: Record<string, unknown>;
  layout: GraphicsLayoutT;
  backgroundMode: GraphicsBackgroundModeT;
  width: number;
  height: number;
  fps: number;
};

/**
 * Graphics renderer interface for offscreen Chromium rendering.
 */
export interface GraphicsRenderer {
  initialize(): Promise<void>;
  setAssets(assets: Record<string, { filePath: string; mime: string }>): Promise<void>;
  renderLayer(input: GraphicsRenderLayerInputT): Promise<void>;
  updateValues(layerId: string, values: Record<string, unknown>): Promise<void>;
  updateLayout(layerId: string, layout: GraphicsLayoutT): Promise<void>;
  removeLayer(layerId: string): Promise<void>;
  onFrame(callback: (frame: GraphicsFrameT) => void): void;
  shutdown(): Promise<void>;
}
