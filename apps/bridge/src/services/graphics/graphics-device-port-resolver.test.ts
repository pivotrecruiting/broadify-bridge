import type { DeviceDescriptorT } from "@broadify/protocol";
import {
  findDevicePort,
  findCachedDevicePortById,
} from "./graphics-device-port-resolver.js";

jest.mock("../device-cache.js", () => ({
  deviceCache: {
    getDevices: jest.fn(),
  },
}));

const { deviceCache } = jest.requireMock("../device-cache.js") as {
  deviceCache: { getDevices: jest.Mock };
};

const createDevice = (
  id: string,
  displayName: string,
  portIds: string[]
): DeviceDescriptorT => ({
  id,
  displayName,
  type: "display",
  ports: portIds.map((portId) => ({
    id: portId,
    type: "sdi",
    direction: "output",
    capabilities: {},
    status: "available",
  })),
  status: "available",
});

describe("graphics-device-port-resolver", () => {
  describe("findDevicePort", () => {
    it("returns null for empty devices", () => {
      expect(findDevicePort([], "port-1")).toBeNull();
    });

    it("returns device and port when portId matches", () => {
      const devices = [
        createDevice("dev1", "Device 1", ["port-a", "port-b"]),
        createDevice("dev2", "Device 2", ["port-c"]),
      ];
      const result = findDevicePort(devices, "port-c");
      expect(result).not.toBeNull();
      expect(result!.device.id).toBe("dev2");
      expect(result!.port.id).toBe("port-c");
    });

    it("returns null when portId not found", () => {
      const devices = [
        createDevice("dev1", "Device 1", ["port-a"]),
      ];
      expect(findDevicePort(devices, "port-missing")).toBeNull();
    });
  });

  describe("findCachedDevicePortById", () => {
    it("returns match from cached devices", async () => {
      const devices = [
        createDevice("dev1", "Device 1", ["port-x"]),
      ];
      deviceCache.getDevices.mockResolvedValue(devices);
      const result = await findCachedDevicePortById("port-x");
      expect(result).not.toBeNull();
      expect(result!.port.id).toBe("port-x");
    });

    it("returns null when port not in cache", async () => {
      deviceCache.getDevices.mockResolvedValue([]);
      const result = await findCachedDevicePortById("port-missing");
      expect(result).toBeNull();
    });
  });
});
