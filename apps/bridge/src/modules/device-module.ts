import type { DeviceDescriptorT } from "@broadify/protocol";
import type { DecklinkDiagnosticsT } from "./decklink/decklink-helper.js";
import type { DisplayDiagnosticsT } from "./display/display-diagnostics.js";

/**
 * Module diagnostics, discriminated by the owning module kind so consumers
 * can narrow without knowing which module they are talking to.
 */
export type DeviceModuleDiagnosticsT =
  | ({ kind: "decklink" } & DecklinkDiagnosticsT)
  | ({ kind: "display" } & DisplayDiagnosticsT);

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

  /** Optional module-specific detection timeout. */
  readonly detectionTimeoutMs?: number;

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
   * Optional: Return the last module diagnostics captured during detection.
   *
   * Modules without diagnostics support should omit this method. The bridge
   * uses this metadata for additive health fields on output discovery views.
   */
  getLastDiagnostics?(): DeviceModuleDiagnosticsT | null;

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
