/**
 * Decklink device types
 */

/**
 * Decklink device information from BMD SDK
 */
export interface DecklinkDeviceInfo {
  id: string; // Stable device ID (model+index or hash from vendorId+deviceId+serial)
  displayName: string;
  vendor: string;
  model: string;
  driver?: string;
  deviceIndex: number;
  // BMD SDK specific fields will be added here
}

/**
 * Decklink port information
 */
export interface DecklinkPortInfo {
  id: string; // Stable port ID (deviceId + portIndex)
  displayName: string; // e.g. "SDI-A", "SDI-B", "HDMI-OUT"
  type: "sdi" | "hdmi";
  direction: "input" | "output" | "bidirectional";
  index: number;
  // BMD SDK specific port capabilities will be added here
}

