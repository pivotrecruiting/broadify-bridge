import { setBridgeContext } from "../bridge-context.js";
import {
  __setMeetingHelperPathForTesting,
  findFreePort,
  MeetingHelperManager,
  resolveMeetingHelperPath,
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
      expect(status.lastError).toContain("Meeting helper not found");
      expect(manager.isRunning()).toBe(false);
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
