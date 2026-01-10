import type { DeviceController } from "../device-module.js";
import type { DeviceDescriptorT } from "../../types.js";

/**
 * DeckLink device controller (placeholder).
 */
export class DecklinkDevice implements DeviceController {
  private readonly deviceId: string;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  /**
   * Open device exclusively.
   */
  async open(): Promise<void> {
    // TODO: Implement exclusive open via helper process or direct SDK binding.
    console.info(`[DecklinkDevice] open requested for ${this.deviceId}`);
  }

  /**
   * Close device and release exclusive access.
   */
  async close(): Promise<void> {
    // TODO: Implement close via helper process or direct SDK binding.
    console.info(`[DecklinkDevice] close requested for ${this.deviceId}`);
  }

  /**
   * Get current device status.
   */
  async getStatus(): Promise<DeviceDescriptorT["status"]> {
    // TODO: Query real-time status from helper.
    return {
      present: true,
      inUse: false,
      ready: true,
      signal: "none",
      lastSeen: Date.now(),
    };
  }
}
