import { getBridgeContext } from "../../services/bridge-context.js";
import type { DeviceDescriptorT } from "../../types.js";

/**
 * Decklink Detector
 *
 * Discovery implementation for Blackmagic Decklink cards.
 */
export class DecklinkDetector {
  /**
   * Detect Decklink devices
   *
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    const logger = getBridgeContext().logger;
    logger.info("[DecklinkDetector] Device detection disabled");
    return [];
  }
}
