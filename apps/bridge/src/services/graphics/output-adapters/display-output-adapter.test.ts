import { DisplayVideoOutputAdapter } from "./display-output-adapter.js";

jest.mock("../../bridge-context.js", () => ({
  getBridgeContext: () => ({ logger: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} } }),
}));

jest.mock("../../device-cache.js", () => ({
  deviceCache: { getDevices: jest.fn().mockResolvedValue([]) },
}));

jest.mock("../../../modules/display/display-helper.js", () => ({
  resolveDisplayHelperPath: () => "/tmp/display-helper",
}));

jest.mock("node:fs/promises", () => ({
  access: jest.fn().mockResolvedValue(undefined),
}));

const baseConfig = {
  outputKey: "video_hdmi" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

describe("DisplayVideoOutputAdapter", () => {
  let adapter: DisplayVideoOutputAdapter;
  const originalPlatform = process.platform;

  beforeEach(() => {
    adapter = new DisplayVideoOutputAdapter();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(async () => {
    await adapter.stop();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  describe("configure", () => {
    it("throws when platform is not darwin or win32", async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "display-1-hdmi" },
        })
      ).rejects.toThrow("only supported on macOS and Windows");
    });

    it("throws when output1Id is missing", async () => {
      await expect(
        adapter.configure({ ...baseConfig, targets: {} })
      ).rejects.toThrow("Missing output port for Display video output");
    });

    it("throws when selected output is not a display device", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "decklink-1",
          type: "decklink",
          displayName: "DeckLink",
          ports: [{ id: "decklink-1-sdi", displayName: "SDI", type: "sdi", direction: "output", role: "video", capabilities: { formats: [] }, status: { available: true } }],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi" },
        })
      ).rejects.toThrow("Selected output is not a display device");
    });

    it("throws when port type is not HDMI/DisplayPort/Thunderbolt", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "display-1",
          type: "display",
          displayName: "Monitor",
          ports: [{ id: "display-1-usb", displayName: "USB", type: "usb", direction: "output", role: "video", capabilities: { formats: [] }, status: { available: true } }],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "display-1-usb" },
        })
      ).rejects.toThrow("Display output requires HDMI/DisplayPort/Thunderbolt");
    });
  });
});
