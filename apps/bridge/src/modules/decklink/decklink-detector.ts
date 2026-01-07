import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { DeviceDescriptorT, PortDescriptorT } from "../../types.js";
import { resolveFfmpegPath } from "../../utils/ffmpeg-path.js";
import type { DecklinkDeviceInfo, DecklinkPortInfo } from "./decklink-types.js";

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

    const [deviceList, sourceDevices, sinkDevices] = await Promise.all([
      this.listFfmpegDevices(ffmpegPath),
      this.listFfmpegSourceDevices(ffmpegPath),
      this.listFfmpegSinkDevices(ffmpegPath),
    ]);
    if (deviceList.length === 0) {
      return devices;
    }

    const sourceSet = new Set(
      sourceDevices.map((name) => this.normalizeDeviceName(name))
    );
    const sinkSet = new Set(
      sinkDevices.map((name) => this.normalizeDeviceName(name))
    );

    // Process each device
    for (let index = 0; index < deviceList.length; index++) {
      const deviceName = deviceList[index];
      const portDirection = this.inferDeviceDirection(
        deviceName,
        sourceSet,
        sinkSet
      );
      const deviceId = this.generateDeviceId(deviceName, index);
      const ports = await this.detectPortsViaFfmpeg(
        ffmpegPath,
        deviceName,
        deviceId,
        portDirection
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

        // Check if FFmpeg has DeckLink support
        const hasNoDeckLinkSupport =
          stderr.includes("Unknown input format: decklink") ||
          stderr.includes("No such filter or encoder: decklink") ||
          stderr.includes("Invalid data found when processing input");

        if (hasNoDeckLinkSupport) {
          console.warn(
            `[DecklinkDetector] FFmpeg does not have DeckLink support. ` +
              `The FFmpeg binary at "${ffmpegPath}" was not compiled with --enable-decklink. ` +
              `Please use a FFmpeg build with DeckLink support (e.g., Blackmagic's FFmpeg build) ` +
              `or compile FFmpeg with --enable-decklink. ` +
              `FFmpeg output: ${stderr.substring(0, 300)}`
          );
          resolve([]);
          return;
        }

        // FFmpeg returns non-zero exit code for list_devices, this is normal
        const devices = this.parseFfmpegDevices(stderr);

        if (devices.length === 0) {
          // Log FFmpeg output for debugging when no devices found
          const outputPreview = stderr
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .slice(0, 5)
            .join("\n");
          console.info(
            `[DecklinkDetector] No DeckLink devices found. ` +
              `This is normal if no DeckLink hardware is connected. ` +
              `FFmpeg output preview:\n${outputPreview}`
          );
        } else {
          console.info(
            `[DecklinkDetector] Found ${devices.length} DeckLink device(s)`
          );
        }

        resolve(devices);
      });

      process.on("error", (error) => {
        clearTimeout(timeout);
        console.error(
          `[DecklinkDetector] Failed to spawn FFmpeg process: ${error.message}. ` +
            `FFmpeg path: "${ffmpegPath}"`
        );
        reject(error);
      });
    });
  }

  /**
   * List DeckLink input devices using FFmpeg sources
   */
  private async listFfmpegSourceDevices(ffmpegPath: string): Promise<string[]> {
    return this.listFfmpegDeviceNames(ffmpegPath, "-sources");
  }

  /**
   * List DeckLink output devices using FFmpeg sinks
   */
  private async listFfmpegSinkDevices(ffmpegPath: string): Promise<string[]> {
    return this.listFfmpegDeviceNames(ffmpegPath, "-sinks");
  }

  private async listFfmpegDeviceNames(
    ffmpegPath: string,
    flag: "-sources" | "-sinks"
  ): Promise<string[]> {
    return new Promise((resolve) => {
      const process = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        flag,
        "decklink",
      ]);

      let output = "";
      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve([]);
      }, 3000);

      process.stdout.on("data", (data) => {
        output += data.toString();
      });

      process.stderr.on("data", (data) => {
        output += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);
        resolve(this.parseFfmpegDeviceNames(output));
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve([]);
      });
    });
  }

  private parseFfmpegDeviceNames(output: string): string[] {
    const devices: string[] = [];
    const lines = output.split("\n");

    for (const line of lines) {
      const quoted = line.match(/"([^"]+)"/);
      if (quoted?.[1]) {
        const deviceName = quoted[1].trim();
        if (deviceName && !devices.includes(deviceName)) {
          devices.push(deviceName);
        }
        continue;
      }

      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith("[") ||
        trimmed.endsWith(":") ||
        trimmed.toLowerCase().includes("sources") ||
        trimmed.toLowerCase().includes("sinks") ||
        /unrecognized option|unknown option|invalid|error/i.test(trimmed)
      ) {
        continue;
      }

      if (!devices.includes(trimmed)) {
        devices.push(trimmed);
      }
    }

    return devices;
  }

  private normalizeDeviceName(name: string): string {
    return name.trim().toLowerCase();
  }

  private inferDeviceDirection(
    deviceName: string,
    sources: Set<string>,
    sinks: Set<string>
  ): PortDescriptorT["direction"] {
    const normalizedName = this.normalizeDeviceName(deviceName);
    const isSource = sources.has(normalizedName);
    const isSink = sinks.has(normalizedName);

    if (isSource && isSink) {
      return "bidirectional";
    }
    if (isSource) {
      return "input";
    }
    if (isSink) {
      return "output";
    }

    const lowerName = normalizedName;
    const looksInput =
      lowerName.includes("recorder") ||
      lowerName.includes("capture") ||
      lowerName.includes("input");
    const looksOutput =
      lowerName.includes("monitor") ||
      lowerName.includes("output") ||
      lowerName.includes("playback");

    if (looksInput && !looksOutput) {
      return "input";
    }
    if (looksOutput && !looksInput) {
      return "output";
    }

    return "bidirectional";
  }

  private formatPortDisplayName(
    type: "sdi" | "hdmi",
    direction: PortDescriptorT["direction"],
    index: number
  ): string {
    const typeLabel = type.toUpperCase();
    const directionLabel =
      direction === "bidirectional"
        ? "I/O"
        : direction === "input"
          ? "Input"
          : "Output";
    return `${typeLabel} ${directionLabel} ${index + 1}`;
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
    deviceId: string,
    portDirection: PortDescriptorT["direction"]
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
        const ports = this.parseFfmpegPorts(
          stderr,
          deviceId,
          deviceName,
          portDirection
        );
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
   * FFmpeg output format varies, but we try to detect:
   * - Port indices (0, 1, 2, etc.)
   * - Port types (SDI, HDMI)
   * - Supported formats and resolutions
   *
   * For devices like UltraStudio HD Mini:
   * - Port 0: SDI Output 1
   * - Port 1: SDI Output 2
   * - Port 2: HDMI Output (if available)
   *
   * FFmpeg supports port selection via: "Device Name@portIndex"
   */
  private parseFfmpegPorts(
    stderr: string,
    deviceId: string,
    deviceName: string,
    portDirection: PortDescriptorT["direction"]
  ): PortDescriptorT[] {
    const ports: PortDescriptorT[] = [];
    const lines = stderr.split("\n");
    const lowerStderr = stderr.toLowerCase();

    // Try to detect port information from FFmpeg output
    // FFmpeg may show port indices or port types in the output
    const detectedPorts = new Map<
      number,
      { type: "sdi" | "hdmi"; name: string }
    >();

    // Look for port patterns in FFmpeg output
    // Common patterns:
    // - "SDI" or "HDMI" mentions
    // - Port indices (0, 1, 2, etc.)
    // - Format listings that may indicate ports

    // Check for explicit port mentions
    for (const line of lines) {
      const lowerLine = line.toLowerCase();

      // Look for port index patterns (e.g., "port 0", "@0", "[0]")
      const portIndexMatch = line.match(/port\s+(\d+)|@(\d+)|\[(\d+)\]/i);
      if (portIndexMatch) {
        if (!lowerLine.includes("hdmi") && !lowerLine.includes("sdi")) {
          continue;
        }
        const portIndex = parseInt(
          portIndexMatch[1] || portIndexMatch[2] || portIndexMatch[3] || "0",
          10
        );

        // Determine port type from context
        let portType: "sdi" | "hdmi" = "sdi";
        let portName = `Port ${portIndex}`;

        if (lowerLine.includes("hdmi")) {
          portType = "hdmi";
          portName = this.formatPortDisplayName(
            portType,
            portDirection,
            portIndex
          );
        } else if (lowerLine.includes("sdi")) {
          portType = "sdi";
          portName = this.formatPortDisplayName(
            portType,
            portDirection,
            portIndex
          );
        }

        detectedPorts.set(portIndex, { type: portType, name: portName });
      }
    }

    // If we found explicit ports, use them
    if (detectedPorts.size > 0) {
      for (const [index, portInfo] of detectedPorts.entries()) {
        ports.push({
          id: `${deviceId}-${portInfo.type}-${index}`,
          displayName: portInfo.name,
          type: portInfo.type,
          direction: portDirection,
          capabilities: {
            formats: this.extractFormatsFromOutput(stderr),
          },
          status: {
            available: true,
          },
        });
      }
    } else {
      // Fallback: Use heuristics based on device model and common configurations
      // UltraStudio HD Mini has 2x SDI + 1x HDMI
      const lowerDeviceName = deviceName.toLowerCase();
      const isUltraStudioMini =
        (lowerStderr.includes("ultrastudio") && lowerStderr.includes("mini")) ||
        (lowerDeviceName.includes("ultrastudio") &&
          lowerDeviceName.includes("mini"));

      if (isUltraStudioMini) {
        // UltraStudio HD Mini: 2x SDI Outputs + 1x HDMI
        ports.push({
          id: `${deviceId}-sdi-0`,
          displayName: this.formatPortDisplayName("sdi", portDirection, 0),
          type: "sdi",
          direction: portDirection,
          capabilities: {
            formats: this.extractFormatsFromOutput(stderr),
          },
          status: {
            available: true,
          },
        });
        ports.push({
          id: `${deviceId}-sdi-1`,
          displayName: this.formatPortDisplayName("sdi", portDirection, 1),
          type: "sdi",
          direction: portDirection,
          capabilities: {
            formats: this.extractFormatsFromOutput(stderr),
          },
          status: {
            available: true,
          },
        });
        ports.push({
          id: `${deviceId}-hdmi-0`,
          displayName: this.formatPortDisplayName("hdmi", portDirection, 0),
          type: "hdmi",
          direction: portDirection,
          capabilities: {
            formats: this.extractFormatsFromOutput(stderr),
          },
          status: {
            available: true,
          },
        });
      } else {
        // Generic detection: Check for SDI/HDMI mentions
        const hasHdmi = lowerStderr.includes("hdmi");

        // Try to detect multiple SDI ports
        // Common pattern: devices with multiple SDI ports
        const sdiCount = this.countPortMentions(stderr, "sdi");
        const hdmiCount = this.countPortMentions(stderr, "hdmi");

        // Add SDI ports
        for (let i = 0; i < Math.max(1, sdiCount); i++) {
          ports.push({
            id: `${deviceId}-sdi-${i}`,
            displayName: this.formatPortDisplayName("sdi", portDirection, i),
            type: "sdi",
            direction: portDirection,
            capabilities: {
              formats: this.extractFormatsFromOutput(stderr),
            },
            status: {
              available: true,
            },
          });
        }

        // Add HDMI port if detected
        if (hasHdmi) {
          for (let i = 0; i < Math.max(1, hdmiCount); i++) {
            ports.push({
              id: `${deviceId}-hdmi-${i}`,
              displayName: this.formatPortDisplayName(
                "hdmi",
                portDirection,
                i
              ),
              type: "hdmi",
              direction: portDirection,
              capabilities: {
                formats: this.extractFormatsFromOutput(stderr),
              },
              status: {
                available: true,
              },
            });
          }
        }

        // If no ports detected, create at least one default SDI port
        if (ports.length === 0) {
          ports.push({
            id: `${deviceId}-sdi-0`,
            displayName: this.formatPortDisplayName("sdi", portDirection, 0),
            type: "sdi",
            direction: portDirection,
            capabilities: {
              formats: [],
            },
            status: {
              available: true,
            },
          });
        }
      }
    }

    return ports;
  }

  /**
   * Extract supported formats from FFmpeg output
   *
   * Looks for format strings like "1080p60", "1080p30", "2K DCI", etc.
   */
  private extractFormatsFromOutput(stderr: string): string[] {
    const formats: string[] = [];
    const lines = stderr.split("\n");

    // Common format patterns
    const formatPatterns = [
      /(\d+p\d+)/i, // 1080p60, 720p50, etc.
      /(\d+k\s+dci)/i, // 2K DCI
      /(\d+k)/i, // 4K, 2K
      /(ntsc|pal)/i, // NTSC, PAL
    ];

    for (const line of lines) {
      for (const pattern of formatPatterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          const format = match[1].trim();
          if (!formats.includes(format)) {
            formats.push(format);
          }
        }
      }
    }

    return formats;
  }

  /**
   * Count port mentions in FFmpeg output
   *
   * Tries to estimate number of ports by counting mentions
   */
  private countPortMentions(stderr: string, portType: string): number {
    const lowerStderr = stderr.toLowerCase();
    const lowerType = portType.toLowerCase();

    // Count explicit mentions
    const mentions = (lowerStderr.match(new RegExp(lowerType, "gi")) || [])
      .length;

    // If multiple mentions, likely multiple ports
    // For UltraStudio HD Mini: 2 SDI ports
    if (mentions >= 2 && lowerType === "sdi") {
      return 2;
    }

    return mentions > 0 ? 1 : 0;
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
