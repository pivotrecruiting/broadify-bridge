import type { DeviceDescriptorT } from "@broadify/protocol";

/**
 * Unsubscribe function for device watch callbacks
 */
export type UnsubscribeFunction = () => void;

/**
 * Device controller interface for runtime operations
 */
export interface DeviceController {
  /**
   * Open device exclusively
   */
  open(): Promise<void>;

  /**
   * Close device and release exclusive access
   */
  close(): Promise<void>;

  /**
   * Get current device status
   */
  getStatus(): Promise<DeviceDescriptorT["status"]>;

  /**
   * Device-specific commands can be added here
   */
}

/**
 * Device module interface
 * 
 * Each device type (USB Capture, etc.) implements this interface
 */
export interface DeviceModule {
  /**
   * Module name/identifier
   */
  readonly name: string;

  /**
   * Discovery: Detect available devices
   * 
   * This should be fast, safe, and non-blocking.
   * Must not lock devices or open exclusive access.
   * 
   * @returns Array of detected device descriptors
   */
  detect(): Promise<DeviceDescriptorT[]>;

  /**
   * Optional: Watch for device hotplug events
   * 
   * If supported by the platform/SDK, this allows real-time
   * device addition/removal notifications.
   * 
   * @param callback Function called when devices change
   * @returns Unsubscribe function
   */
  watch?(
    callback: (devices: DeviceDescriptorT[]) => void
  ): UnsubscribeFunction;

  /**
   * Create a controller for a specific device
   * 
   * The controller provides exclusive access and runtime operations.
   * Only create controllers when actually using a device.
   * 
   * @param deviceId Stable device ID from detect()
   * @returns Device controller instance
   * @throws Error if device not found or cannot be opened
   */
  createController(deviceId: string): DeviceController;
}

