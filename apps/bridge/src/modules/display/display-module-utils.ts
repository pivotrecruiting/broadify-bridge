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
};

/**
 * Build display mode from raw display info.
 */
export const buildDisplayMode = (info: RawDisplayInfoT): OutputDisplayModeT[] => {
  if (!info.resolution || !info.refreshHz) {
    return [];
  }
  const { width, height } = info.resolution;
  const fps = info.refreshHz;
  const fpsLabel =
    Math.abs(fps - Math.round(fps)) < 0.01
      ? String(Math.round(fps))
      : fps.toFixed(2);
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
