import type { GraphicsOutputConfigT } from "./graphics-schemas.js";

export type GraphicsOutputFrameT = {
  width: number;
  height: number;
  rgba: Buffer;
  timestamp: number;
};

/**
 * Output adapter interface for SDI/NDI targets.
 */
export interface GraphicsOutputAdapter {
  configure(config: GraphicsOutputConfigT): Promise<void>;
  sendFrame(frame: GraphicsOutputFrameT, config: GraphicsOutputConfigT): Promise<void>;
  stop(): Promise<void>;
}
