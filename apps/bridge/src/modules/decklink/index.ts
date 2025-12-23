import type { DeviceModule, DeviceController } from "../device-module.js";
import type { DeviceDescriptorT } from "../../../../../types.js";
import { DecklinkDetector } from "./decklink-detector.js";
import { DecklinkDevice } from "./decklink-device.js";

/**
 * Decklink Device Module
 * 
 * Implements DeviceModule interface for Blackmagic Decklink cards.
 * Uses Blackmagic Desktop Video SDK (BMD SDK) for device detection and control.
 * 
 * IMPORTANT: Must use BMD SDK, NOT OS APIs (AVFoundation/DirectShow)
 */
export class DecklinkModule implements DeviceModule {
  readonly name = "decklink";
  private detector: DecklinkDetector;

  constructor() {
    this.detector = new DecklinkDetector();
  }

  /**
   * Detect Decklink devices using BMD SDK
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    return this.detector.detect();
  }

  /**
   * Create controller for a Decklink device
   */
  createController(deviceId: string): DeviceController {
    return new DecklinkDevice(deviceId);
  }
}

