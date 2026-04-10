import type { DeviceModule } from "./device-module.js";
import { USBCaptureModule } from "./usb-capture/index.js";
import { DisplayModule } from "./display/index.js";
import { DecklinkModule } from "./decklink/index.js";

jest.mock("./usb-capture/usb-capture-detector.js", () => ({
  USBCaptureDetector: jest.fn().mockImplementation(() => ({
    detect: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("./decklink/decklink-helper.js", () => ({
  watchDecklinkDevices: jest.fn(() => () => {}),
}));

jest.mock("../services/bridge-context.js", () => ({
  getBridgeContext: () => ({ logger: { info: jest.fn() } }),
}));

const mockDecklinkDetect = jest.fn().mockResolvedValue([]);
jest.mock("./decklink/decklink-detector.js", () => ({
  DecklinkDetector: jest.fn().mockImplementation(() => ({
    detect: () => mockDecklinkDetect(),
  })),
}));

describe("device-module", () => {
  describe("DeviceModule interface", () => {
    it("USBCaptureModule implements DeviceModule", () => {
      const m: DeviceModule = new USBCaptureModule();
      expect(m.name).toBe("usb-capture");
      expect(typeof m.detect).toBe("function");
      expect(typeof m.createController).toBe("function");
    });

    it("DisplayModule implements DeviceModule", () => {
      const m: DeviceModule = new DisplayModule();
      expect(m.name).toBe("display");
      expect(typeof m.detect).toBe("function");
      expect(typeof m.createController).toBe("function");
    });

    it("DisplayModule has no watch method", () => {
      const m = new DisplayModule();
      expect("watch" in m).toBe(false);
    });

    it("DecklinkModule implements DeviceModule with optional watch", () => {
      const m: DeviceModule = new DecklinkModule();
      expect(m.name).toBe("decklink");
      expect(typeof m.detect).toBe("function");
      expect(typeof m.createController).toBe("function");
      expect(typeof m.watch).toBe("function");
    });
  });
});
