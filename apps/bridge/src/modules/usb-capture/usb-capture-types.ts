/**
 * USB Capture device types
 */

/**
 * Platform-specific device information
 */
export interface USBDeviceInfo {
  id: string; // Stable device ID (persistent device path / registry id)
  displayName: string;
  vendor?: string;
  model?: string;
  driver?: string;
  path: string; // Platform-specific device path
}

/**
 * Platform-specific port information
 */
export interface USBPortInfo {
  id: string; // Stable port ID (deviceId + portIndex)
  displayName: string;
  type: "usb";
  direction: "input" | "output" | "bidirectional";
  index: number;
}

