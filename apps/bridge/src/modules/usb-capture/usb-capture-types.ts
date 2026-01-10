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
  protocol?: "usb" | "thunderbolt" | "displayport"; // Protocol used by the device
  connectionType?: "usb-c" | "usb-a" | "thunderbolt"; // Physical connector type
}

/**
 * Platform-specific port information
 */
export interface USBPortInfo {
  id: string; // Stable port ID (deviceId + portIndex)
  displayName: string;
  type: "usb" | "thunderbolt" | "displayport"; // Port type based on protocol
  direction: "input" | "output" | "bidirectional";
  index: number;
  formats?: string[]; // Supported video formats (e.g., "1080p60", "4K30")
}

