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

    it("explicit name override wins over env, previous, and generation", () => {
      // The env var is process-global state mutated around awaits; the
      // override is how the dual meeting managers pin their fixed bus name.
      process.env.BRIDGE_FRAMEBUS_NAME = "bfy-meet-gfx-back";
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
      const config = buildFrameBusConfig(createOutputConfig(), previous, {
        name: "bfy-meet-gfx-front",
      });
      expect(config.name).toBe("bfy-meet-gfx-front");
    });

    it("explicit slotCount override wins over env", () => {
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "2";
      const config = buildFrameBusConfig(createOutputConfig(), null, {
        slotCount: 3,
      });
      expect(config.slotCount).toBe(3);
    });

    it("invalid override values fall back to the env path", () => {
      process.env.BRIDGE_FRAMEBUS_NAME = "env-bus";
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "4";
      const config = buildFrameBusConfig(createOutputConfig(), null, {
        name: "   ",
        slotCount: 1,
      });
      expect(config.name).toBe("env-bus");
      expect(config.slotCount).toBe(4);
    });

    it("without overrides the env path stays bit-identical (Studio)", () => {
      process.env.BRIDGE_FRAMEBUS_NAME = "studio-bus";
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "4";
      const withUndefined = buildFrameBusConfig(createOutputConfig(), null, undefined);
      const withoutParam = buildFrameBusConfig(createOutputConfig(), null);
      expect(withUndefined).toEqual(withoutParam);
      expect(withUndefined.name).toBe("studio-bus");
      expect(withUndefined.slotCount).toBe(4);
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
