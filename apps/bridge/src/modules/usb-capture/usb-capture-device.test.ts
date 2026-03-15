import type { DeviceStatusT } from "@broadify/protocol";
import { platform } from "node:os";
import { USBCaptureDevice } from "./usb-capture-device.js";

const mockAccess = jest.fn();
jest.mock("node:os", () => ({
  platform: jest.fn().mockReturnValue("darwin"),
}));
jest.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  constants: { R_OK: 4, W_OK: 2 },
}));

describe("USBCaptureDevice", () => {
  const deviceId = "usb-capture-test-1";

  beforeEach(() => {
    (platform as jest.Mock).mockReturnValue("darwin");
    mockAccess.mockReset();
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

    it("opens successfully on win32", async () => {
      (platform as jest.Mock).mockReturnValue("win32");
      const device = new USBCaptureDevice(deviceId);
      await expect(device.open()).resolves.toBeUndefined();
      await device.close();
    });

    it("opens successfully on linux when a device path is accessible", async () => {
      (platform as jest.Mock).mockReturnValue("linux");
      mockAccess.mockRejectedValueOnce(new Error("EACCES"));
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
      mockAccess.mockResolvedValueOnce(undefined);
      const device = new USBCaptureDevice(deviceId);
      await expect(device.open()).resolves.toBeUndefined();
      await device.close();
    });

    it("throws on linux when no device path is accessible", async () => {
      (platform as jest.Mock).mockReturnValue("linux");
      mockAccess.mockRejectedValue(new Error("EACCES"));
      const device = new USBCaptureDevice(deviceId);

      await expect(device.open()).rejects.toThrow(
        /Failed to open device|not found or not accessible/
      );
    });

    it("wraps open error in Failed to open device message", async () => {
      (platform as jest.Mock).mockReturnValue("linux");
      mockAccess.mockRejectedValue(new Error("Custom error"));
      const device = new USBCaptureDevice(deviceId);

      await expect(device.open()).rejects.toThrow(
        `Failed to open device ${deviceId}:`
      );
      await expect(device.open()).rejects.toThrow("not found or not accessible");
    });

    it("open uses String(error) when thrown value is not Error", async () => {
      (platform as jest.Mock).mockReturnValue("darwin");
      const device = new USBCaptureDevice(deviceId);
      (device as unknown as { openMacOSDevice: () => Promise<void> }).openMacOSDevice =
        jest.fn().mockRejectedValue("non-Error value");
      await expect(device.open()).rejects.toThrow(
        `Failed to open device ${deviceId}: non-Error value`
      );
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

    it("closes on win32 and resets state", async () => {
      (platform as jest.Mock).mockReturnValue("win32");
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      await device.close();
      const status = await device.getStatus();
      expect(status.ready).toBe(false);
    });

    it("closes on linux and resets state", async () => {
      (platform as jest.Mock).mockReturnValue("linux");
      mockAccess.mockResolvedValue(undefined);
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      await device.close();
      const status = await device.getStatus();
      expect(status.ready).toBe(false);
    });

    it("resets isOpen and devicePath in finally even when close throws", async () => {
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      (platform as jest.Mock).mockReturnValue("darwin");
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      (device as unknown as { closeMacOSDevice: () => Promise<void> }).closeMacOSDevice =
        jest.fn().mockRejectedValue(new Error("close failed"));
      await device.close();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error closing device"),
        "close failed"
      );
      const status = await device.getStatus();
      expect(status.ready).toBe(false);
      await expect(device.close()).resolves.toBeUndefined();
      consoleWarnSpy.mockRestore();
    });

    it("close handles non-Error throw (String branch)", async () => {
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();
      (platform as jest.Mock).mockReturnValue("darwin");
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      (device as unknown as { closeMacOSDevice: () => Promise<void> }).closeMacOSDevice =
        jest.fn().mockRejectedValue("string error");
      await device.close();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error closing device"),
        "string error"
      );
      consoleWarnSpy.mockRestore();
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

    it("returns present and ready on win32 after open", async () => {
      (platform as jest.Mock).mockReturnValue("win32");
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      const status = await device.getStatus();
      expect(status.present).toBe(true);
      expect(status.ready).toBe(true);
      await device.close();
    });

    it("returns present false on linux when devicePath not set", async () => {
      (platform as jest.Mock).mockReturnValue("linux");
      const device = new USBCaptureDevice(deviceId);
      const status = await device.getStatus();
      expect(status.present).toBe(false);
      expect(status.ready).toBe(false);
    });

    it("returns present true on linux when device open and path accessible", async () => {
      (platform as jest.Mock).mockReturnValue("linux");
      mockAccess.mockResolvedValue(undefined);
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      mockAccess.mockResolvedValue(undefined);
      const status = await device.getStatus();
      expect(status.present).toBe(true);
      expect(status.ready).toBe(true);
      await device.close();
    });

    it("returns present false on linux when device path access fails", async () => {
      (platform as jest.Mock).mockReturnValue("linux");
      mockAccess.mockResolvedValueOnce(undefined);
      const device = new USBCaptureDevice(deviceId);
      await device.open();
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
      const status = await device.getStatus();
      expect(status.present).toBe(false);
      expect(status.ready).toBe(false);
      await device.close();
    });

    it("returns base status and logs when platform status method throws", async () => {
      const consoleDebugSpy = jest.spyOn(console, "debug").mockImplementation();
      (platform as jest.Mock).mockReturnValue("darwin");
      const device = new USBCaptureDevice(deviceId);
      (device as unknown as { getMacOSStatus: () => Promise<DeviceStatusT> }).getMacOSStatus =
        jest.fn().mockRejectedValue(new Error("status failed"));
      const status = await device.getStatus();
      expect(status.present).toBe(false);
      expect(status.ready).toBe(false);
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error getting status"),
        "status failed"
      );
      consoleDebugSpy.mockRestore();
    });

    it("getStatus handles non-Error throw (String branch)", async () => {
      const consoleDebugSpy = jest.spyOn(console, "debug").mockImplementation();
      (platform as jest.Mock).mockReturnValue("darwin");
      const device = new USBCaptureDevice(deviceId);
      (device as unknown as { getMacOSStatus: () => Promise<DeviceStatusT> }).getMacOSStatus =
        jest.fn().mockRejectedValue(12345);
      const status = await device.getStatus();
      expect(status.present).toBe(false);
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error getting status"),
        "12345"
      );
      consoleDebugSpy.mockRestore();
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
