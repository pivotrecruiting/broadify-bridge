import { DecklinkModule } from "./index.js";
import { DecklinkDetector } from "./decklink-detector.js";

const mockDetect = jest.fn().mockResolvedValue([]);
jest.mock("./decklink-detector.js", () => ({
  DecklinkDetector: jest.fn().mockImplementation(() => ({
    detect: () => mockDetect(),
  })),
}));

jest.mock("./decklink-helper.js", () => ({
  watchDecklinkDevices: jest.fn((_callback: (event: unknown) => void) => {
    return () => {};
  }),
}));

jest.mock("../../services/bridge-context.js", () => ({
  getBridgeContext: () => ({ logger: { info: jest.fn() } }),
}));

describe("DecklinkModule", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetect.mockResolvedValue([]);
  });

  describe("name", () => {
    it("exposes module name decklink", () => {
      const module = new DecklinkModule();
      expect(module.name).toBe("decklink");
    });
  });

  describe("detect", () => {
    it("delegates to detector and returns result", async () => {
      const devices = [
        {
          id: "decklink-1",
          displayName: "DeckLink Mini",
          type: "decklink" as const,
          ports: [],
          status: { present: true, inUse: false, ready: true, lastSeen: Date.now() },
        },
      ];
      mockDetect.mockResolvedValue(devices);

      const module = new DecklinkModule();
      const result = await module.detect();

      expect(DecklinkDetector).toHaveBeenCalled();
      expect(mockDetect).toHaveBeenCalledTimes(1);
      expect(result).toEqual(devices);
    });

    it("returns empty array when detector returns empty", async () => {
      const module = new DecklinkModule();
      const result = await module.detect();
      expect(result).toEqual([]);
    });
  });

  describe("createController", () => {
    it("returns DecklinkDevice instance for given deviceId", async () => {
      const { DecklinkDevice } = await import("./decklink-device.js");
      const module = new DecklinkModule();
      const controller = module.createController("decklink-1");
      expect(controller).toBeInstanceOf(DecklinkDevice);
    });
  });

  describe("watch", () => {
    it("returns unsubscribe function", async () => {
      const { watchDecklinkDevices } = await import("./decklink-helper.js");
      const module = new DecklinkModule();
      const unsubscribe = module.watch!(() => {});
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
      expect(watchDecklinkDevices).toHaveBeenCalled();
    });
  });
});
