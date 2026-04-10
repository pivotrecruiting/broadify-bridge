import { DecklinkDevice } from "./decklink-device.js";

describe("decklink-device", () => {
  let device: DecklinkDevice;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    device = new DecklinkDevice("decklink-1");
    consoleSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("open", () => {
    it("resolves without error", async () => {
      await expect(device.open()).resolves.toBeUndefined();
    });

    it("logs open request", async () => {
      await device.open();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[DecklinkDevice] open requested for decklink-1"
      );
    });
  });

  describe("close", () => {
    it("resolves without error", async () => {
      await expect(device.close()).resolves.toBeUndefined();
    });

    it("logs close request", async () => {
      await device.close();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[DecklinkDevice] close requested for decklink-1"
      );
    });
  });

  describe("getStatus", () => {
    it("returns status with present, inUse, ready, signal, lastSeen", async () => {
      const status = await device.getStatus();
      expect(status).toMatchObject({
        present: true,
        inUse: false,
        ready: true,
        signal: "none",
      });
      expect(typeof status.lastSeen).toBe("number");
    });
  });
});
