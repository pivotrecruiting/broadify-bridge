import { z } from "zod";
import type { DeviceDescriptorT, PortDescriptorT } from "../../types.js";
import { listDecklinkDevices } from "./decklink-helper.js";

const helperDeviceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  vendor: z.string().optional(),
  model: z.string().optional(),
  videoOutputConnections: z.array(z.enum(["sdi", "hdmi"])).default([]),
  busy: z.boolean().optional(),
  supportsPlayback: z.boolean().optional(),
});

const helperDeviceListSchema = z.array(helperDeviceSchema);

/**
 * Parse helper device payloads into Bridge device descriptors.
 */
export function parseDecklinkHelperDevices(
  rawDevices: unknown
): DeviceDescriptorT[] {
  const parsed = helperDeviceListSchema.safeParse(rawDevices);
  if (!parsed.success) {
    console.warn(
      `[DecklinkDetector] Invalid helper payload: ${parsed.error.message}`
    );
    return [];
  }

  return parsed.data.map((device) => {
    const inUse = device.busy ?? false;
    const supportsPlayback = device.supportsPlayback ?? true;
    const ready = supportsPlayback && !inUse;

    const ports: PortDescriptorT[] = device.videoOutputConnections.map(
      (connectionType, index) => ({
        id: `${device.id}-${connectionType}-${index}`,
        displayName: connectionType === "sdi" ? "SDI Output" : "HDMI Output",
        type: connectionType,
        direction: "output",
        capabilities: {
          formats: [],
          // TODO: Enumerate output display modes via IDeckLinkOutput.
        },
        status: {
          available: ready,
          signal: "none",
        },
      })
    );

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
  /**
   * Detect DeckLink devices via helper process.
   */
  async detect(): Promise<DeviceDescriptorT[]> {
    try {
      const rawDevices = await listDecklinkDevices();
      const devices = parseDecklinkHelperDevices(rawDevices);

      if (devices.length > 0) {
        console.info(
          `[DecklinkDetector] Found ${devices.length} DeckLink device(s)`
        );
      }

      return devices;
    } catch (error) {
      console.warn(
        `[DecklinkDetector] Device detection failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}
