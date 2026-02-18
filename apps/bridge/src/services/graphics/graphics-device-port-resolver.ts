import type { DeviceDescriptorT } from "@broadify/protocol";
import { deviceCache } from "../device-cache.js";

export type DevicePortMatchT = {
  device: DeviceDescriptorT;
  port: DeviceDescriptorT["ports"][number];
};

/**
 * Find a specific output port by id in a device list.
 *
 * @param devices Available devices.
 * @param portId Port identifier.
 * @returns Matching device + port when found.
 */
export function findDevicePort(
  devices: DeviceDescriptorT[],
  portId: string
): DevicePortMatchT | null {
  for (const device of devices) {
    const port = device.ports.find((entry) => entry.id === portId);
    if (port) {
      return { device, port };
    }
  }
  return null;
}

/**
 * Resolve a port id against the current device cache.
 *
 * @param portId Port identifier.
 * @returns Matching device + port when found.
 */
export async function findCachedDevicePortById(
  portId: string
): Promise<DevicePortMatchT | null> {
  const devices = await deviceCache.getDevices();
  return findDevicePort(devices, portId);
}
