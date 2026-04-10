import { setBridgeContext } from "../bridge-context.js";
import {
  resolveFrameBusConfig,
  logFrameBusConfigChange,
  applyFrameBusSessionConfig,
} from "./graphics-framebus-session-service.js";

const mockBuildFrameBusConfig = jest.fn();
const mockApplyFrameBusEnv = jest.fn();
jest.mock("./framebus/framebus-config.js", () => ({
  buildFrameBusConfig: (...args: unknown[]) => mockBuildFrameBusConfig(...args),
  applyFrameBusEnv: (...args: unknown[]) => mockApplyFrameBusEnv(...args),
}));

const baseOutputConfig = {
  version: 1 as const,
  outputKey: "stub" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 50 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

const baseFrameBusConfig = {
  name: "fb-1",
  slotCount: 2,
  pixelFormat: 1 as const,
  width: 1920,
  height: 1080,
  fps: 50,
  frameSize: 1920 * 1080 * 4,
  slotStride: 0,
  headerSize: 0,
  size: 0,
};

describe("graphics-framebus-session-service", () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BRIDGE_FRAME_PIXEL_FORMAT;
    delete process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT;
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
    });
    mockBuildFrameBusConfig.mockReturnValue({ ...baseFrameBusConfig });
  });

  describe("resolveFrameBusConfig", () => {
    it("returns result of buildFrameBusConfig", () => {
      const custom = { ...baseFrameBusConfig, name: "custom-name" };
      mockBuildFrameBusConfig.mockReturnValue(custom);

      const result = resolveFrameBusConfig(baseOutputConfig, null);

      expect(result).toEqual(custom);
      expect(mockBuildFrameBusConfig).toHaveBeenCalledWith(
        baseOutputConfig,
        null
      );
    });

    it("logs warn when BRIDGE_FRAME_PIXEL_FORMAT is set and not 1", () => {
      process.env.BRIDGE_FRAME_PIXEL_FORMAT = "2";

      resolveFrameBusConfig(baseOutputConfig, null);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("pixel format 2 not supported")
      );
    });

    it("logs warn when BRIDGE_FRAMEBUS_PIXEL_FORMAT is set and not 1", () => {
      process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = "0";

      resolveFrameBusConfig(baseOutputConfig, null);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("pixel format 0 not supported")
      );
    });
  });

  describe("logFrameBusConfigChange", () => {
    it("does not log when previous and next are equal", () => {
      logFrameBusConfigChange(baseFrameBusConfig, baseFrameBusConfig);

      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it("does not log when previous is null but next has same shape as default", () => {
      logFrameBusConfigChange(null, baseFrameBusConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("[Graphics] FrameBus config")
      );
    });

    it("logs when name differs", () => {
      const next = { ...baseFrameBusConfig, name: "fb-2" };
      logFrameBusConfigChange(baseFrameBusConfig, next);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringMatching(/fb-2.*slotCount.*2/)
      );
    });

    it("logs when slotCount differs", () => {
      const next = { ...baseFrameBusConfig, slotCount: 4 };
      logFrameBusConfigChange(baseFrameBusConfig, next);

      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe("applyFrameBusSessionConfig", () => {
    it("resolves config, applies env, logs change, and returns config", () => {
      const next = { ...baseFrameBusConfig, name: "fb-next" };
      mockBuildFrameBusConfig.mockReturnValue(next);

      const result = applyFrameBusSessionConfig(baseOutputConfig, null);

      expect(result).toEqual(next);
      expect(mockApplyFrameBusEnv).toHaveBeenCalledWith(next);
      expect(mockLogger.info).toHaveBeenCalled();
    });
  });
});
