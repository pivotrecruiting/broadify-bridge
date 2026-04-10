import {
  buildFrameBusConfig,
  applyFrameBusEnv,
  clearFrameBusEnv,
  type FrameBusConfigT,
} from "./framebus-config.js";

const createOutputConfig = () => ({
  version: 1,
  outputKey: "video_hdmi" as const,
  targets: { output1Id: "display-1" },
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal" as const,
  colorspace: "auto" as const,
});

describe("framebus-config", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    clearFrameBusEnv();
    originalEnv.BRIDGE_FRAMEBUS_NAME = process.env.BRIDGE_FRAMEBUS_NAME;
    originalEnv.BRIDGE_FRAMEBUS_SLOT_COUNT = process.env.BRIDGE_FRAMEBUS_SLOT_COUNT;
    originalEnv.BRIDGE_FRAMEBUS_PIXEL_FORMAT = process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT;
  });

  afterEach(() => {
    clearFrameBusEnv();
    if (originalEnv.BRIDGE_FRAMEBUS_NAME !== undefined) {
      process.env.BRIDGE_FRAMEBUS_NAME = originalEnv.BRIDGE_FRAMEBUS_NAME;
    }
    if (originalEnv.BRIDGE_FRAMEBUS_SLOT_COUNT !== undefined) {
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = originalEnv.BRIDGE_FRAMEBUS_SLOT_COUNT;
    }
    if (originalEnv.BRIDGE_FRAMEBUS_PIXEL_FORMAT !== undefined) {
      process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = originalEnv.BRIDGE_FRAMEBUS_PIXEL_FORMAT;
    }
  });

  describe("buildFrameBusConfig", () => {
    it("uses outputConfig format dimensions", () => {
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.width).toBe(1920);
      expect(config.height).toBe(1080);
      expect(config.fps).toBe(30);
    });

    it("uses BRIDGE_FRAMEBUS_NAME when set", () => {
      process.env.BRIDGE_FRAMEBUS_NAME = "custom-bus";
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.name).toBe("custom-bus");
    });

    it("uses previous name when env not set", () => {
      const previous: FrameBusConfigT = {
        name: "previous-bus",
        slotCount: 2,
        pixelFormat: 1,
        width: 1920,
        height: 1080,
        fps: 30,
        frameSize: 0,
        slotStride: 0,
        headerSize: 128,
        size: 0,
      };
      const config = buildFrameBusConfig(createOutputConfig(), previous);
      expect(config.name).toBe("previous-bus");
    });

    it("generates new name when no env and no previous", () => {
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.name).toMatch(/^broadify-framebus-[a-f0-9]{12}$/);
    });

    it("computes frameSize and layout from format", () => {
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.frameSize).toBe(1920 * 1080 * 4);
      expect(config.slotStride).toBe(config.frameSize);
      expect(config.headerSize).toBe(128);
    });

    it("uses BRIDGE_FRAMEBUS_SLOT_COUNT when valid", () => {
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "4";
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.slotCount).toBe(4);
    });

    it("falls back to default when BRIDGE_FRAMEBUS_SLOT_COUNT is invalid", () => {
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "1";
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.slotCount).toBe(2);
    });

    it("uses BRIDGE_FRAME_PIXEL_FORMAT when 1", () => {
      process.env.BRIDGE_FRAME_PIXEL_FORMAT = "1";
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.pixelFormat).toBe(1);
    });

    it("falls back to default when BRIDGE_FRAME_PIXEL_FORMAT is not 1", () => {
      process.env.BRIDGE_FRAME_PIXEL_FORMAT = "2";
      const config = buildFrameBusConfig(createOutputConfig(), null);
      expect(config.pixelFormat).toBe(1);
    });

    it("uses previous slotCount when env invalid", () => {
      const previous: FrameBusConfigT = {
        name: "prev",
        slotCount: 3,
        pixelFormat: 1,
        width: 1920,
        height: 1080,
        fps: 30,
        frameSize: 0,
        slotStride: 0,
        headerSize: 128,
        size: 0,
      };
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "x";
      const config = buildFrameBusConfig(createOutputConfig(), previous);
      expect(config.slotCount).toBe(3);
    });
  });

  describe("applyFrameBusEnv and clearFrameBusEnv", () => {
    it("sets and clears env vars", () => {
      const config: FrameBusConfigT = {
        name: "test",
        slotCount: 2,
        pixelFormat: 1,
        width: 1920,
        height: 1080,
        fps: 30,
        frameSize: 8294400,
        slotStride: 8294400,
        headerSize: 128,
        size: 16588928,
      };
      applyFrameBusEnv(config);
      expect(process.env.BRIDGE_FRAMEBUS_NAME).toBe("test");
      expect(process.env.BRIDGE_FRAME_WIDTH).toBe("1920");
      clearFrameBusEnv();
      expect(process.env.BRIDGE_FRAMEBUS_NAME).toBeUndefined();
      expect(process.env.BRIDGE_FRAME_WIDTH).toBeUndefined();
    });
  });
});
