import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DeviceDescriptorT, PortDescriptorT } from "../../types.js";
import type { DecklinkDeviceInfo, DecklinkPortInfo } from "./decklink-types.js";

/**
 * Resolve FFmpeg executable path
 *
 * Priority:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled FFmpeg in production (from resources/ffmpeg)
 * 3. System FFmpeg (fallback)
 */
function resolveFfmpegPath(): string {
  // Check environment variable first
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }

  // In production, use bundled FFmpeg from resources
  // process.resourcesPath is set by Electron and points to the resources directory
  if (
    process.env.NODE_ENV === "production" &&
    typeof process.resourcesPath !== "undefined"
  ) {
    const platform = process.platform;
    const arch = process.arch;

    let platformDir = "";
    if (platform === "darwin") {
      platformDir = arch === "arm64" ? "mac-arm64" : "mac-x64";
    } else if (platform === "win32") {
      platformDir = "win";
    } else if (platform === "linux") {
      platformDir = "linux";
    }

    if (platformDir) {
      const bundledPath = path.join(
        process.resourcesPath,
        "ffmpeg",
        platformDir,
        platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
      );

      // Check if bundled FFmpeg exists
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }
  }

  // Fallback to system FFmpeg
  return "ffmpeg";
}

/**
 * Decklink Detector
 *
 * Discovery implementation for Blackmagic Decklink cards.
 * Uses FFmpeg for device enumeration (Phase 1).
 * Future: BMD SDK integration for full feature support.
 */
export class DecklinkDetector {
  /**
   * Detect Decklink devices using FFmpeg
   *
   * Falls back to empty array if FFmpeg is not available or has no DeckLink support.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    try {
      const devices = await this.detectViaFfmpeg();
      return devices;
    } catch (error) {
      // Graceful degradation: return empty array on any error
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[DecklinkDetector] Device detection failed: ${errorMessage}`
      );
      return [];
    }
  }

  /**
   * Detect devices using FFmpeg list_devices command
   */
  private async detectViaFfmpeg(): Promise<DeviceDescriptorT[]> {
    const ffmpegPath = resolveFfmpegPath();
    const devices: DeviceDescriptorT[] = [];

    // Run FFmpeg to list DeckLink devices
    const deviceList = await this.listFfmpegDevices(ffmpegPath);
    if (deviceList.length === 0) {
      return devices;
    }

    // Process each device
    for (let index = 0; index < deviceList.length; index++) {
      const deviceName = deviceList[index];
      const deviceId = this.generateDeviceId(deviceName, index);
      const ports = await this.detectPortsViaFfmpeg(
        ffmpegPath,
        deviceName,
        deviceId
      );

      devices.push({
        id: deviceId,
        displayName: deviceName,
        type: "decklink",
        vendor: "Blackmagic Design",
        model: this.extractModelFromName(deviceName),
        ports: ports,
        status: {
          present: true,
          inUse: false, // Cannot determine via FFmpeg
          ready: true, // Assume ready if detected
          lastSeen: Date.now(),
        },
      });
    }

    return devices;
  }

  /**
   * List DeckLink devices using FFmpeg
   */
  private async listFfmpegDevices(ffmpegPath: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const process = spawn(ffmpegPath, [
        "-f",
        "decklink",
        "-list_devices",
        "1",
        "-i",
        "dummy",
      ]);

      let stderr = "";
      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        reject(new Error("FFmpeg device listing timed out"));
      }, 5000);

      process.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);
        // FFmpeg returns non-zero exit code for list_devices, this is normal
        const devices = this.parseFfmpegDevices(stderr);
        resolve(devices);
      });

      process.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Parse device list from FFmpeg stderr output
   *
   * FFmpeg output format:
   * [decklink @ ...] "Device Name" (device-id)
   */
  private parseFfmpegDevices(stderr: string): string[] {
    const devices: string[] = [];
    const lines = stderr.split("\n");

    for (const line of lines) {
      // Match: [decklink @ ...] "Device Name" (optional-id)
      const match = line.match(/\[decklink[^\]]*\]\s+"([^"]+)"/);
      if (match && match[1]) {
        const deviceName = match[1].trim();
        if (deviceName && !devices.includes(deviceName)) {
          devices.push(deviceName);
        }
      }
    }

    return devices;
  }

  /**
   * Detect ports for a device using FFmpeg list_formats
   */
  private async detectPortsViaFfmpeg(
    ffmpegPath: string,
    deviceName: string,
    deviceId: string
  ): Promise<PortDescriptorT[]> {
    return new Promise((resolve) => {
      const process = spawn(ffmpegPath, [
        "-f",
        "decklink",
        "-list_formats",
        "1",
        "-i",
        deviceName,
      ]);

      let stderr = "";
      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve([]);
      }, 3000);

      process.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);
        const ports = this.parseFfmpegPorts(stderr, deviceId);
        resolve(ports);
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve([]);
      });
    });
  }

  /**
   * Parse port information from FFmpeg list_formats output
   *
   * FFmpeg output format varies, but typically includes port information.
   * For now, we'll create default ports based on common DeckLink configurations.
   */
  private parseFfmpegPorts(
    stderr: string,
    deviceId: string
  ): PortDescriptorT[] {
    const ports: PortDescriptorT[] = [];

    // Common DeckLink port configurations
    // Most cards have at least one SDI output
    // We'll create a default SDI output port
    // In the future, this could be enhanced by parsing FFmpeg output more carefully

    // Check if output mentions specific ports
    const hasSdi = stderr.toLowerCase().includes("sdi");
    const hasHdmi = stderr.toLowerCase().includes("hdmi");

    // Create default SDI output port (most common)
    if (hasSdi || !hasHdmi) {
      ports.push({
        id: `${deviceId}-sdi-0`,
        displayName: "SDI Output",
        type: "sdi",
        direction: "output",
        capabilities: {
          formats: [],
        },
        status: {
          available: true,
        },
      });
    }

    // Create HDMI port if mentioned
    if (hasHdmi) {
      ports.push({
        id: `${deviceId}-hdmi-0`,
        displayName: "HDMI Output",
        type: "hdmi",
        direction: "output",
        capabilities: {
          formats: [],
        },
        status: {
          available: true,
        },
      });
    }

    // If no ports detected, create at least one default SDI port
    if (ports.length === 0) {
      ports.push({
        id: `${deviceId}-sdi-0`,
        displayName: "SDI Output",
        type: "sdi",
        direction: "output",
        capabilities: {
          formats: [],
        },
        status: {
          available: true,
        },
      });
    }

    return ports;
  }

  /**
   * Generate stable device ID from device name and index
   *
   * Uses hash of device name + index for stability across restarts.
   */
  private generateDeviceId(deviceName: string, index: number): string {
    const hash = createHash("sha256")
      .update(`${deviceName}-${index}`)
      .digest("hex")
      .substring(0, 8);
    return `decklink-${hash}-${index}`;
  }

  /**
   * Extract model name from device display name
   */
  private extractModelFromName(deviceName: string): string {
    // Try to extract model from common patterns
    // Examples: "DeckLink Mini Recorder", "DeckLink Duo 2", etc.
    const match = deviceName.match(/DeckLink\s+([^"]+)/i);
    if (match && match[1]) {
      return match[1].trim();
    }
    return deviceName;
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
