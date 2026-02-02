import type { DeviceModule, DeviceController } from "../device-module.js";
import type { DeviceDescriptorT } from "@broadify/protocol";
import { USBCaptureDetector } from "./usb-capture-detector.js";
import { USBCaptureDevice } from "./usb-capture-device.js";

/**
 * USB Capture Device Module
 * 
 * Implements DeviceModule interface for USB Capture devices.
 * Platform-specific detection: AVFoundation (macOS), Media Foundation (Windows), v4l2 (Linux)
 */
export class USBCaptureModule implements DeviceModule {
  readonly name = "usb-capture";
  private detector: USBCaptureDetector;

  constructor() {
    this.detector = new USBCaptureDetector();
  }

  /**
   * Detect USB capture devices.
   *
   * @returns Array of detected device descriptors.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    return this.detector.detect();
  }

  /**
   * Create controller for a USB capture device.
   *
   * @param deviceId USB capture device identifier.
   * @returns Device controller instance.
   */
  createController(deviceId: string): DeviceController {
    return new USBCaptureDevice(deviceId);
  }
}
