import { spawn } from "node:child_process";
import { join } from "node:path";
import type {
  DeviceDescriptorT,
  PortDescriptorT,
} from "@broadify/protocol";
import type { DeviceController, DeviceModule } from "../device-module.js";
import { getBridgeContext } from "../../services/bridge-context.js";
import {
  sanitizeIdPart,
  normalizeConnectionType,
  normalizeWindowsInstanceKey,
  normalizeWindowsConnectionType,
  parseCsvLine,
  parseCsvRows,
  parseResolution,
  parseRefreshHz,
  parseWindowsMonitorPnpId,
} from "./display-parse-utils.js";
import {
  mapRawDisplaysToDevices,
  type RawDisplayInfoT,
} from "./display-module-utils.js";

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

const resolveWindowsSystemExe = (
  ...relativeSegments: string[]
): string | undefined => {
  if (process.platform !== "win32") {
    return undefined;
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) {
    return undefined;
  }
  return join(systemRoot, "System32", ...relativeSegments);
};

const WINDOWS_POWERSHELL_PATH =
  resolveWindowsSystemExe("WindowsPowerShell", "v1.0", "powershell.exe") ||
  "powershell.exe";
const WINDOWS_WMIC_PATH = resolveWindowsSystemExe("wbem", "wmic.exe") || "wmic";

const WINDOWS_INTERNAL_OUTPUT_TECH_VALUES = new Set<number>([
  -2147483648,
  2147483648,
]);

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
  const powerShellResult = await getWindowsDisplaysViaPowerShell();
  if (powerShellResult.ok) {
    return powerShellResult.displays;
  }

  getBridgeContext().logger.warn(
    `[DisplayDetector] Falling back to WMIC for Windows display detection (reason: ${powerShellResult.reason})`
  );
  return getWindowsDisplaysViaWmic();
};

type WindowsDisplayDetectionResultT = {
  ok: boolean;
  displays: RawDisplayInfoT[];
  reason?: string;
};

const getWindowsDisplaysViaPowerShell =
  async (): Promise<WindowsDisplayDetectionResultT> => {
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

    const process = spawn(
      WINDOWS_POWERSHELL_PATH,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        psCommand,
      ],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      resolve({ ok: false, displays: [], reason: "timeout" });
    }, 5000);

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      clearTimeout(timeout);
      try {
        if (code !== 0 && !stdout.trim()) {
          const stderrPreview = stderr.trim().slice(0, 300);
          getBridgeContext().logger.warn(
            `[DisplayDetector] PowerShell exited with code ${code}${
              stderrPreview ? `: ${stderrPreview}` : ""
            }`
          );
          resolve({
            ok: false,
            displays: [],
            reason: `powershell_exit_${code ?? "unknown"}`,
          });
          return;
        }

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

        resolve({ ok: true, displays: results });
      } catch (error) {
        getBridgeContext().logger.warn(
          `[DisplayDetector] Failed to parse Windows monitor output: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        resolve({ ok: false, displays: [], reason: "parse_error" });
      }
    });

    process.on("error", (error) => {
      clearTimeout(timeout);
      getBridgeContext().logger.warn(
        `[DisplayDetector] Failed to run PowerShell for Windows display detection (${WINDOWS_POWERSHELL_PATH}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      resolve({
        ok: false,
        displays: [],
        reason:
          error instanceof Error ? error.message : String(error),
      });
    });
  });
};

// Security: fixed WMIC query only, no user-controlled arguments, bounded runtime.
const getWindowsDisplaysViaWmic = async (): Promise<RawDisplayInfoT[]> => {
  return new Promise((resolve) => {
    const process = spawn(
      WINDOWS_WMIC_PATH,
      [
        "path",
        "Win32_DesktopMonitor",
        "get",
        "Name,PNPDeviceID,Status",
        "/format:csv",
      ],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      resolve([]);
    }, 5000);

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0 && !stdout.trim()) {
        const stderrPreview = stderr.trim().slice(0, 300);
        getBridgeContext().logger.warn(
          `[DisplayDetector] WMIC exited with code ${code}${
            stderrPreview ? `: ${stderrPreview}` : ""
          }`
        );
        resolve([]);
        return;
      }

      try {
        const rows = parseCsvRows(stdout);
        const seen = new Set<string>();
        const results: RawDisplayInfoT[] = [];

        for (const row of rows) {
          const pnpDeviceId = row.PNPDeviceID?.trim();
          if (!pnpDeviceId || !pnpDeviceId.toUpperCase().startsWith("DISPLAY\\")) {
            continue;
          }

          const status = row.Status?.trim();
          if (status && status.toUpperCase() !== "OK") {
            continue;
          }

          const name = row.Name?.trim() || "External Display";
          if (isLikelyWindowsInternalDisplay(name)) {
            continue;
          }

          const uniqueKey = `${name}|${pnpDeviceId}`;
          if (seen.has(uniqueKey)) {
            continue;
          }
          seen.add(uniqueKey);

          const { vendorId, productId } = parseWindowsMonitorPnpId(pnpDeviceId);
          results.push({
            name,
            connectionType: "displayport",
            vendorId,
            productId,
          });
        }

        if (results.length > 0) {
          getBridgeContext().logger.warn(
            `[DisplayDetector] Windows display detection used WMIC fallback (${results.length} display(s), connection type defaults to displayport)`
          );
        }

        resolve(results);
      } catch (error) {
        getBridgeContext().logger.warn(
          `[DisplayDetector] Failed to parse WMIC Windows monitor output: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        resolve([]);
      }
    });

    process.on("error", (error) => {
      clearTimeout(timeout);
      getBridgeContext().logger.warn(
        `[DisplayDetector] Failed to run WMIC for Windows display detection (${WINDOWS_WMIC_PATH}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      resolve([]);
    });
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
