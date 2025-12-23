import type { OutputDeviceT, BridgeOutputsT } from "../../../types.js";

/**
 * Discover available output devices
 * 
 * This function detects real hardware devices available on the system.
 * Currently returns empty arrays as device modules are not yet implemented.
 * 
 * TODO: Implement actual device detection when device modules are available:
 * - Decklink Cards (Blackmagic SDK)
 * - USB Capture Devices (v4l2 on Linux, AVFoundation on macOS, DirectShow on Windows)
 * - Connection types can be detected based on available hardware
 */
export async function discoverOutputs(): Promise<BridgeOutputsT> {
  // TODO: Implement actual device detection
  // For now, return empty arrays until device modules are implemented
  // This ensures no mock data is used and the UI shows empty state correctly
  
  const output1Devices: OutputDeviceT[] = [];
  const output2Devices: OutputDeviceT[] = [];

  // Example structure for future implementation:
  // 
  // For Output1 (Decklink Cards, USB Capture):
  // - Use Blackmagic Desktop Video SDK to detect Decklink cards
  // - Use platform-specific APIs (v4l2/AVFoundation/DirectShow) for USB capture
  // - Check device availability and capabilities
  //
  // For Output2 (Connection Types):
  // - Detect available connection types based on detected hardware
  // - SDI: Available if Decklink card detected
  // - HDMI: Available if HDMI-capable device detected
  // - USB: Available if USB capture device detected
  // - DisplayPort/Thunderbolt: Detect via system APIs

  return {
    output1: output1Devices,
    output2: output2Devices,
  };
}

