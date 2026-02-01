import { platform } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { DeviceDescriptorT, PortDescriptorT } from "@broadify/protocol";
import type { USBDeviceInfo, USBPortInfo } from "./usb-capture-types.js";

/**
 * USB Capture Detector
 *
 * Discovery implementation for USB Capture devices.
 * Platform-specific detection: AVFoundation (macOS), Media Foundation (Windows), v4l2 (Linux)
 */
export class USBCaptureDetector {
  /**
   * Detect USB capture devices
   *
   * Platform-specific implementations:
   * - macOS: AVFoundation (AVCaptureDevice)
   * - Windows: Media Foundation (not DirectShow - deprecated)
   * - Linux: v4l2 (Video4Linux2)
   *
   * @returns Array of detected device descriptors.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    try {
      const platformDevices = await this.detectPlatformDevices();
      const devices: DeviceDescriptorT[] = [];

      for (const deviceInfo of platformDevices) {
        const ports = await this.detectPorts(deviceInfo);
        devices.push({
          id: deviceInfo.id,
          displayName: deviceInfo.displayName,
          type: "usb-capture",
          vendor: deviceInfo.vendor,
          model: deviceInfo.model,
          driver: deviceInfo.driver,
          ports: ports.map((portInfo) => this.createPortDescriptor(portInfo)),
          status: {
            present: true,
            inUse: false, // Will be checked when device is opened
            ready: true, // Will be verified when device is opened
            lastSeen: Date.now(),
          },
        });
      }

      if (devices.length > 0) {
        console.info(
          `[USBCaptureDetector] Found ${devices.length} USB capture device(s)`
        );
      }

      return devices;
    } catch (error) {
      // Graceful degradation: return empty array on any error
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `[USBCaptureDetector] Device detection failed: ${errorMessage}`
      );
      return [];
    }
  }

  /**
   * Detect platform and delegate to platform-specific implementation.
   *
   * @returns Raw USB device info list for the current platform.
   */
  private async detectPlatformDevices(): Promise<USBDeviceInfo[]> {
    const platformType = platform();

    switch (platformType) {
      case "darwin":
        return this.detectMacOSDevices();
      case "win32":
        return this.detectWindowsDevices();
      case "linux":
        return this.detectLinuxDevices();
      default:
        console.warn(
          `[USBCaptureDetector] Unsupported platform: ${platformType}`
        );
        return [];
    }
  }

  /**
   * macOS device detection using system commands
   * Uses system_profiler and ioreg for device enumeration
   */
  private async detectMacOSDevices(): Promise<USBDeviceInfo[]> {
    const devices: USBDeviceInfo[] = [];

    try {
      // Get USB devices via system_profiler
      const usbDevices = await this.getSystemProfilerUSBDevices();

      for (const usbDevice of usbDevices) {
        // Check if device is a video capture device
        if (this.isVideoCaptureDevice(usbDevice)) {
          // Get detailed info via ioreg
          const ioregInfo = await this.getIoregInfo(
            usbDevice.vendorId,
            usbDevice.productId
          );

          // Determine protocol and connection type
          const protocol = this.determineMacOSProtocol(usbDevice, ioregInfo);
          const connectionType = this.determineMacOSConnectionType(
            usbDevice,
            ioregInfo
          );

          // Generate stable device ID
          const deviceId = this.generateDeviceId(
            usbDevice.name,
            `${usbDevice.vendorId}-${usbDevice.productId}`
          );

          devices.push({
            id: deviceId,
            displayName: usbDevice.name,
            vendor: usbDevice.vendor,
            model: usbDevice.model,
            driver: usbDevice.driver,
            path: usbDevice.path || "",
            protocol,
            connectionType,
          });
        }
      }
    } catch (error) {
      console.warn(
        `[USBCaptureDetector] macOS device detection failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return devices;
  }

  /**
   * Get USB devices via system_profiler
   */
  private async getSystemProfilerUSBDevices(): Promise<
    Array<{
      name: string;
      vendor?: string;
      model?: string;
      vendorId?: string;
      productId?: string;
      driver?: string;
      path?: string;
    }>
  > {
    return new Promise((resolve) => {
      const process = spawn("system_profiler", ["SPUSBDataType", "-json"]);

      let stdout = "";
      const devices: Array<{
        name: string;
        vendor?: string;
        model?: string;
        vendorId?: string;
        productId?: string;
        driver?: string;
        path?: string;
      }> = [];

      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve(devices);
      }, 5000);

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);

        try {
          const json = JSON.parse(stdout);
          const usbData = json?.SPUSBDataType || [];

          // Recursively extract USB devices
          const extractDevices = (items: unknown[]): void => {
            for (const item of items) {
              const usbItem = item as {
                _name?: string;
                vendor_id?: string;
                product_id?: string;
                manufacturer?: string;
                driver?: string;
                _items?: unknown[];
              };
              if (usbItem._name && (usbItem.vendor_id || usbItem.product_id)) {
                devices.push({
                  name: usbItem._name,
                  vendor: usbItem.manufacturer,
                  model: usbItem._name,
                  vendorId: usbItem.vendor_id,
                  productId: usbItem.product_id,
                  driver: usbItem.driver,
                });
              }
              if (usbItem._items) {
                extractDevices(usbItem._items);
              }
            }
          };

          extractDevices(usbData);
        } catch (error) {
          console.debug(
            `[USBCaptureDetector] Failed to parse system_profiler output:`,
            error instanceof Error ? error.message : String(error)
          );
        }

        resolve(devices);
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve(devices);
      });
    });
  }

  /**
   * Get detailed device info via ioreg
   */
  private async getIoregInfo(
    vendorId?: string,
    productId?: string
  ): Promise<Record<string, string>> {
    if (!vendorId || !productId) {
      return {};
    }

    return new Promise((resolve) => {
      const process = spawn("ioreg", ["-p", "IOUSB", "-w0", "-l"]);

      let stdout = "";

      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve({});
      }, 3000);

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);

        const info: Record<string, string> = {};

        const vendorIdHex = vendorId.toLowerCase().replace("0x", "");
        const productIdHex = productId.toLowerCase().replace("0x", "");

        const lines = stdout.split("\n");
        let vendorMatch = false;
        let productMatch = false;
        let inDevice = false;

        for (const line of lines) {
          if (line.includes("+-o")) {
            if (inDevice) {
              break;
            }
            vendorMatch = false;
            productMatch = false;
            continue;
          }

          if (
            line.includes(`"idVendor" = ${vendorId}`) ||
            line.includes(`"idVendor" = 0x${vendorIdHex}`)
          ) {
            vendorMatch = true;
          }

          if (
            line.includes(`"idProduct" = ${productId}`) ||
            line.includes(`"idProduct" = 0x${productIdHex}`)
          ) {
            productMatch = true;
          }

          if (!inDevice && vendorMatch && productMatch) {
            inDevice = true;
          }

          if (inDevice) {
            if (line.includes("USB-C") || line.includes("Type-C")) {
              info.usbC = "true";
            }
            if (line.includes("Thunderbolt")) {
              info.thunderbolt = "true";
            }
            if (line.includes("DisplayPort") || line.includes("Display Port")) {
              info.displayPort = "true";
            }
          }
        }

        resolve(info);
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve({});
      });
    });
  }

  /**
   * Check if device is a video capture device
   */
  private isVideoCaptureDevice(device: {
    name?: string;
    driver?: string;
  }): boolean {
    const name = (device.name || "").toLowerCase();
    const driver = (device.driver || "").toLowerCase();

    // Common video capture device indicators
    const videoKeywords = [
      "camera",
      "webcam",
      "capture",
      "video",
      "uvc",
      "usb video",
      "hdmi capture",
      "capture card",
    ];

    return (
      videoKeywords.some((keyword) => name.includes(keyword)) ||
      driver.includes("uvc") ||
      driver.includes("video")
    );
  }

  /**
   * Determine protocol from macOS device info
   */
  private determineMacOSProtocol(
    device: { name?: string },
    ioregInfo: Record<string, string>
  ): "usb" | "thunderbolt" | "displayport" {
    const name = (device.name || "").toLowerCase();

    // Check for Thunderbolt
    if (ioregInfo.thunderbolt === "true" || name.includes("thunderbolt")) {
      return "thunderbolt";
    }

    // Check for DisplayPort
    if (
      ioregInfo.displayPort === "true" ||
      name.includes("displayport") ||
      name.includes("display port")
    ) {
      return "displayport";
    }

    // Default to USB
    return "usb";
  }

  /**
   * Determine connection type from macOS device info
   */
  private determineMacOSConnectionType(
    device: { name?: string },
    ioregInfo: Record<string, string>
  ): "usb-c" | "usb-a" | "thunderbolt" {
    const name = (device.name || "").toLowerCase();

    // Check for Thunderbolt
    if (ioregInfo.thunderbolt === "true" || name.includes("thunderbolt")) {
      return "thunderbolt";
    }

    // Check for USB-C
    if (
      ioregInfo.usbC === "true" ||
      name.includes("usb-c") ||
      name.includes("type-c")
    ) {
      return "usb-c";
    }

    // Default to USB-A
    return "usb-a";
  }

  /**
   * Windows device detection using Media Foundation
   * Uses PowerShell and registry queries (FFI can be added later for better control)
   */
  private async detectWindowsDevices(): Promise<USBDeviceInfo[]> {
    const devices: USBDeviceInfo[] = [];

    try {
      // Get video capture devices via PowerShell
      const videoDevices = await this.getPowerShellVideoDevices();

      for (const videoDevice of videoDevices) {
        if (
          videoDevice.deviceId &&
          !videoDevice.deviceId.toLowerCase().startsWith("usb\\")
        ) {
          continue;
        }
        // Get USB info from registry
        const usbInfo = await this.getWindowsUSBInfo(videoDevice.deviceId);

        // Determine protocol and connection type
        const protocol = this.determineWindowsProtocol(videoDevice, usbInfo);
        const connectionType = this.determineWindowsConnectionType(
          videoDevice,
          usbInfo
        );

        // Generate stable device ID
        const deviceId = this.generateDeviceId(
          videoDevice.name,
          videoDevice.deviceId || ""
        );

        devices.push({
          id: deviceId,
          displayName: videoDevice.name,
          vendor: videoDevice.vendor,
          model: videoDevice.model,
          driver: videoDevice.driver,
          path: videoDevice.devicePath || "",
          protocol,
          connectionType,
        });
      }
    } catch (error) {
      console.warn(
        `[USBCaptureDetector] Windows device detection failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return devices;
  }

  /**
   * Get video capture devices via PowerShell
   * Uses Get-PnpDevice to enumerate video capture devices
   */
  private async getPowerShellVideoDevices(): Promise<
    Array<{
      name: string;
      deviceId?: string;
      vendor?: string;
      model?: string;
      driver?: string;
      devicePath?: string;
    }>
  > {
    return new Promise((resolve) => {
      // PowerShell command to get video capture devices
      const psCommand = `
        Get-PnpDevice -Class Camera,Image,Media | 
        Where-Object { $_.Status -eq 'OK' } | 
        Select-Object -Property FriendlyName, InstanceId, Manufacturer, Class |
        ConvertTo-Json -Compress
      `;

      const process = spawn("powershell", ["-Command", psCommand]);

      let stdout = "";
      const devices: Array<{
        name: string;
        deviceId?: string;
        vendor?: string;
        model?: string;
        driver?: string;
        devicePath?: string;
      }> = [];

      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve(devices);
      }, 5000);

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);

        try {
          const json = JSON.parse(stdout);
          const deviceArray = Array.isArray(json) ? json : [json];

          for (const device of deviceArray) {
            if (device.FriendlyName) {
              devices.push({
                name: device.FriendlyName,
                deviceId: device.InstanceId,
                vendor: device.Manufacturer,
                model: device.FriendlyName,
              });
            }
          }
        } catch (error) {
          console.debug(
            `[USBCaptureDetector] Failed to parse PowerShell output:`,
            error instanceof Error ? error.message : String(error)
          );
        }

        resolve(devices);
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve(devices);
      });
    });
  }

  /**
   * Get USB information from Windows registry
   */
  private async getWindowsUSBInfo(
    deviceId?: string
  ): Promise<Record<string, string>> {
    if (!deviceId) {
      return {};
    }

    return new Promise((resolve) => {
      // Extract USB VID/PID from device ID
      // Format: USB\\VID_XXXX&PID_XXXX
      const vidMatch = deviceId.match(/VID_([0-9A-F]{4})/i);
      const pidMatch = deviceId.match(/PID_([0-9A-F]{4})/i);

      const info: Record<string, string> = {};

      if (vidMatch && pidMatch) {
        info.vendorId = vidMatch[1];
        info.productId = pidMatch[1];
      }

      const deviceIdLower = deviceId.toLowerCase();

      // Check for USB-C indicators in device ID
      if (deviceIdLower.includes("usb-c") || deviceIdLower.includes("type-c")) {
        info.usbC = "true";
      }

      // Check for Thunderbolt
      if (deviceIdLower.includes("thunderbolt")) {
        info.thunderbolt = "true";
      }

      // Check for DisplayPort
      if (deviceIdLower.includes("displayport")) {
        info.displayPort = "true";
      }

      resolve(info);
    });
  }

  /**
   * Determine protocol from Windows device info
   */
  private determineWindowsProtocol(
    device: { name?: string },
    usbInfo: Record<string, string>
  ): "usb" | "thunderbolt" | "displayport" {
    const name = (device.name || "").toLowerCase();

    // Check for Thunderbolt
    if (usbInfo.thunderbolt === "true" || name.includes("thunderbolt")) {
      return "thunderbolt";
    }

    // Check for DisplayPort
    if (
      usbInfo.displayPort === "true" ||
      name.includes("displayport") ||
      name.includes("display port")
    ) {
      return "displayport";
    }

    // Default to USB
    return "usb";
  }

  /**
   * Determine connection type from Windows device info
   */
  private determineWindowsConnectionType(
    device: { name?: string },
    usbInfo: Record<string, string>
  ): "usb-c" | "usb-a" | "thunderbolt" {
    const name = (device.name || "").toLowerCase();

    // Check for Thunderbolt
    if (usbInfo.thunderbolt === "true" || name.includes("thunderbolt")) {
      return "thunderbolt";
    }

    // Check for USB-C
    if (
      usbInfo.usbC === "true" ||
      name.includes("usb-c") ||
      name.includes("type-c")
    ) {
      return "usb-c";
    }

    // Default to USB-A
    return "usb-a";
  }

  /**
   * Linux device detection using v4l2
   * Uses /dev/video* enumeration and v4l2-ctl commands
   */
  private async detectLinuxDevices(): Promise<USBDeviceInfo[]> {
    const devices: USBDeviceInfo[] = [];

    try {
      // Scan /dev/video* devices
      const videoDevices = await this.scanVideoDevices();

      for (const videoDevice of videoDevices) {
        try {
          // Get device info via v4l2-ctl
          const deviceInfo = await this.getV4L2DeviceInfo(videoDevice);
          if (deviceInfo) {
            // Get USB info via udevadm
            const usbInfo = await this.getUdevInfo(videoDevice);

            // Determine protocol and connection type
            if (
              usbInfo.bus &&
              !["usb", "thunderbolt"].includes(usbInfo.bus)
            ) {
              continue;
            }

            const protocol = this.determineProtocol(usbInfo);
            const connectionType = this.determineConnectionType(usbInfo);

            // Generate stable device ID
            const deviceId = this.generateDeviceId(
              deviceInfo.name || videoDevice,
              deviceInfo.busInfo || ""
            );

            devices.push({
              id: deviceId,
              displayName: deviceInfo.name || videoDevice,
              vendor: deviceInfo.vendor,
              model: deviceInfo.model,
              driver: deviceInfo.driver,
              path: videoDevice,
              protocol,
              connectionType,
            });
          }
        } catch (error) {
          // Skip devices that can't be queried
          console.debug(
            `[USBCaptureDetector] Failed to query device ${videoDevice}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    } catch (error) {
      console.warn(
        `[USBCaptureDetector] Linux device detection failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return devices;
  }

  /**
   * Scan /dev/video* devices
   */
  private async scanVideoDevices(): Promise<string[]> {
    const devices: string[] = [];
    const devDir = "/dev";

    try {
      const entries = await readdir(devDir);
      for (const entry of entries) {
        if (entry.startsWith("video")) {
          const devicePath = join(devDir, entry);
          try {
            // Check if device is accessible
            await access(devicePath, constants.R_OK);
            devices.push(devicePath);
          } catch {
            // Device not accessible, skip
          }
        }
      }
    } catch (error) {
      console.warn(
        `[USBCaptureDetector] Failed to scan /dev directory:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return devices.sort();
  }

  /**
   * Get v4l2 device information via v4l2-ctl
   */
  private async getV4L2DeviceInfo(devicePath: string): Promise<{
    name?: string;
    driver?: string;
    busInfo?: string;
    vendor?: string;
    model?: string;
  } | null> {
    return new Promise((resolve) => {
      const process = spawn("v4l2-ctl", ["--device", devicePath, "--info"]);

      let stdout = "";
      let stderr = "";

      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve(null);
      }, 3000);

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);

        // Parse v4l2-ctl output
        const info: {
          name?: string;
          driver?: string;
          busInfo?: string;
          vendor?: string;
          model?: string;
        } = {};

        const lines = (stdout + stderr).split("\n");
        for (const line of lines) {
          if (line.includes("Card type")) {
            const match = line.match(/Card type\s*:\s*(.+)/);
            if (match) {
              info.name = match[1].trim();
            }
          } else if (line.includes("Driver name")) {
            const match = line.match(/Driver name\s*:\s*(.+)/);
            if (match) {
              info.driver = match[1].trim();
            }
          } else if (line.includes("Bus info")) {
            const match = line.match(/Bus info\s*:\s*(.+)/);
            if (match) {
              info.busInfo = match[1].trim();
            }
          }
        }

        // Extract vendor/model from name if available
        if (info.name) {
          const parts = info.name.split(/\s+/);
          if (parts.length >= 2) {
            info.vendor = parts[0];
            info.model = parts.slice(1).join(" ");
          }
        }

        resolve(Object.keys(info).length > 0 ? info : null);
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
    });
  }

  /**
   * Get udev information for a device
   */
  private async getUdevInfo(devicePath: string): Promise<{
    usbInterfaces?: string;
    bus?: string;
    vendorId?: string;
    productId?: string;
    usbInfo?: string;
  }> {
    return new Promise((resolve) => {
      const process = spawn("udevadm", ["info", devicePath]);

      let stdout = "";

      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve({});
      }, 2000);

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);

        const info: {
          usbInterfaces?: string;
          bus?: string;
          vendorId?: string;
          productId?: string;
          usbInfo?: string;
        } = {};

        const lines = stdout.split("\n");
        for (const line of lines) {
          if (line.includes("ID_USB_INTERFACES")) {
            const match = line.match(/ID_USB_INTERFACES=(.+)/);
            if (match) {
              info.usbInterfaces = match[1].trim();
            }
          } else if (line.includes("ID_BUS")) {
            const match = line.match(/ID_BUS=(.+)/);
            if (match) {
              info.bus = match[1].trim();
            }
          } else if (line.includes("ID_VENDOR_ID")) {
            const match = line.match(/ID_VENDOR_ID=(.+)/);
            if (match) {
              info.vendorId = match[1].trim();
            }
          } else if (line.includes("ID_MODEL_ID")) {
            const match = line.match(/ID_MODEL_ID=(.+)/);
            if (match) {
              info.productId = match[1].trim();
            }
          } else if (line.includes("ID_USB_")) {
            info.usbInfo = line;
          }
        }

        resolve(info);
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve({});
      });
    });
  }

  /**
   * Determine protocol from udev info
   */
  private determineProtocol(udevInfo: {
    bus?: string;
    usbInterfaces?: string;
    usbInfo?: string;
  }): "usb" | "thunderbolt" | "displayport" {
    // Check for Thunderbolt
    if (udevInfo.bus === "thunderbolt") {
      return "thunderbolt";
    }

    const usbInfo = udevInfo.usbInfo?.toLowerCase() || "";
    if (usbInfo.includes("displayport") || usbInfo.includes("display port")) {
      return "displayport";
    }

    // Default to USB
    return "usb";
  }

  /**
   * Determine connection type from udev info
   */
  private determineConnectionType(udevInfo: {
    bus?: string;
    usbInfo?: string;
  }): "usb-c" | "usb-a" | "thunderbolt" {
    if (udevInfo.bus === "thunderbolt") {
      return "thunderbolt";
    }

    // Check for USB-C indicators in udev info
    // USB-C devices often have specific identifiers
    if (
      udevInfo.usbInfo?.toLowerCase().includes("usb-c") ||
      udevInfo.usbInfo?.toLowerCase().includes("type-c")
    ) {
      return "usb-c";
    }

    // Default to USB-A (legacy)
    return "usb-a";
  }

  /**
   * Generate stable device ID
   */
  private generateDeviceId(name: string, busInfo: string): string {
    const hash = createHash("sha256")
      .update(`${name}-${busInfo}`)
      .digest("hex")
      .substring(0, 8);
    return `usb-capture-${hash}`;
  }

  /**
   * Detect ports for a device
   * Platform-specific port detection
   */
  private async detectPorts(device: USBDeviceInfo): Promise<USBPortInfo[]> {
    const platformType = platform();

    switch (platformType) {
      case "darwin":
        return this.detectMacOSPorts(device);
      case "win32":
        return this.detectWindowsPorts(device);
      case "linux":
        return this.detectLinuxPorts(device);
      default:
        return [];
    }
  }

  /**
   * macOS port detection
   * Uses AVFoundation via system commands (or FFI later)
   */
  private async detectMacOSPorts(
    device: USBDeviceInfo
  ): Promise<USBPortInfo[]> {
    const ports: USBPortInfo[] = [];

    try {
      // Get format capabilities via system_profiler or AVFoundation
      // For now, we'll use heuristics based on device name/model
      const formats = await this.getMacOSFormats(device);

      // Determine port type based on device protocol
      let portType: "usb" | "thunderbolt" | "displayport" = "usb";
      if (device.protocol === "thunderbolt") {
        portType = "thunderbolt";
      } else if (device.protocol === "displayport") {
        portType = "displayport";
      }

      // USB-C capture devices are typically input-only
      const direction: "input" | "output" | "bidirectional" = "input";

      ports.push({
        id: `${device.id}-port-0`,
        displayName: device.displayName || "USB-C Port",
        type: portType,
        direction,
        index: 0,
        formats,
      });
    } catch (error) {
      console.debug(
        `[USBCaptureDetector] Failed to detect ports for device ${device.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return ports;
  }

  /**
   * Get supported formats for macOS device
   * Uses heuristics based on device name/model
   * TODO: Use AVFoundation APIs via FFI for accurate format detection
   */
  private async getMacOSFormats(device: USBDeviceInfo): Promise<string[]> {
    const formats: string[] = [];
    const name = (device.displayName || "").toLowerCase();
    const model = (device.model || "").toLowerCase();

    // Heuristic: High-end devices often support 4K
    if (name.includes("4k") || model.includes("4k") || name.includes("ultra")) {
      formats.push("4K30");
      formats.push("1080p60");
      formats.push("1080p30");
    } else {
      // Standard USB-C capture devices typically support 1080p
      formats.push("1080p30");
      formats.push("1080p60");
      formats.push("720p30");
      formats.push("720p60");
    }

    return formats;
  }

  /**
   * Windows port detection
   * Media Foundation devices typically have one port per device
   */
  private async detectWindowsPorts(
    device: USBDeviceInfo
  ): Promise<USBPortInfo[]> {
    const ports: USBPortInfo[] = [];

    try {
      // Get format capabilities via PowerShell or Media Foundation
      // For now, we'll use heuristics
      const formats = await this.getWindowsFormats(device);

      // Determine port type based on device protocol
      let portType: "usb" | "thunderbolt" | "displayport" = "usb";
      if (device.protocol === "thunderbolt") {
        portType = "thunderbolt";
      } else if (device.protocol === "displayport") {
        portType = "displayport";
      }

      // USB-C capture devices are typically input-only
      const direction: "input" | "output" | "bidirectional" = "input";

      ports.push({
        id: `${device.id}-port-0`,
        displayName: device.displayName || "USB-C Port",
        type: portType,
        direction,
        index: 0,
        formats,
      });
    } catch (error) {
      console.debug(
        `[USBCaptureDetector] Failed to detect ports for device ${device.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return ports;
  }

  /**
   * Get supported formats for Windows device
   * Uses heuristics based on device name/model
   * TODO: Use Media Foundation APIs via FFI for accurate format detection
   */
  private async getWindowsFormats(device: USBDeviceInfo): Promise<string[]> {
    const formats: string[] = [];
    const name = (device.displayName || "").toLowerCase();
    const model = (device.model || "").toLowerCase();

    // Heuristic: High-end devices often support 4K
    if (name.includes("4k") || model.includes("4k") || name.includes("ultra")) {
      formats.push("4K30");
      formats.push("1080p60");
      formats.push("1080p30");
    } else {
      // Standard USB-C capture devices typically support 1080p
      formats.push("1080p30");
      formats.push("1080p60");
      formats.push("720p30");
      formats.push("720p60");
    }

    return formats;
  }

  /**
   * Linux port detection
   * Each /dev/video* device represents one port
   */
  private async detectLinuxPorts(
    device: USBDeviceInfo
  ): Promise<USBPortInfo[]> {
    const ports: USBPortInfo[] = [];

    try {
      // Get format capabilities via v4l2-ctl
      const formats = await this.getV4L2Formats(device.path);

      // Determine port type based on device protocol
      let portType: "usb" | "thunderbolt" | "displayport" = "usb";
      if (device.protocol === "thunderbolt") {
        portType = "thunderbolt";
      } else if (device.protocol === "displayport") {
        portType = "displayport";
      }

      // USB-C capture devices are typically input-only
      // Some devices support bidirectional, but we default to input
      const direction: "input" | "output" | "bidirectional" = "input";

      ports.push({
        id: `${device.id}-port-0`,
        displayName: device.displayName || "USB-C Port",
        type: portType,
        direction,
        index: 0,
        formats,
      });
    } catch (error) {
      console.debug(
        `[USBCaptureDetector] Failed to detect ports for device ${device.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return ports;
  }

  /**
   * Get supported formats via v4l2-ctl
   */
  private async getV4L2Formats(devicePath: string): Promise<string[]> {
    return new Promise((resolve) => {
      const process = spawn("v4l2-ctl", [
        "--device",
        devicePath,
        "--list-formats",
      ]);

      let stdout = "";
      const formats: string[] = [];

      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve(formats);
      }, 3000);

      process.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      process.on("close", () => {
        clearTimeout(timeout);

        // Parse format output
        // Format: "Pixel Format: 'YUYV' (YUYV 4:2:2)"
        // Or: "Size: Discrete 1920x1080"
        const lines = stdout.split("\n");
        for (const line of lines) {
          // Extract resolution from "Size: Discrete WIDTHxHEIGHT"
          const sizeMatch = line.match(/Size:\s*Discrete\s*(\d+)x(\d+)/);
          if (sizeMatch) {
            const height = parseInt(sizeMatch[2], 10);

            // Add resolution-based formats
            if (height >= 2160) {
              formats.push("4K30");
            } else if (height >= 1440) {
              formats.push("1440p30");
            } else if (height >= 1080) {
              formats.push("1080p30");
              formats.push("1080p60");
            } else if (height >= 720) {
              formats.push("720p30");
              formats.push("720p60");
            }
          }
        }

        // Remove duplicates and sort
        const uniqueFormats = [...new Set(formats)];
        resolve(uniqueFormats);
      });

      process.on("error", () => {
        clearTimeout(timeout);
        resolve(formats);
      });
    });
  }

  /**
   * Create port descriptor from port info
   * Maps protocol to port type and includes format capabilities
   */
  private createPortDescriptor(portInfo: USBPortInfo): PortDescriptorT {
    // Determine port type based on protocol
    // Protocol priority: thunderbolt > displayport > usb
    let portType: "sdi" | "hdmi" | "usb" | "displayport" | "thunderbolt" =
      "usb";

    if (portInfo.type === "thunderbolt") {
      portType = "thunderbolt";
    } else if (portInfo.type === "displayport") {
      portType = "displayport";
    } else {
      portType = "usb";
    }

    // Use formats from portInfo if available, otherwise empty array
    const formats = portInfo.formats || [];

    return {
      id: portInfo.id,
      displayName: portInfo.displayName,
      type: portType,
      direction: portInfo.direction,
      capabilities: {
        formats,
      },
      status: {
        available: true, // Will be checked when device is opened
      },
    };
  }
}
