import type {
  DeviceDescriptorT,
  PortDescriptorT,
} from "../../../../../types.js";
import type { USBDeviceInfo, USBPortInfo } from "./usb-capture-types.js";

/**
 * USB Capture Detector
 *
 * Discovery implementation for USB Capture devices.
 * Platform-specific detection will be implemented in separate files.
 */
export class USBCaptureDetector {
  /**
   * Detect USB capture devices
   *
   * Platform-specific implementations:
   * - macOS: AVFoundation (AVCaptureDevice)
   * - Windows: Media Foundation (not DirectShow - deprecated)
   * - Linux: v4l2 (Video4Linux2)
   *
   * TODO: Implement platform-specific detection
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    // Platform-specific detection will be implemented here
    // For now, return empty array (no mock data)

    const devices: DeviceDescriptorT[] = [];

    // Example structure for future implementation:
    //
    // const platformDevices = await this.detectPlatformDevices();
    // for (const deviceInfo of platformDevices) {
    //   const ports = await this.detectPorts(deviceInfo);
    //   devices.push({
    //     id: deviceInfo.id,
    //     displayName: deviceInfo.displayName,
    //     type: "usb-capture",
    //     vendor: deviceInfo.vendor,
    //     model: deviceInfo.model,
    //     driver: deviceInfo.driver,
    //     ports: ports.map(portInfo => this.createPortDescriptor(portInfo)),
    //     status: {
    //       present: true,
    //       inUse: false, // Check if device is in use
    //       ready: true,  // Check if device can be opened
    //       lastSeen: Date.now(),
    //     },
    //   });
    // }

    return devices;
  }

  /**
   * Platform-specific device detection
   *
   * TODO: Implement for each platform
   */
  private async detectPlatformDevices(): Promise<USBDeviceInfo[]> {
    // Platform detection will be implemented here
    return [];
  }

  /**
   * Detect ports for a device
   *
   * TODO: Implement port detection
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async detectPorts(_device: USBDeviceInfo): Promise<USBPortInfo[]> {
    // Port detection will be implemented here
    return [];
  }

  /**
   * Create port descriptor from port info
   */
  private createPortDescriptor(portInfo: USBPortInfo): PortDescriptorT {
    return {
      id: portInfo.id,
      displayName: portInfo.displayName,
      type: "usb",
      direction: portInfo.direction,
      capabilities: {
        formats: [], // TODO: Detect supported formats
      },
      status: {
        available: true, // TODO: Check actual availability
      },
    };
  }
}
