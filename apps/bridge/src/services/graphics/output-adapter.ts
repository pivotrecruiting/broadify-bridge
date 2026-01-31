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
  /**
   * Prepare adapter for a specific output configuration.
   *
   * @param config Output configuration payload.
   */
  configure(config: GraphicsOutputConfigT): Promise<void>;
  /**
   * Send a single frame to the output target.
   *
   * @param frame RGBA frame data.
   * @param config Output configuration payload.
   */
  sendFrame(frame: GraphicsOutputFrameT, config: GraphicsOutputConfigT): Promise<void>;
  /**
   * Stop output and release resources.
   */
  stop(): Promise<void>;
}
