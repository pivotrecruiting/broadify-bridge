import type {
  DeviceDescriptorT,
  PortDescriptorT,
} from "../../../../../types.js";
import type { DecklinkDeviceInfo, DecklinkPortInfo } from "./decklink-types.js";

/**
 * Decklink Detector
 *
 * Discovery implementation for Blackmagic Decklink cards.
 * Uses Blackmagic Desktop Video SDK (BMD SDK) for device enumeration.
 *
 * IMPORTANT: Must use BMD SDK, NOT OS APIs (AVFoundation/DirectShow)
 */
export class DecklinkDetector {
  /**
   * Detect Decklink devices using BMD SDK
   *
   * TODO: Implement BMD SDK integration
   * - Use Blackmagic Desktop Video SDK
   * - Enumerate devices
   * - Get device capabilities
   * - Detect ports (SDI-A, SDI-B, HDMI-OUT, etc.)
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    // BMD SDK detection will be implemented here
    // For now, return empty array (no mock data)

    const devices: DeviceDescriptorT[] = [];

    // Example structure for future implementation:
    //
    // const bmdDevices = await this.detectBMDDevices();
    // for (const deviceInfo of bmdDevices) {
    //   const ports = await this.detectPorts(deviceInfo);
    //   devices.push({
    //     id: deviceInfo.id,
    //     displayName: deviceInfo.displayName,
    //     type: "decklink",
    //     vendor: deviceInfo.vendor,
    //     model: deviceInfo.model,
    //     driver: deviceInfo.driver,
    //     ports: ports.map(portInfo => this.createPortDescriptor(portInfo)),
    //     status: {
    //       present: true,
    //       inUse: false, // Check via BMD SDK if device is in use
    //       ready: true,  // Check if device can be opened
    //       lastSeen: Date.now(),
    //     },
    //   });
    // }

    return devices;
  }

  /**
   * Detect devices using BMD SDK
   *
   * TODO: Implement BMD SDK device enumeration
   */
  // @ts-expect-error - Method will be used when BMD SDK is implemented
  private async detectBMDDevices(): Promise<DecklinkDeviceInfo[]> {
    // BMD SDK device enumeration will be implemented here
    // This requires:
    // - BMD SDK native libraries
    // - Platform-specific bindings
    // - Device enumeration API calls
    return [];
  }

  /**
   * Detect ports for a Decklink device
   *
   * TODO: Implement port detection via BMD SDK
   */

  // @ts-expect-error - Method will be used when BMD SDK is implemented
  private async detectPorts(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _device: DecklinkDeviceInfo
  ): Promise<DecklinkPortInfo[]> {
    // BMD SDK port detection will be implemented here
    // Decklink cards can have multiple ports:
    // - SDI-A (input/output)
    // - SDI-B (input/output)
    // - HDMI-OUT (output only)
    // - etc.
    return [];
  }

  /**
   * Create port descriptor from port info
   */
  // @ts-expect-error - Method will be used when BMD SDK is implemented
  private createPortDescriptor(portInfo: DecklinkPortInfo): PortDescriptorT {
    return {
      id: portInfo.id,
      displayName: portInfo.displayName,
      type: portInfo.type,
      direction: portInfo.direction,
      capabilities: {
        formats: [], // TODO: Get supported formats from BMD SDK
      },
      status: {
        available: true, // TODO: Check actual availability via BMD SDK
      },
    };
  }
}
