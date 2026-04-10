import { USBCaptureModule } from "./index.js";
import { USBCaptureDevice } from "./usb-capture-device.js";

const mockDetect = jest.fn().mockResolvedValue([]);
jest.mock("./usb-capture-detector.js", () => ({
  USBCaptureDetector: jest.fn().mockImplementation(() => ({
    detect: () => mockDetect(),
  })),
}));

describe("USBCaptureModule", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetect.mockResolvedValue([]);
  });

  describe("name", () => {
    it("exposes module name usb-capture", () => {
      const module = new USBCaptureModule();
      expect(module.name).toBe("usb-capture");
    });
  });

  describe("detect", () => {
    it("delegates to detector.detect and returns result", async () => {
      const devices = [
        {
          id: "usb-1",
          displayName: "USB Camera",
          type: "usb-capture" as const,
          vendor: "Vendor",
          model: "Model",
          driver: "AVFoundation",
          ports: [],
          status: {
            present: true,
            inUse: false,
            ready: true,
            lastSeen: Date.now(),
          },
        },
      ];
      mockDetect.mockResolvedValue(devices);

      const module = new USBCaptureModule();
      const result = await module.detect();

      expect(mockDetect).toHaveBeenCalledTimes(1);
      expect(result).toEqual(devices);
    });

    it("returns empty array when detector returns empty", async () => {
      const module = new USBCaptureModule();
      const result = await module.detect();
      expect(result).toEqual([]);
    });
  });

  describe("createController", () => {
    it("returns USBCaptureDevice instance for given deviceId", () => {
      const module = new USBCaptureModule();
      const controller = module.createController("usb-capture-device-123");
      expect(controller).toBeInstanceOf(USBCaptureDevice);
    });
  });
});
