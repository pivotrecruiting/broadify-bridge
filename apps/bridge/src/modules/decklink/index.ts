import type { DeviceModule, DeviceController } from "../device-module.js";
import type { DeviceDescriptorT } from "@broadify/protocol";
import { DecklinkDetector, parseDecklinkHelperDevices } from "./decklink-detector.js";
import { DecklinkDevice } from "./decklink-device.js";
import {
  type DecklinkDiagnosticsT,
  watchDecklinkDevices,
} from "./decklink-helper.js";
import { getBridgeContext } from "../../services/bridge-context.js";

/**
 * DeckLink Device Module (macOS-only).
 */
export class DecklinkModule implements DeviceModule {
  readonly name = "decklink";
  readonly detectionTimeoutMs = 12_000;
  private readonly detector = new DecklinkDetector();

  /**
   * Detect DeckLink devices.
   *
   * @returns Array of DeckLink device descriptors.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    return this.detector.detect();
  }

  getLastDiagnostics(): DecklinkDiagnosticsT | null {
    return this.detector.getLastDiagnostics();
  }

  /**
   * Watch for DeckLink device changes.
   *
   * @param callback Called with updated device list.
   * @returns Unsubscribe function.
   */
  watch(
    callback: (devices: DeviceDescriptorT[]) => void
  ): () => void {
    return watchDecklinkDevices((event) => {
      if (!event || !Array.isArray(event.devices)) {
        return;
      }
      const devices = parseDecklinkHelperDevices(event.devices);
      if (event.type === "device_added" || event.type === "device_removed") {
        this.detector.invalidateModeCache();
      }
      const logger = getBridgeContext().logger;
      const deviceNames = devices
        .map((device) => device.displayName || device.id)
        .filter(Boolean)
        .join(", ");
      logger.info(
        `[DecklinkModule] Event ${event.type} (${devices.length} device${devices.length === 1 ? "" : "s"}${deviceNames ? `: ${deviceNames}` : ""})`
      );
      callback(devices);
    });
  }

  /**
   * Create controller for a DeckLink device.
   *
   * @param deviceId DeckLink device identifier.
   * @returns Device controller instance.
   */
  createController(deviceId: string): DeviceController {
    return new DecklinkDevice(deviceId);
  }
}
