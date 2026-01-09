import type { DeviceDescriptorT } from "../../types.js";
import { getBridgeContext } from "../../services/bridge-context.js";

/**
 * Decklink Detector
 *
 * Discovery implementation for Blackmagic Decklink cards.
 * FFmpeg-based detection has been removed.
 * Future: BMD SDK integration for full feature support.
 */
export class DecklinkDetector {
  /**
   * Detect Decklink devices
   *
   * Returns empty array as FFmpeg-based detection has been removed.
   * Future: BMD SDK integration will be implemented here.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    const logger = getBridgeContext().logger;
    logger.info(
      "[DecklinkDetector] Device detection disabled - FFmpeg support removed"
    );
    return [];
  }
}
