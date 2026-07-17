import { spawn } from "node:child_process";
import type { DeviceDescriptorT } from "@broadify/protocol";
import type { DeviceController, DeviceModule } from "../device-module.js";
import { getBridgeContext } from "../../services/bridge-context.js";
import {
  normalizeConnectionType,
  parseResolution,
  parseRefreshHz,
} from "./display-parse-utils.js";
import {
  mapRawDisplaysToDevices,
  type RawDisplayInfoT,
} from "./display-module-utils.js";
import { displayTargetRegistry } from "./display-target-registry.js";
import { listNativeWindowsDisplays } from "./windows-display-helper.js";

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

const SYSTEM_PROFILER_TIMEOUT_MS = 5_000;

// Prefer known keys over scanning all values to avoid false positives.
const getStringField = (
  obj: Record<string, unknown>,
  keys: string[],
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
  matcher: (value: string) => boolean,
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

// Security: this spawns a fixed, local system_profiler command with a hard timeout.
// Mitigation: no user-controlled arguments, bounded runtime, and JSON parsing guards.
const getSystemProfilerDisplays = async (): Promise<RawDisplayInfoT[]> => {
  return new Promise((resolve, reject) => {
    let process: ReturnType<typeof spawn>;
    try {
      process = spawn("system_profiler", ["SPDisplaysDataType", "-json"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[DisplayDetector] Failed to start system_profiler: ${message}`,
      );
      reject(new Error(`Failed to start system_profiler: ${message}`));
      return;
    }

    let stdout = "";
    let settled = false;

    const finish = (
      result: { displays: RawDisplayInfoT[] } | { error: Error },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if ("error" in result) {
        reject(result.error);
        return;
      }
      resolve(result.displays);
    };

    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      const error = new Error(
        `system_profiler timed out after ${SYSTEM_PROFILER_TIMEOUT_MS}ms`,
      );
      getBridgeContext().logger.warn(`[DisplayDetector] ${error.message}`);
      finish({ error });
    }, SYSTEM_PROFILER_TIMEOUT_MS);

    process.stdout?.on("data", (data) => {
      if (settled) {
        return;
      }
      stdout += data.toString();
    });

    process.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[DisplayDetector] system_profiler spawn failed: ${message}`,
      );
      finish({ error: new Error(`system_profiler spawn failed: ${message}`) });
    });

    process.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const error = new Error(
          `system_profiler exited with code ${code ?? "unknown"}`,
        );
        getBridgeContext().logger.warn(`[DisplayDetector] ${error.message}`);
        finish({ error });
        return;
      }
      try {
        const json = JSON.parse(stdout) as { SPDisplaysDataType?: unknown };
        if (!Array.isArray(json.SPDisplaysDataType)) {
          throw new Error("SPDisplaysDataType is not an array");
        }
        const items = json.SPDisplaysDataType;
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
              /(hdmi|displayport|thunderbolt|usb-c)/i.test(value),
            );
          let connectionType = normalizeConnectionType(connectionRaw);
          if (!connectionType) {
            connectionType = "displayport";
            getBridgeContext().logger.warn(
              `[DisplayDetector] Missing connection type for "${name}", falling back to displayport`,
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
            findStringMatch(display, (value) =>
              /\d+(?:\.\d+)?\s*hz/i.test(value),
            );
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

        finish({ displays: results });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const parseError = new Error(
          `Failed to parse system_profiler output: ${message}`,
        );
        getBridgeContext().logger.warn(`[DisplayDetector] ${parseError.message}`);
        finish({ error: parseError });
      }
    });
  });
};

// Placeholder controller for parity with other device modules.
class DisplayController implements DeviceController {
  constructor(private readonly deviceId: string) {}

  async open(): Promise<void> {
    getBridgeContext().logger.info(
      `[DisplayController] Open requested for ${this.deviceId}`,
    );
  }

  async close(): Promise<void> {
    getBridgeContext().logger.info(
      `[DisplayController] Close requested for ${this.deviceId}`,
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
  readonly detectionTimeoutMs = 6_000;

  async detect(): Promise<DeviceDescriptorT[]> {
    if (process.platform === "darwin") {
      const rawDisplays = await getSystemProfilerDisplays();
      return mapRawDisplaysToDevices(rawDisplays, {
        outputRuntimeSupported: true,
      });
    }

    if (process.platform === "win32") {
      const rawDisplays = await listNativeWindowsDisplays();
      const devices = mapRawDisplaysToDevices(rawDisplays, {
        outputRuntimeSupported: true,
      });
      displayTargetRegistry.replace(
        devices.flatMap((device, index) => {
          const nativeSelector = rawDisplays[index]?.nativeSelector;
          const portId = device.ports[0]?.id;
          return nativeSelector && portId
            ? [[portId, { deviceName: nativeSelector }] as const]
            : [];
        }),
      );
      return devices;
    }

    return [];
  }

  createController(deviceId: string): DeviceController {
    return new DisplayController(deviceId);
  }
}
