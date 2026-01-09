import type { DeviceModule, DeviceController } from "../device-module.js";
import type { DeviceDescriptorT } from "../../types.js";
import { DecklinkDetector, parseDecklinkHelperDevices } from "./decklink-detector.js";
import { DecklinkDevice } from "./decklink-device.js";
import { watchDecklinkDevices } from "./decklink-helper.js";

/**
 * DeckLink Device Module (macOS-only).
 */
export class DecklinkModule implements DeviceModule {
  readonly name = "decklink";
  private readonly detector = new DecklinkDetector();

  /**
   * Detect DeckLink devices.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    return this.detector.detect();
  }

  /**
   * Watch for DeckLink device changes.
   */
  watch(
    callback: (devices: DeviceDescriptorT[]) => void
  ): () => void {
    return watchDecklinkDevices((event) => {
      if (!event || !Array.isArray(event.devices)) {
        return;
      }
      const devices = parseDecklinkHelperDevices(event.devices);
      callback(devices);
    });
  }

  /**
   * Create controller for a DeckLink device.
   */
  createController(deviceId: string): DeviceController {
    return new DecklinkDevice(deviceId);
  }
}
