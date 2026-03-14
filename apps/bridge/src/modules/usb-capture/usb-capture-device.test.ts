import { platform } from "node:os";
import { USBCaptureDevice } from "./usb-capture-device.js";

jest.mock("node:os", () => ({
  platform: jest.fn().mockReturnValue("darwin"),
}));

describe("USBCaptureDevice", () => {
  const deviceId = "usb-capture-test-1";

  beforeEach(() => {
    (platform as jest.Mock).mockReturnValue("darwin");
  });

  describe("open", () => {
    it("throws when device is already open", async () => {
      const device = new USBCaptureDevice(deviceId);
      await device.open();

      await expect(device.open()).rejects.toThrow(
        `Device ${deviceId} is already open`
      );

      await device.close();
    });

    it("sets device to open state on success (darwin)", async () => {
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      await device.close();
    });
  });

  describe("close", () => {
    it("is no-op when device is not open", async () => {
      const device = new USBCaptureDevice(deviceId);
      await expect(device.close()).resolves.toBeUndefined();
    });

    it("releases device when open", async () => {
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      await device.close();
      await device.open();
      await device.close();
    });
  });

  describe("getStatus", () => {
    it("returns status with present, inUse, ready, lastSeen", async () => {
      const device = new USBCaptureDevice(deviceId);
      const status = await device.getStatus();

      expect(status).toHaveProperty("present");
      expect(status).toHaveProperty("inUse");
      expect(status).toHaveProperty("ready");
      expect(status).toHaveProperty("lastSeen");
      expect(typeof status.lastSeen).toBe("number");
    });

    it("returns ready true after open on darwin", async () => {
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      const status = await device.getStatus();
      expect(status.ready).toBe(true);
      expect(status.present).toBe(true);
      await device.close();
    });
  });

  describe("unsupported platform", () => {
    it("open throws for unsupported platform", async () => {
      (platform as jest.Mock).mockReturnValue("aix");
      const device = new USBCaptureDevice(deviceId);

      await expect(device.open()).rejects.toThrow(/Unsupported platform|Failed to open/);
    });

    it("getStatus returns base status for unsupported platform", async () => {
      (platform as jest.Mock).mockReturnValue("sunos");
      const device = new USBCaptureDevice(deviceId);
      const status = await device.getStatus();

      expect(status.present).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.inUse).toBe(false);
    });
  });
});
