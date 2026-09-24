import { z } from "zod";
import type {
  DeviceDescriptorT,
  OutputDisplayModeT,
  PortDescriptorT,
} from "@broadify/protocol";
import {
  listDecklinkDevicesWithDiagnostics,
  listDecklinkDisplayModes,
  type DecklinkDiagnosticsT,
  type DecklinkDisplayModeT,
} from "./decklink-helper.js";
import { getBridgeContext } from "../../services/bridge-context.js";

const MODE_CACHE_TTL_MS = 60_000;
const MODE_QUERY_DEVICE_CONCURRENCY = 2;

const helperDeviceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  vendor: z.string().optional(),
  model: z.string().optional(),
  videoOutputConnections: z.array(z.enum(["sdi", "hdmi"])).default([]),
  busy: z.boolean().optional(),
  supportsPlayback: z.boolean().optional(),
  supportsExternalKeying: z.boolean().optional(),
  supportsInternalKeying: z.boolean().optional(),
});

const helperDeviceListSchema = z.array(helperDeviceSchema);

const formatFpsLabel = (fps: number): string => {
  const rounded = Math.round(fps * 1000) / 1000;
  if (Math.abs(rounded - Math.round(rounded)) < 0.01) {
    return String(Math.round(rounded));
  }
  return rounded.toFixed(2).replace(/\.00$/, "");
};

const toFormatLabel = (mode: DecklinkDisplayModeT): string => {
  const fpsLabel = formatFpsLabel(mode.fps);
  if (mode.fieldDominance.startsWith("interlaced")) {
    const fieldRate = formatFpsLabel(mode.fps * 2);
    return `${mode.height}i${fieldRate}`;
  }
  if (mode.fieldDominance === "psf") {
    return `${mode.height}psf${fpsLabel}`;
  }
  return `${mode.height}p${fpsLabel}`;
};

const toOutputMode = (mode: DecklinkDisplayModeT): OutputDisplayModeT => ({
  id: mode.id,
  label: `${toFormatLabel(mode)} (${mode.width}x${mode.height})`,
  width: mode.width,
  height: mode.height,
  fps: mode.fps,
  fieldDominance: mode.fieldDominance,
  pixelFormats: mode.pixelFormats ?? [],
});

const attachModes = (
  ports: PortDescriptorT[],
  targetType: PortDescriptorT["type"],
  modes: OutputDisplayModeT[]
): PortDescriptorT[] => {
  if (modes.length === 0) {
    return ports;
  }

  const formats = Array.from(
    new Set(modes.map((mode) => mode.label.split(" ")[0]))
  );

  return ports.map((port) => {
    if (port.type !== targetType) {
      return port;
    }
    return {
      ...port,
      capabilities: {
        ...port.capabilities,
        formats,
        modes,
      },
    };
  });
};

/**
 * Parse helper device payloads into Bridge device descriptors.
 *
 * @param rawDevices Raw helper output payload.
 * @returns Normalized device descriptors.
 */
export function parseDecklinkHelperDevices(
  rawDevices: unknown
): DeviceDescriptorT[] {
  const parsed = helperDeviceListSchema.safeParse(rawDevices);
  if (!parsed.success) {
    try {
      getBridgeContext().logger.warn(
        `[DecklinkDetector] Invalid helper payload: ${parsed.error.message}`
      );
    } catch {
      console.warn(
        `[DecklinkDetector] Invalid helper payload: ${parsed.error.message}`
      );
    }
    return [];
  }

  return parsed.data.map((device) => {
    const inUse = device.busy ?? false;
    const supportsPlayback = device.supportsPlayback ?? true;
    const supportsExternalKeying = device.supportsExternalKeying ?? false;
    const ready = supportsPlayback && !inUse;

    const ports: PortDescriptorT[] = [];
    for (const connectionType of device.videoOutputConnections) {
      if (connectionType === "sdi") {
        if (supportsExternalKeying) {
          ports.push(
            {
              id: `${device.id}-sdi-a`,
              displayName: "SDI A (Fill)",
              type: "sdi",
              direction: "output",
              role: "fill",
              capabilities: {
                formats: [],
              },
              status: {
                available: ready,
                signal: "none",
              },
            },
            {
              id: `${device.id}-sdi-b`,
              displayName: "SDI B (Key)",
              type: "sdi",
              direction: "output",
              role: "key",
              capabilities: {
                formats: [],
              },
              status: {
                available: ready,
                signal: "none",
              },
            }
          );
        } else {
          ports.push({
            id: `${device.id}-sdi`,
            displayName: "SDI Output",
            type: "sdi",
            direction: "output",
            role: "video",
            capabilities: {
              formats: [],
            },
            status: {
              available: ready,
              signal: "none",
            },
          });
        }
        continue;
      }

      if (connectionType === "hdmi") {
        ports.push({
          id: `${device.id}-hdmi`,
          displayName: "HDMI Output",
          type: "hdmi",
          direction: "output",
          role: "video",
          capabilities: {
            formats: [],
          },
          status: {
            available: ready,
            signal: "none",
          },
        });
      }
    }

    return {
      id: device.id,
      displayName: device.displayName,
      type: "decklink",
      vendor: device.vendor,
      model: device.model,
      ports,
      status: {
        present: true,
        inUse,
        ready,
        signal: "none",
        lastSeen: Date.now(),
      },
    };
  });
}

/**
 * DeckLink device detector (macOS-only).
 */
export class DecklinkDetector {
  private readonly modeCache = new Map<
    string,
    { modes: DecklinkDisplayModeT[]; cachedAt: number }
  >();
  private lastDiagnostics: DecklinkDiagnosticsT | null = null;

  getLastDiagnostics(): DecklinkDiagnosticsT | null {
    return this.lastDiagnostics;
  }

  invalidateModeCache(): void {
    this.modeCache.clear();
  }

  private async listDisplayModesWithCache(
    deviceId: string,
    portId: string,
  ): Promise<DecklinkDisplayModeT[]> {
    const now = Date.now();
    const cached = this.modeCache.get(portId);
    if (cached && now - cached.cachedAt < MODE_CACHE_TTL_MS) {
      return cached.modes;
    }

    const modes = await listDecklinkDisplayModes(deviceId, portId);
    this.modeCache.set(portId, { modes, cachedAt: now });
    return modes;
  }

  /**
   * Detect DeckLink devices via helper process.
   *
   * @returns Array of DeckLink device descriptors.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    try {
      const { devices: rawDevices, diagnostics } =
        await listDecklinkDevicesWithDiagnostics();
      this.lastDiagnostics = diagnostics;
      const devices = parseDecklinkHelperDevices(rawDevices);

      const enriched: DeviceDescriptorT[] = [];
      for (
        let index = 0;
        index < devices.length;
        index += MODE_QUERY_DEVICE_CONCURRENCY
      ) {
        const batch = devices.slice(index, index + MODE_QUERY_DEVICE_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (device) => {
          const sdiPort =
            device.ports.find((port) => port.type === "sdi" && port.role !== "key") ??
            device.ports.find((port) => port.type === "sdi");
          const hdmiPort = device.ports.find((port) => port.type === "hdmi");

          const [sdiModes, hdmiModes] = await Promise.all([
            sdiPort
              ? this.listDisplayModesWithCache(device.id, sdiPort.id)
              : Promise.resolve([]),
            hdmiPort
              ? this.listDisplayModesWithCache(device.id, hdmiPort.id)
              : Promise.resolve([]),
          ]);

          let nextPorts = device.ports;
          if (sdiModes.length > 0) {
            nextPorts = attachModes(
              nextPorts,
              "sdi",
              sdiModes.map(toOutputMode)
            );
          }
          if (hdmiModes.length > 0) {
            nextPorts = attachModes(
              nextPorts,
              "hdmi",
              hdmiModes.map(toOutputMode)
            );
          }

          return {
            ...device,
            ports: nextPorts,
          };
          })
        );
        enriched.push(...batchResults);
      }

      if (enriched.length > 0) {
        try {
          getBridgeContext().logger.info(
            `[DecklinkDetector] Found ${enriched.length} DeckLink device(s)`
          );
        } catch {
          console.info(
            `[DecklinkDetector] Found ${enriched.length} DeckLink device(s)`
          );
        }
      }

      return enriched;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      try {
        getBridgeContext().logger.warn(
          `[DecklinkDetector] Device detection failed: ${message}`
        );
      } catch {
        console.warn(
          `[DecklinkDetector] Device detection failed: ${message}`
        );
      }
      return [];
    }
  }
}
