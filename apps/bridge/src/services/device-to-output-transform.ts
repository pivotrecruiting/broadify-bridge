import type {
  BridgeOutputsT,
  DeviceDescriptorT,
  OutputDeviceT,
} from "@broadify/protocol";

/**
 * Transform Device/Port model to UI-compatible output format.
 *
 * @param devices Device descriptors from device cache.
 * @returns Output lists for output1 (fill/video) and output2 (key).
 */
export function transformDevicesToOutputs(
  devices: DeviceDescriptorT[]
): BridgeOutputsT {
  const output1Devices: OutputDeviceT[] = [];
  const output2Devices: OutputDeviceT[] = [];
  const mapDeviceTypeToOutputType = (
    deviceType: DeviceDescriptorT["type"]
  ): OutputDeviceT["type"] => {
    if (deviceType === "decklink") {
      return "decklink";
    }
    if (deviceType === "display") {
      return "display";
    }
    return "capture";
  };

  for (const device of devices) {
    for (const port of device.ports) {
      const outputCapable =
        port.direction === "output" || port.direction === "bidirectional";
      if (!outputCapable) {
        continue;
      }

      const available =
        device.status.present &&
        device.status.ready &&
        !device.status.inUse &&
        port.status.available;
      const outputEntry: OutputDeviceT = {
        id: port.id,
        name: `${device.displayName} - ${port.displayName}`,
        type: mapDeviceTypeToOutputType(device.type),
        available,
        deviceId: device.id,
        portType: port.type,
        portRole: port.role,
        formats: port.capabilities.formats,
        modes: port.capabilities.modes,
      };

      if (port.role === "key") {
        output2Devices.push(outputEntry);
      } else {
        output1Devices.push(outputEntry);
      }
    }
  }

  return {
    output1: output1Devices,
    output2: output2Devices,
  };
}
