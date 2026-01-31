export type DecklinkPortInfoT = {
  deviceId: string;
  portType: "sdi" | "hdmi";
  portRole: "fill" | "key" | "video";
};

/**
 * Parse a DeckLink port id into its components.
 *
 * @param portId Port id string from device descriptor.
 * @returns Parsed port info or null if the id is not recognized.
 */
export function parseDecklinkPortId(portId: string): DecklinkPortInfoT | null {
  if (portId.endsWith("-sdi-a")) {
    return {
      deviceId: portId.slice(0, -"-sdi-a".length),
      portType: "sdi",
      portRole: "fill",
    };
  }
  if (portId.endsWith("-sdi-b")) {
    return {
      deviceId: portId.slice(0, -"-sdi-b".length),
      portType: "sdi",
      portRole: "key",
    };
  }
  if (portId.endsWith("-sdi")) {
    return {
      deviceId: portId.slice(0, -"-sdi".length),
      portType: "sdi",
      portRole: "video",
    };
  }
  if (portId.endsWith("-hdmi")) {
    return {
      deviceId: portId.slice(0, -"-hdmi".length),
      portType: "hdmi",
      portRole: "video",
    };
  }
  return null;
}
