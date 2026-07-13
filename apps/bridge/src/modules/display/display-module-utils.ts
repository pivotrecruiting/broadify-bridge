import type {
  DeviceDescriptorT,
  OutputDisplayModeT,
  PortDescriptorT,
} from "@broadify/protocol";
import { sanitizeIdPart } from "./display-parse-utils.js";

export type RawDisplayInfoT = {
  name: string;
  connectionType: PortDescriptorT["type"];
  vendorId?: string;
  productId?: string;
  serial?: string;
  resolution?: { width: number; height: number };
  refreshHz?: number;
  modes?: RawDisplayModeT[];
};

export type RawDisplayModeT = {
  width: number;
  height: number;
  fps: number;
  fieldDominance: "progressive" | "interlaced";
  preferred?: boolean;
};

const toModeKey = (mode: RawDisplayModeT): string =>
  `${mode.width}x${mode.height}@${mode.fps.toFixed(3)}-${mode.fieldDominance}`;

const isValidRawDisplayMode = (mode: RawDisplayModeT): boolean =>
  Number.isFinite(mode.width) &&
  Number.isFinite(mode.height) &&
  Number.isFinite(mode.fps) &&
  mode.width > 0 &&
  mode.height > 0 &&
  mode.fps > 0;

const compareRawDisplayModes = (
  left: RawDisplayModeT,
  right: RawDisplayModeT
): number => {
  if (Boolean(left.preferred) !== Boolean(right.preferred)) {
    return left.preferred ? -1 : 1;
  }
  return (
    right.height - left.height ||
    right.width - left.width ||
    right.fps - left.fps ||
    left.fieldDominance.localeCompare(right.fieldDominance)
  );
};

/**
 * Build display mode from raw display info.
 */
export const buildDisplayMode = (info: RawDisplayInfoT): OutputDisplayModeT[] => {
  const rawModes = info.modes?.length
    ? info.modes
    : info.resolution && info.refreshHz
      ? [
          {
            width: info.resolution.width,
            height: info.resolution.height,
            fps: info.refreshHz,
            fieldDominance: "progressive" as const,
            preferred: true,
          },
        ]
      : [];
  const seen = new Set<string>();
  const modes = rawModes
    .filter(isValidRawDisplayMode)
    .filter((mode) => {
      const key = toModeKey(mode);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort(compareRawDisplayModes);

  return modes.map((mode, id) => {
    const fpsLabel =
      Math.abs(mode.fps - Math.round(mode.fps)) < 0.01
        ? String(Math.round(mode.fps))
        : mode.fps.toFixed(2);
    const scanLabel = mode.fieldDominance === "interlaced" ? "i" : "p";
    return {
      id,
      label: `${mode.height}${scanLabel}${fpsLabel} (${mode.width}x${mode.height})`,
      width: mode.width,
      height: mode.height,
      fps: mode.fps,
      fieldDominance: mode.fieldDominance,
      pixelFormats: [],
    };
  });
};

/**
 * Map raw display info to protocol device descriptors.
 */
export const mapRawDisplaysToDevices = (
  rawDisplays: RawDisplayInfoT[],
  options: { outputRuntimeSupported: boolean }
): DeviceDescriptorT[] => {
  const now = Date.now();
  const seenIds = new Set<string>();

  return rawDisplays.map((display, index) => {
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

    const modes = buildDisplayMode(display);
    const formats = Array.from(
      new Set(modes.map((mode) => mode.label.split(" ")[0]))
    );

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
