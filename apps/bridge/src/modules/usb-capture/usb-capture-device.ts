import { platform } from "node:os";
import { access, constants } from "node:fs/promises";
import type { DeviceController } from "../device-module.js";
import type { DeviceStatusT } from "@broadify/protocol";

/**
 * USB Capture Device Controller
 *
 * Runtime operations for USB Capture devices.
 * Provides exclusive access and device control.
 */
export class USBCaptureDevice implements DeviceController {
  private deviceId: string;
  private isOpen = false;
  private devicePath?: string;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  /**
   * Open device exclusively
   */
  async open(): Promise<void> {
    if (this.isOpen) {
      throw new Error(`Device ${this.deviceId} is already open`);
    }

    const platformType = platform();

    try {
      switch (platformType) {
        case "darwin":
          await this.openMacOSDevice();
          break;
        case "win32":
          await this.openWindowsDevice();
          break;
        case "linux":
          await this.openLinuxDevice();
          break;
        default:
          throw new Error(`Unsupported platform: ${platformType}`);
      }

      this.isOpen = true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to open device ${this.deviceId}: ${errorMessage}`
      );
    }
  }

  /**
   * Close device and release exclusive access
   */
  async close(): Promise<void> {
    if (!this.isOpen) {
      return;
    }

    const platformType = platform();

    try {
      switch (platformType) {
        case "darwin":
          await this.closeMacOSDevice();
          break;
        case "win32":
          await this.closeWindowsDevice();
          break;
        case "linux":
          await this.closeLinuxDevice();
          break;
      }
    } catch (error) {
      console.warn(
        `[USBCaptureDevice] Error closing device ${this.deviceId}:`,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.isOpen = false;
      this.devicePath = undefined;
    }
  }

  /**
   * Get current device status
   */
  async getStatus(): Promise<DeviceStatusT> {
    const platformType = platform();
    const baseStatus: DeviceStatusT = {
      present: false,
      inUse: false,
      ready: false,
      lastSeen: Date.now(),
    };

    try {
      switch (platformType) {
        case "darwin":
          return await this.getMacOSStatus();
        case "win32":
          return await this.getWindowsStatus();
        case "linux":
          return await this.getLinuxStatus();
        default:
          return baseStatus;
      }
    } catch (error) {
      console.debug(
        `[USBCaptureDevice] Error getting status for device ${this.deviceId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return baseStatus;
    }
  }

  /**
   * macOS device opening
   * TODO: Implement AVFoundation device opening via FFI
   */
  private async openMacOSDevice(): Promise<void> {
    // For now, just verify device exists
    // TODO: Use AVFoundation AVCaptureDevice.open() via FFI
    this.devicePath = undefined; // Will be set when FFI is implemented
  }

  /**
   * macOS device closing
   */
  private async closeMacOSDevice(): Promise<void> {
    // TODO: Release AVFoundation device via FFI
    this.devicePath = undefined;
  }

  /**
   * macOS status checking
   */
  private async getMacOSStatus(): Promise<DeviceStatusT> {
    // TODO: Check device presence via AVFoundation
    return {
      present: true,
      inUse: false,
      ready: this.isOpen,
      lastSeen: Date.now(),
    };
  }

  /**
   * Windows device opening
   * TODO: Implement Media Foundation device opening via FFI
   */
  private async openWindowsDevice(): Promise<void> {
    // For now, just verify device exists
    // TODO: Use Media Foundation IMFMediaSource.ActivateObject() via FFI
    this.devicePath = undefined; // Will be set when FFI is implemented
  }

  /**
   * Windows device closing
   */
  private async closeWindowsDevice(): Promise<void> {
    // TODO: Release Media Foundation device via FFI
    this.devicePath = undefined;
  }

  /**
   * Windows status checking
   */
  private async getWindowsStatus(): Promise<DeviceStatusT> {
    // TODO: Check device presence via Media Foundation
    return {
      present: true,
      inUse: false,
      ready: this.isOpen,
      lastSeen: Date.now(),
    };
  }

  /**
   * Linux device opening
   * Opens v4l2 device file for exclusive access
   */
  private async openLinuxDevice(): Promise<void> {
    // Extract device path from deviceId or use default pattern
    // Device ID format: usb-capture-<hash>
    // We need to find the actual /dev/video* path
    // For now, we'll try to find it by checking if device is still present
    // TODO: Store device path in device descriptor for direct access

    // Check if device file exists and is accessible
    // This is a simplified check - full implementation would use v4l2 APIs
    const possiblePaths = [
      `/dev/video0`,
      `/dev/video1`,
      `/dev/video2`,
      `/dev/video3`,
    ];

    for (const path of possiblePaths) {
      try {
        await access(path, constants.R_OK | constants.W_OK);
        this.devicePath = path;
        // TODO: Actually open device file and lock it for exclusive access
        // This requires v4l2 API calls or file locking
        return;
      } catch {
        // Device not accessible, try next
        continue;
      }
    }

    throw new Error(`Device ${this.deviceId} not found or not accessible`);
  }

  /**
   * Linux device closing
   */
  private async closeLinuxDevice(): Promise<void> {
    // TODO: Close v4l2 device file and release lock
    this.devicePath = undefined;
  }

  /**
   * Linux status checking
   */
  private async getLinuxStatus(): Promise<DeviceStatusT> {
    if (!this.devicePath) {
      return {
        present: false,
        inUse: false,
        ready: false,
        lastSeen: Date.now(),
      };
    }

    try {
      // Check if device file is still accessible
      await access(this.devicePath, constants.R_OK);
      return {
        present: true,
        inUse: !this.isOpen, // If we have it open, it's not in use by others
        ready: this.isOpen,
        lastSeen: Date.now(),
      };
    } catch {
      return {
        present: false,
        inUse: false,
        ready: false,
        lastSeen: Date.now(),
      };
    }
  }
}
