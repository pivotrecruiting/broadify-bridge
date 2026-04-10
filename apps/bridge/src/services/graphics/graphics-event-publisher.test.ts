import { setBridgeContext } from "../bridge-context.js";
import {
  publishGraphicsStatusEvent,
  publishGraphicsErrorEvent,
} from "./graphics-event-publisher.js";

describe("graphics-event-publisher", () => {
  const mockPublishBridgeEvent = jest.fn();
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
      publishBridgeEvent: mockPublishBridgeEvent,
    });
  });

  describe("publishGraphicsStatusEvent", () => {
    it("publishes graphics_status event with reason and status snapshot", () => {
      const status = {
        outputConfig: { version: 1, outputKey: "stub" as const, targets: {}, format: { width: 1920, height: 1080, fps: 50 }, range: "legal" as const, colorspace: "auto" as const },
        browserInput: {
          mode: "browser_input" as const,
          ready: true,
          stateStatus: "ready" as const,
          stateValid: true,
          browserInputUrl: "http://127.0.0.1:8787/graphics/browser-input",
          browserInputWsUrl: "ws://127.0.0.1:8787/graphics/browser-input/ws",
          recommendedInputName: "Broadify Browser Input",
          transport: "websocket" as const,
          browserClientCount: 1,
          lastBrowserClientSeenAt: 1712345678,
          stateVersion: 4,
          format: { width: 1920, height: 1080, fps: 50 },
          lastError: null,
        },
        activePreset: null,
        activePresets: [],
      };

      publishGraphicsStatusEvent("output_changed", status);

      expect(mockPublishBridgeEvent).toHaveBeenCalledTimes(1);
      expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
        event: "graphics_status",
        data: {
          reason: "output_changed",
          outputConfig: status.outputConfig,
          browserInput: status.browserInput,
          activePreset: status.activePreset,
          activePresets: status.activePresets,
        },
      });
      expect(mockLogger.debug).toHaveBeenCalledWith("[Graphics] Publish status: output_changed");
    });

    it("does nothing when publishBridgeEvent is not set", () => {
      setBridgeContext({
        userDataDir: "/tmp",
        logPath: "/tmp/bridge.log",
        logger: mockLogger,
        publishBridgeEvent: undefined,
      });

      publishGraphicsStatusEvent("test", {
        outputConfig: null,
        browserInput: null,
        activePreset: null,
        activePresets: [],
      });

      expect(mockPublishBridgeEvent).not.toHaveBeenCalled();
    });
  });

  describe("publishGraphicsErrorEvent", () => {
    it("publishes graphics_error event and logs", () => {
      publishGraphicsErrorEvent("renderer_error", "Connection lost");

      expect(mockPublishBridgeEvent).toHaveBeenCalledWith({
        event: "graphics_error",
        data: { code: "renderer_error", message: "Connection lost" },
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[Graphics] Error reported: renderer_error Connection lost"
      );
    });

    it("does nothing when publishBridgeEvent is not set", () => {
      setBridgeContext({
        userDataDir: "/tmp",
        logPath: "/tmp/bridge.log",
        logger: mockLogger,
        publishBridgeEvent: undefined,
      });

      publishGraphicsErrorEvent("output_helper_error", "Device not found");

      expect(mockPublishBridgeEvent).not.toHaveBeenCalled();
    });
  });
});
