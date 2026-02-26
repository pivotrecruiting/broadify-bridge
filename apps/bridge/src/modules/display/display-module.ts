import { spawn } from "node:child_process";
import type {
  DeviceDescriptorT,
  OutputDisplayModeT,
  PortDescriptorT,
} from "@broadify/protocol";
import type { DeviceController, DeviceModule } from "../device-module.js";
import { getBridgeContext } from "../../services/bridge-context.js";

// Normalized subset of system_profiler display fields for device mapping.
type RawDisplayInfoT = {
  name: string;
  connectionType: PortDescriptorT["type"];
  vendorId?: string;
  productId?: string;
  serial?: string;
  resolution?: { width: number; height: number };
  refreshHz?: number;
};

type WindowsMonitorIdRowT = {
  instance_name?: string;
  active?: boolean;
  name?: string;
  manufacturer?: string;
  product_code?: string;
  serial?: string;
};

type WindowsMonitorConnectionRowT = {
  instance_name?: string;
  active?: boolean;
  video_output_technology?: number;
};

type WindowsDisplayDetectorPayloadT = {
  ids?: WindowsMonitorIdRowT[] | WindowsMonitorIdRowT;
  connections?: WindowsMonitorConnectionRowT[] | WindowsMonitorConnectionRowT;
};

// system_profiler output keys vary by macOS version and GPU type.
// These key lists intentionally include multiple aliases for resilience.
const MAX_REFRESH_SEARCH_KEYS = [
  "spdisplays_refresh_rate",
  "spdisplays_display_refresh_rate",
  "spdisplays_display_frequency",
  "spdisplays_frequency",
];

const MAX_RESOLUTION_SEARCH_KEYS = [
  "spdisplays_resolution",
  "spdisplays_pixels",
  "spdisplays_display_resolution",
  "spdisplays_display_pixel_resolution",
];

const MAX_CONNECTION_SEARCH_KEYS = [
  "spdisplays_connection_type",
  "spdisplays_display_connection_type",
  "spdisplays_connection",
  "spdisplays_transport",
  "spdisplays_bus_type",
];

const MAX_NAME_SEARCH_KEYS = ["_name", "spdisplays_display_name"];

const MAX_VENDOR_SEARCH_KEYS = [
  "spdisplays_display_vendor-id",
  "spdisplays_display_vendor_id",
];

const MAX_PRODUCT_SEARCH_KEYS = [
  "spdisplays_display_product-id",
  "spdisplays_display_product_id",
];

const MAX_SERIAL_SEARCH_KEYS = [
  "spdisplays_display_serial-number",
  "spdisplays_display_serial-number2",
  "spdisplays_display_serial_number",
];

// Stabilize IDs by stripping punctuation and normalizing to lowercase.
const sanitizeIdPart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Convert system_profiler connection labels into protocol port types.
const normalizeConnectionType = (
  value?: string
): PortDescriptorT["type"] | null => {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower.includes("hdmi")) {
    return "hdmi";
  }
  if (lower.includes("displayport")) {
    return "displayport";
  }
  if (lower.includes("thunderbolt")) {
    return "thunderbolt";
  }
  if (lower.includes("usb-c") || lower.includes("usb c")) {
    return "thunderbolt";
  }
  return null;
};

const normalizeWindowsInstanceKey = (value: string): string =>
  value.trim().toLowerCase().replace(/_\d+$/, "");

const WINDOWS_INTERNAL_OUTPUT_TECH_VALUES = new Set<number>([
  -2147483648,
  2147483648,
]);

// Windows uses a platform-specific enum for monitor connection technologies.
// This mapping is intentionally best-effort and falls back to DisplayPort.
const normalizeWindowsConnectionType = (
  value?: number
): PortDescriptorT["type"] | null => {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (value === 5 || value === 6) {
    return "hdmi";
  }

  if (
    value === 10 ||
    value === 11 ||
    value === 12 ||
    value === 13 ||
    value === 14 ||
    value === 18
  ) {
    return "displayport";
  }

  return null;
};

const isLikelyWindowsInternalDisplay = (
  name: string | undefined,
  videoOutputTechnology?: number
): boolean => {
  if (
    videoOutputTechnology !== undefined &&
    WINDOWS_INTERNAL_OUTPUT_TECH_VALUES.has(videoOutputTechnology)
  ) {
    return true;
  }
  if (name && /built-?in|internal|integrated/i.test(name)) {
    return true;
  }
  return false;
};

// Best-effort resolution parsing ("3840 x 2160").
const parseResolution = (
  value?: string
): { width: number; height: number } | undefined => {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  return { width, height };
};

// Best-effort refresh parsing ("59.94 Hz").
const parseRefreshHz = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }
  const match = value.match(/(\d+(?:\.\d+)?)\s*hz/i);
  if (!match) {
    return undefined;
  }
  const hz = Number(match[1]);
  if (!Number.isFinite(hz)) {
    return undefined;
  }
  return hz;
};

// Prefer known keys over scanning all values to avoid false positives.
const getStringField = (
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

// Fallback matcher when platform-specific keys are missing.
const findStringMatch = (
  obj: Record<string, unknown>,
  matcher: (value: string) => boolean
): string | undefined => {
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && matcher(value)) {
      return value;
    }
  }
  return undefined;
};

// Filter out built-in panels to expose only external outputs.
const isInternalDisplay = (obj: Record<string, unknown>): boolean => {
  const displayType = getStringField(obj, ["spdisplays_display_type"]);
  if (displayType && /built-in|internal/i.test(displayType)) {
    return true;
  }
  const displayName = getStringField(obj, MAX_NAME_SEARCH_KEYS);
  if (displayName && /built-in|internal/i.test(displayName)) {
    return true;
  }
  return false;
};

// Recursively collect display objects from the nested system_profiler tree.
const collectDisplays = (items: unknown[]): Record<string, unknown>[] => {
  const results: Record<string, unknown>[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const obj = node as Record<string, unknown>;
      const displays = obj.spdisplays_ndrvs;
      if (Array.isArray(displays)) {
        for (const display of displays) {
          if (display && typeof display === "object") {
            results.push(display as Record<string, unknown>);
          }
        }
      }
      const nested = obj._items;
      if (Array.isArray(nested)) {
        walk(nested);
      }
    }
  };
  walk(items);
  return results;
};

// Provide a single mode representing the active output.
const buildDisplayMode = (info: RawDisplayInfoT): OutputDisplayModeT[] => {
  if (!info.resolution || !info.refreshHz) {
    return [];
  }
  const { width, height } = info.resolution;
  const fps = info.refreshHz;
  const fpsLabel =
    Math.abs(fps - Math.round(fps)) < 0.01 ? String(Math.round(fps)) : fps.toFixed(2);
  return [
    {
      id: 0,
      label: `${height}p${fpsLabel} (${width}x${height})`,
      width,
      height,
      fps,
      fieldDominance: "progressive",
      pixelFormats: [],
    },
  ];
};

const toObjectArray = <T>(value: T[] | T | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

// Security: this spawns a fixed, local system_profiler command with a hard timeout.
// Mitigation: no user-controlled arguments, bounded runtime, and JSON parsing guards.
const getSystemProfilerDisplays = async (): Promise<RawDisplayInfoT[]> => {
  return new Promise((resolve) => {
    const process = spawn("system_profiler", ["SPDisplaysDataType", "-json"]);
    let stdout = "";
    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      resolve([]);
    }, 5000);

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.on("close", () => {
      clearTimeout(timeout);
      try {
        const json = JSON.parse(stdout) as { SPDisplaysDataType?: unknown[] };
        const items = Array.isArray(json.SPDisplaysDataType)
          ? json.SPDisplaysDataType
          : [];
        const displayItems = collectDisplays(items);
        const results: RawDisplayInfoT[] = [];

        for (const display of displayItems) {
          if (isInternalDisplay(display)) {
            continue;
          }
          const name =
            getStringField(display, MAX_NAME_SEARCH_KEYS) || "External Display";
          const connectionRaw =
            getStringField(display, MAX_CONNECTION_SEARCH_KEYS) ||
            findStringMatch(display, (value) =>
              /(hdmi|displayport|thunderbolt|usb-c)/i.test(value)
            );
          let connectionType = normalizeConnectionType(connectionRaw);
          if (!connectionType) {
            connectionType = "displayport";
            getBridgeContext().logger.warn(
              `[DisplayDetector] Missing connection type for "${name}", falling back to displayport`
            );
          }
          const vendorId = getStringField(display, MAX_VENDOR_SEARCH_KEYS);
          const productId = getStringField(display, MAX_PRODUCT_SEARCH_KEYS);
          const serial = getStringField(display, MAX_SERIAL_SEARCH_KEYS);
          const resolutionRaw =
            getStringField(display, MAX_RESOLUTION_SEARCH_KEYS) ||
            findStringMatch(display, (value) => /\d+\s*x\s*\d+/i.test(value));
          const resolution = parseResolution(resolutionRaw);
          const refreshRaw =
            getStringField(display, MAX_REFRESH_SEARCH_KEYS) ||
            findStringMatch(display, (value) => /\d+(?:\.\d+)?\s*hz/i.test(value));
          const refreshHz = parseRefreshHz(refreshRaw);

          results.push({
            name,
            connectionType,
            vendorId,
            productId,
            serial,
            resolution,
            refreshHz,
          });
        }

        resolve(results);
      } catch (error) {
        getBridgeContext().logger.warn(
          `[DisplayDetector] Failed to parse system_profiler output: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        resolve([]);
      }
    });
  });
};

// Security: fixed PowerShell/CIM queries only, no user-controlled arguments, bounded runtime.
const getWindowsDisplays = async (): Promise<RawDisplayInfoT[]> => {
  return new Promise((resolve) => {
    const psCommand = `
      $ErrorActionPreference = 'SilentlyContinue'
      function Convert-WmiChars([object]$Values) {
        if ($null -eq $Values) { return '' }
        return (-join ($Values | Where-Object { $_ -ne $null -and [int]$_ -ne 0 } | ForEach-Object { [char][int]$_ }))
      }
      $ids = @(
        Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID |
        ForEach-Object {
          [PSCustomObject]@{
            instance_name = [string]$_.InstanceName
            active = [bool]$_.Active
            name = (Convert-WmiChars $_.UserFriendlyName)
            manufacturer = (Convert-WmiChars $_.ManufacturerName)
            product_code = (Convert-WmiChars $_.ProductCodeID)
            serial = (Convert-WmiChars $_.SerialNumberID)
          }
        }
      )
      $connections = @(
        Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorConnectionParams |
        ForEach-Object {
          [PSCustomObject]@{
            instance_name = [string]$_.InstanceName
            active = [bool]$_.Active
            video_output_technology = [long]$_.VideoOutputTechnology
          }
        }
      )
      [PSCustomObject]@{
        ids = $ids
        connections = $connections
      } | ConvertTo-Json -Compress -Depth 4
    `;

    const process = spawn("powershell", ["-Command", psCommand]);
    let stdout = "";
    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      resolve([]);
    }, 5000);

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.on("close", () => {
      clearTimeout(timeout);
      try {
        const json = JSON.parse(stdout) as WindowsDisplayDetectorPayloadT;
        const idRows = toObjectArray(json.ids);
        const connectionRows = toObjectArray(json.connections);

        const connectionByInstance = new Map<string, WindowsMonitorConnectionRowT>();
        for (const row of connectionRows) {
          if (!row.instance_name || row.active === false) {
            continue;
          }
          connectionByInstance.set(normalizeWindowsInstanceKey(row.instance_name), row);
        }

        const results: RawDisplayInfoT[] = [];
        for (const row of idRows) {
          if (!row.instance_name || row.active === false) {
            continue;
          }

          const instanceKey = normalizeWindowsInstanceKey(row.instance_name);
          const connection = connectionByInstance.get(instanceKey);
          const videoOutputTechnology =
            typeof connection?.video_output_technology === "number"
              ? connection.video_output_technology
              : undefined;

          const name = row.name?.trim() || "External Display";
          if (isLikelyWindowsInternalDisplay(name, videoOutputTechnology)) {
            continue;
          }

          let connectionType = normalizeWindowsConnectionType(videoOutputTechnology);
          if (!connectionType) {
            connectionType = "displayport";
            getBridgeContext().logger.warn(
              `[DisplayDetector] Missing/unknown Windows connection type for "${name}", falling back to displayport`
            );
          }

          results.push({
            name,
            connectionType,
            vendorId: row.manufacturer?.trim() || undefined,
            productId: row.product_code?.trim() || undefined,
            serial: row.serial?.trim() || undefined,
          });
        }

        resolve(results);
      } catch (error) {
        getBridgeContext().logger.warn(
          `[DisplayDetector] Failed to parse Windows monitor output: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        resolve([]);
      }
    });

    process.on("error", (error) => {
      clearTimeout(timeout);
      getBridgeContext().logger.warn(
        `[DisplayDetector] Failed to run PowerShell for Windows display detection: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      resolve([]);
    });
  });
};

const mapRawDisplaysToDevices = (
  rawDisplays: RawDisplayInfoT[],
  options: { outputRuntimeSupported: boolean }
): DeviceDescriptorT[] => {
  const now = Date.now();
  const seenIds = new Set<string>();

  return rawDisplays.map((display, index) => {
    // Prefer vendor/product/serial for stable IDs; fallback to name + index.
    const idParts = [
      display.vendorId ? sanitizeIdPart(display.vendorId) : "",
      display.productId ? sanitizeIdPart(display.productId) : "",
      display.serial ? sanitizeIdPart(display.serial) : "",
    ].filter(Boolean);
    const baseId =
      idParts.length > 0
        ? `display-${idParts.join("-")}`
        : `display-${sanitizeIdPart(display.name)}-${index}`;
    let deviceId = baseId;
    if (seenIds.has(deviceId)) {
      deviceId = `${baseId}-${index}`;
    }
    seenIds.add(deviceId);

    // Capabilities are derived from the current active mode only.
    const modes = buildDisplayMode(display);
    const formats = modes.length > 0 ? [modes[0].label.split(" ")[0]] : [];

    const portId = `${deviceId}-${display.connectionType}`;
    const portLabelMap: Record<PortDescriptorT["type"], string> = {
      hdmi: "HDMI",
      displayport: "DisplayPort",
      thunderbolt: "Thunderbolt",
      sdi: "SDI",
      usb: "USB",
    };
    const portLabel = portLabelMap[display.connectionType] || "Display";

    const port: PortDescriptorT = {
      id: portId,
      displayName: `${portLabel} Output`,
      type: display.connectionType,
      direction: "output",
      role: "video",
      capabilities: {
        formats,
        modes,
      },
      status: {
        available: options.outputRuntimeSupported,
        signal: "none",
      },
    };

    return {
      id: deviceId,
      displayName: display.name,
      type: "display",
      vendor: display.vendorId,
      model: display.productId,
      ports: [port],
      status: {
        present: true,
        inUse: false,
        ready: options.outputRuntimeSupported,
        signal: "none",
        error: options.outputRuntimeSupported
          ? undefined
          : "Display output playback helper is not implemented for this platform yet",
        lastSeen: now,
      },
    };
  });
};

// Placeholder controller for parity with other device modules.
class DisplayController implements DeviceController {
  constructor(private readonly deviceId: string) {}

  async open(): Promise<void> {
    getBridgeContext().logger.info(
      `[DisplayController] Open requested for ${this.deviceId}`
    );
  }

  async close(): Promise<void> {
    getBridgeContext().logger.info(
      `[DisplayController] Close requested for ${this.deviceId}`
    );
  }

  async getStatus(): Promise<DeviceDescriptorT["status"]> {
    return {
      present: true,
      inUse: false,
      ready: true,
      signal: "none",
      lastSeen: Date.now(),
    };
  }
}

/**
 * Display detector for external monitor outputs.
 *
 * macOS / Windows: detection + native playback helper path.
 */
export class DisplayModule implements DeviceModule {
  readonly name = "display";

  async detect(): Promise<DeviceDescriptorT[]> {
    if (process.platform === "darwin") {
      const rawDisplays = await getSystemProfilerDisplays();
      return mapRawDisplaysToDevices(rawDisplays, { outputRuntimeSupported: true });
    }

    if (process.platform === "win32") {
      const rawDisplays = await getWindowsDisplays();
      return mapRawDisplaysToDevices(rawDisplays, { outputRuntimeSupported: true });
    }

    return [];
  }

  createController(deviceId: string): DeviceController {
    return new DisplayController(deviceId);
  }
}
