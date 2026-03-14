import { platform } from "node:os";
import { USBCaptureDetector } from "./usb-capture-detector.js";

jest.mock("node:os", () => ({
  platform: jest.fn(),
}));

describe("USBCaptureDetector", () => {
  const consoleSpy = {
    debug: jest.spyOn(console, "debug").mockImplementation(() => {}),
    warn: jest.spyOn(console, "warn").mockImplementation(() => {}),
  };

  afterAll(() => {
    consoleSpy.debug.mockRestore();
    consoleSpy.warn.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("detect", () => {
    it("returns empty array on unsupported platform", async () => {
      (platform as jest.Mock).mockReturnValue("sunos");

      const detector = new USBCaptureDetector();
      const result = await detector.detect();

      expect(result).toEqual([]);
      expect(consoleSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported platform: sunos")
      );
    });

    it("returns array (empty or with devices) on supported platform", async () => {
      (platform as jest.Mock).mockReturnValue("darwin");

      const detector = new USBCaptureDetector();
      const result = await detector.detect();

      expect(Array.isArray(result)).toBe(true);
      result.forEach((device) => {
        expect(device).toHaveProperty("id");
        expect(device).toHaveProperty("type", "usb-capture");
        expect(device).toHaveProperty("ports");
        expect(device).toHaveProperty("status");
      });
    });
  });
});
