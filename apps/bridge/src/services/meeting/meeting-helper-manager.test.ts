import { normalize } from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import {
  __setMeetingHelperPathForTesting,
  findFreePort,
  MeetingHelperManager,
  resolveMeetingHelperPath,
  resolveMeetingHelperForwardedEnvArgs,
  resolveMeetingModelsDir,
} from "./meeting-helper-manager.js";

describe("meeting-helper-manager", () => {
  const mockPublishBridgeEvent = jest.fn();
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BRIDGE_MEETING_HELPER_PATH;
    delete process.env.BRIDGE_MEETING_CONTROL_SOCKET;
    delete process.env.BRIDGE_MEETING_FRAMEBUS_NAME;
    delete process.env.BRIDGE_MEETING_MODELS_DIR;
    __setMeetingHelperPathForTesting(null);
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
      publishBridgeEvent: mockPublishBridgeEvent,
    });
  });

  describe("findFreePort", () => {
    it("returns a usable localhost port", async () => {
      const port = await findFreePort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    });
  });

  describe("resolveMeetingHelperPath", () => {
    it("prefers the BRIDGE_MEETING_HELPER_PATH env override", () => {
      process.env.BRIDGE_MEETING_HELPER_PATH = "/custom/meeting-helper";
      expect(resolveMeetingHelperPath()).toBe("/custom/meeting-helper");
    });

    it("allows a test-only path override", () => {
      __setMeetingHelperPathForTesting("/tmp/test-helper");
      expect(resolveMeetingHelperPath()).toBe("/tmp/test-helper");
    });
  });

  describe("resolveMeetingModelsDir", () => {
    it("prefers the BRIDGE_MEETING_MODELS_DIR env override", () => {
      process.env.BRIDGE_MEETING_MODELS_DIR = "/custom/models";

      expect(resolveMeetingModelsDir("/tmp/meeting-helper")).toBe(
        "/custom/models",
      );
    });

    it("resolves models beside a macOS helper app bundle in development", () => {
      expect(
        resolveMeetingModelsDir(
          "/repo/apps/bridge/native/meeting-helper/Broadify Bridge Meeting Helper.app/Contents/MacOS/BroadifyMeetingHelper",
        ),
      ).toBe(normalize("/repo/apps/bridge/native/meeting-helper/models"));
    });

    it("resolves models beside a standalone helper", () => {
      expect(resolveMeetingModelsDir("/repo/native/meeting-helper")).toBe(
        normalize("/repo/native/models"),
      );
    });
  });

  describe("resolveMeetingHelperForwardedEnvArgs", () => {
    it("forwards only allowlisted meeting helper tuning values", () => {
      expect(
        resolveMeetingHelperForwardedEnvArgs({
          BROADIFY_MEETING_GPU_PIPELINE: "0",
          BROADIFY_MEETING_COREML_UNITS: "cpuAndNeuralEngine",
          BROADIFY_MEETING_FUTURE_SECRET: "do-not-forward",
          UNRELATED_VALUE: "ignored",
        }),
      ).toEqual([
        "--env",
        "BROADIFY_MEETING_COREML_UNITS=cpuAndNeuralEngine",
        "--env",
        "BROADIFY_MEETING_GPU_PIPELINE=0",
      ]);
    });

    it("rejects unsafe forwarded values", () => {
      expect(
        resolveMeetingHelperForwardedEnvArgs({
          BROADIFY_MEETING_GPU_PIPELINE: "0\nBROADIFY_MEETING_GPU_REFINE=0",
        }),
      ).toEqual([]);
    });
  });

  describe("MeetingHelperManager", () => {
    it("starts in stopped state without client", () => {
      const manager = new MeetingHelperManager();
      const status = manager.getStatus();

      expect(status.state).toBe("stopped");
      expect(status.port).toBeNull();
      expect(status.pid).toBeNull();
      expect(manager.getClient()).toBeNull();
      expect(manager.isRunning()).toBe(false);
    });

    it("uses the default framebus name", () => {
      const manager = new MeetingHelperManager();
      expect(manager.getFramebusName()).toBe("broadify-meeting-framebus");
    });

    it("honors BRIDGE_MEETING_FRAMEBUS_NAME", () => {
      process.env.BRIDGE_MEETING_FRAMEBUS_NAME = "custom-bus";
      const manager = new MeetingHelperManager();
      expect(manager.getFramebusName()).toBe("custom-bus");
    });

    it("reports an error when the helper binary is missing", async () => {
      __setMeetingHelperPathForTesting("/nonexistent-meeting-helper");

      const manager = new MeetingHelperManager();
      const status = await manager.start();

      expect(status.state).toBe("error");
      expect(status.lastError).toBe("Meeting helper is not installed.");
      expect(manager.isRunning()).toBe(false);
      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "meeting_error",
          data: expect.objectContaining({ code: "helper_missing" }),
        }),
      );
      expect(mockPublishBridgeEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({
          event: "meeting_error",
          data: expect.objectContaining({ code: "helper_codesign_invalid" }),
        }),
      );
    });

    it("getFullStatus returns manager status without helper when stopped", async () => {
      const manager = new MeetingHelperManager();
      const status = await manager.getFullStatus();

      expect(status).toEqual({
        manager: expect.objectContaining({ state: "stopped" }),
        engine: null,
      });
    });

    it("stop publishes a meeting_status event", async () => {
      const manager = new MeetingHelperManager();
      await manager.stop();

      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "meeting_status",
        }),
      );
    });
  });
});
