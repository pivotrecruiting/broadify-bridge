import { normalize } from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import {
  HELPER_NOT_REACHABLE_CODE,
  MeetingHelperRequestError,
} from "./meeting-helper-client.js";
import {
  __setMeetingHelperPathForTesting,
  findFreePort,
  inspectDeviceEntitlementStatuses,
  MeetingHelperManager,
  parseWindowsProcessImageName,
  parseWindowsTcpListenPids,
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

  describe("inspectDeviceEntitlementStatuses", () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const childProcess = require("node:child_process");

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("reads both device entitlements from a single codesign spawn", () => {
      jest.spyOn(os, "platform").mockReturnValue("darwin");
      jest.spyOn(fs, "existsSync").mockReturnValue(true);
      const spawnSpy = jest
        .spyOn(childProcess, "spawnSync")
        .mockReturnValue({
          status: 0,
          stdout:
            "<key>com.apple.security.device.camera</key><true/>",
          stderr: "",
        } as never);

      expect(inspectDeviceEntitlementStatuses("/tmp/helper")).toEqual({
        camera: "present",
        microphone: "missing",
      });
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });

    it("reports present for both keys when the packaged helper keeps them", () => {
      jest.spyOn(os, "platform").mockReturnValue("darwin");
      jest.spyOn(fs, "existsSync").mockReturnValue(true);
      jest.spyOn(childProcess, "spawnSync").mockReturnValue({
        status: 0,
        stdout:
          "<key>com.apple.security.device.camera</key><true/>" +
          "<key>com.apple.security.device.audio-input</key><true/>",
        stderr: "",
      } as never);

      expect(inspectDeviceEntitlementStatuses("/tmp/helper")).toEqual({
        camera: "present",
        microphone: "present",
      });
    });

    it("flags unreadable entitlements as invalid for both devices", () => {
      jest.spyOn(os, "platform").mockReturnValue("darwin");
      jest.spyOn(fs, "existsSync").mockReturnValue(true);
      jest.spyOn(childProcess, "spawnSync").mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "code object is not signed at all",
      } as never);

      expect(inspectDeviceEntitlementStatuses("/tmp/helper")).toEqual({
        camera: "invalid",
        microphone: "invalid",
      });
    });
  });

  describe("findFreePort", () => {
    const net = require("node:net");

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("returns a usable localhost port", async () => {
      jest.spyOn(net, "createServer").mockReturnValue({
        once: jest.fn(),
        listen: jest.fn((_port: number, _host: string, callback: () => void) => {
          callback();
        }),
        address: jest.fn(() => ({ port: 32123 })),
        close: jest.fn((callback: () => void) => callback()),
      } as never);

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

  describe("Windows stale VCam port parsers", () => {
    it("extracts listening PIDs for the requested local port", () => {
      const output = [
        "  Proto  Local Address          Foreign Address        State           PID",
        "  TCP    127.0.0.1:18787        0.0.0.0:0              LISTENING       1234",
        "  TCP    0.0.0.0:18787          0.0.0.0:0              LISTENING       5678",
        "  TCP    127.0.0.1:18788        0.0.0.0:0              LISTENING       9999",
        "  TCP    127.0.0.1:18787        127.0.0.1:50000        ESTABLISHED     7777",
      ].join("\r\n");

      expect(parseWindowsTcpListenPids(output, 18787)).toEqual([1234, 5678]);
    });

    it("parses CSV tasklist image names", () => {
      expect(
        parseWindowsProcessImageName(
          '"meeting-helper.exe","1234","Console","1","42,000 K"\r\n',
        ),
      ).toBe("meeting-helper.exe");
      expect(parseWindowsProcessImageName("INFO: No tasks are running")).toBeNull();
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

    it("restores virtual camera after replaying camera calls on restart", async () => {
      const manager = new MeetingHelperManager();
      const calls: string[] = [];
      const client = {
        cameraStart: jest.fn(async () => {
          calls.push("cameraStart");
        }),
        cameraSelect: jest.fn(async () => {
          calls.push("cameraSelect");
        }),
        virtualCameraStart: jest.fn(async () => {
          calls.push("virtualCameraStart");
        }),
      };
      const internals = manager as unknown as {
        client: typeof client;
        restoreRuntimeConfig: () => Promise<void>;
      };
      internals.client = client;
      manager.noteCameraCall("cameraStart", { stable_key: "cam-a" });
      manager.noteCameraCall("cameraSelect", { stable_key: "cam-b" });
      manager.noteVirtualCameraStarted();

      await internals.restoreRuntimeConfig();

      expect(calls).toEqual([
        "cameraStart",
        "cameraSelect",
        "virtualCameraStart",
      ]);
      expect(client.virtualCameraStart).toHaveBeenCalledWith({
        allowElevation: false,
      });
    });

    it("records VCam raw bind failures from helper stdout and rejects readiness", () => {
      const manager = new MeetingHelperManager();
      const readyRejecter = jest.fn();
      const internals = manager as unknown as {
        vcamRawBindFailed: string | null;
        lastError: string | null;
        readyRejecter: (error: Error) => void;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.readyRejecter = readyRejecter;

      internals.handleStdoutLine(
        JSON.stringify({
          type: "meeting_vcam_raw",
          event: "error",
          code: "vcam_raw_bind_failed",
          message: "bind failed",
        }),
        mockLogger,
      );

      expect(internals.vcamRawBindFailed).toBe("bind failed");
      expect(internals.lastError).toBe("bind failed");
      expect(readyRejecter).toHaveBeenCalledWith(
        expect.objectContaining({ code: "vcam_raw_bind_failed" }),
      );
      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "meeting_error",
          data: expect.objectContaining({ code: "vcam_raw_bind_failed" }),
        }),
      );
    });

    it("getFullStatus returns manager status without helper when stopped", async () => {
      const manager = new MeetingHelperManager();
      const status = await manager.getFullStatus();

      expect(status).toEqual({
        manager: expect.objectContaining({ state: "stopped" }),
        engine: null,
        recording: null,
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

    it("derives the deck REC mirror from the published snapshot (WP-2.4)", async () => {
      const { streamDeckManager } =
        require("../streamdeck/stream-deck-manager.js");
      const recSpy = jest.spyOn(streamDeckManager, "setRecordingActive");
      try {
        const manager = new MeetingHelperManager();
        await manager.stop();

        // Engine down -> snapshot has recording: null -> the single writer
        // resets the key. No other code path may touch setRecordingActive.
        expect(recSpy).toHaveBeenCalledWith(false);
      } finally {
        recSpy.mockRestore();
      }
    });

    describe("shutdown race (B1.4)", () => {
      type ManagerInternalsT = {
        state: string;
        restartTimer: NodeJS.Timeout | null;
        handleProcessExit: (code: number | null) => void;
      };

      const simulateExitWhileRunning = (
        manager: MeetingHelperManager,
      ): ManagerInternalsT => {
        const internals = manager as unknown as ManagerInternalsT;
        internals.state = "running";
        internals.handleProcessExit(null);
        return internals;
      };

      it("still schedules a crash restart when the helper exits while running", () => {
        // "Before" guard for the fix below: without beginShutdown() an
        // unexpected exit keeps the existing crash-recovery behavior.
        const manager = new MeetingHelperManager();
        const internals = simulateExitWhileRunning(manager);

        expect(internals.state).toBe("error");
        expect(internals.restartTimer).not.toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("restart attempt 1/3"),
        );

        // Disarm the pending restart so it cannot fire into other tests.
        manager.beginShutdown();
        expect(internals.restartTimer).toBeNull();
      });

      it("does not classify the exit as a crash after beginShutdown()", () => {
        const manager = new MeetingHelperManager();
        manager.beginShutdown();
        const internals = simulateExitWhileRunning(manager);

        // Exit code null is a normal termination during shutdown.
        expect(internals.state).toBe("stopped");
        expect(internals.restartTimer).toBeNull();
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("restart attempt"),
        );
      });
    });

    describe("control channel liveness", () => {
      type LivenessInternalsT = {
        state: string;
        client: unknown;
        process: unknown;
        restartTimer: NodeJS.Timeout | null;
        handleProcessExit: (code: number | null) => void;
      };

      const notReachable = () =>
        Promise.reject(
          new MeetingHelperRequestError(
            HELPER_NOT_REACHABLE_CODE,
            "Meeting helper control socket not reachable (ENOENT)",
          ),
        );

      const armRunningManager = (
        getState: jest.Mock,
      ): { manager: MeetingHelperManager; internals: LivenessInternalsT; kill: jest.Mock } => {
        const manager = new MeetingHelperManager();
        const internals = manager as unknown as LivenessInternalsT;
        const kill = jest.fn();
        internals.state = "running";
        internals.client = {
          getState,
          framebusStatus: jest.fn().mockResolvedValue({}),
          keyerGet: jest.fn().mockResolvedValue({}),
          recordingStatus: jest.fn().mockResolvedValue({ recording: null }),
          // W2 added output.vcam.status to the snapshot (best effort).
          virtualCameraStatus: jest.fn().mockResolvedValue(null),
        };
        internals.process = {
          pid: 4242,
          kill,
          // killProcess() arms a 3 s SIGKILL fallback cleared on exit; fire
          // the exit listener right away so no timer leaks into other tests.
          once: (_event: string, listener: () => void) => listener(),
        };
        return { manager, internals, kill };
      };

      it("kills the helper once after 5 consecutive connect failures and lets the exit path restart it", async () => {
        const { manager, internals, kill } = armRunningManager(
          jest.fn().mockImplementation(notReachable),
        );

        for (let i = 0; i < 4; i += 1) {
          await manager.getFullStatus();
        }
        expect(kill).not.toHaveBeenCalled();

        await manager.getFullStatus();
        expect(kill).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalledWith("SIGTERM");
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("pid 4242"),
        );
        expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "meeting_error",
            data: expect.objectContaining({ code: "helper_control_channel_lost" }),
          }),
        );
        const lostEvents = mockPublishBridgeEvent.mock.calls.filter(
          ([event]) => event?.data?.code === "helper_control_channel_lost",
        );
        expect(lostEvents).toHaveLength(1);

        // The child's exit handler classifies the kill as a crash -> restart.
        internals.handleProcessExit(null);
        expect(internals.state).toBe("error");
        expect(internals.restartTimer).not.toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("restart attempt 1/3"),
        );
        manager.beginShutdown();
        expect(internals.restartTimer).toBeNull();
      });

      it("resets the failure counter on a successful snapshot", async () => {
        const getState = jest
          .fn()
          .mockImplementationOnce(notReachable)
          .mockImplementationOnce(notReachable)
          .mockImplementationOnce(notReachable)
          .mockImplementationOnce(notReachable)
          .mockResolvedValueOnce({ ok: true })
          .mockImplementation(notReachable);
        const { manager, kill } = armRunningManager(getState);

        for (let i = 0; i < 9; i += 1) {
          await manager.getFullStatus();
        }
        expect(kill).not.toHaveBeenCalled();
        expect(mockPublishBridgeEvent).not.toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ code: "helper_control_channel_lost" }),
          }),
        );
      });

      it("restarts after repeated status-poll timeouts", async () => {
        const { manager, kill } = armRunningManager(
          jest.fn().mockRejectedValue(
            new MeetingHelperRequestError("timeout", "timed out"),
          ),
        );

        for (let i = 0; i < 8; i += 1) {
          await manager.getFullStatus();
        }
        expect(kill).toHaveBeenCalledWith("SIGTERM");
      });

      it("win32 kill still terminates when graceful shutdown rejects", async () => {
        const os = require("node:os");
        jest.spyOn(os, "platform").mockReturnValue("win32");
        jest.useFakeTimers();
        const manager = new MeetingHelperManager();
        const internals = manager as unknown as {
          state: string;
          client: { shutdown: jest.Mock };
          process: {
            pid: number;
            kill: jest.Mock;
            once: jest.Mock;
          } | null;
          killProcess: () => void;
        };
        const kill = jest.fn();
        internals.state = "running";
        internals.client = {
          shutdown: jest.fn().mockRejectedValue(
            new MeetingHelperRequestError(
              HELPER_NOT_REACHABLE_CODE,
              "Meeting helper control socket not reachable (ENOENT)",
            ),
          ),
        };
        internals.process = {
          pid: 4242,
          kill,
          once: jest.fn((_event: string, listener: () => void) => listener()),
        };

        try {
          internals.killProcess();
          await jest.advanceTimersByTimeAsync(0);

          expect(internals.client.shutdown).toHaveBeenCalledTimes(1);
          expect(kill).toHaveBeenCalledWith("SIGTERM");
        } finally {
          jest.useRealTimers();
          jest.restoreAllMocks();
        }
      });
    });

    it("notifyRecordingChanged force-publishes a status snapshot", async () => {
      const manager = new MeetingHelperManager();
      manager.notifyRecordingChanged();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: "meeting_status" }),
      );
    });
  });
  describe("status polling", () => {
    type PollingInternalsT = {
      startStatusPolling: () => void;
      stopStatusPolling: () => void;
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    it("skips poll ticks while the previous publish is still in flight", async () => {
      jest.useFakeTimers();
      const manager = new MeetingHelperManager();
      const internals = manager as unknown as PollingInternalsT;
      let resolveFirst: (() => void) | null = null;
      const getFullStatusSpy = jest
        .spyOn(manager, "getFullStatus")
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveFirst = () =>
                resolve({ manager: { state: "running" }, engine: null, recording: null });
            }),
        );

      internals.startStatusPolling();
      await jest.advanceTimersByTimeAsync(2000);
      expect(getFullStatusSpy).toHaveBeenCalledTimes(1);

      // Second and third ticks arrive while the first RPC is still pending.
      await jest.advanceTimersByTimeAsync(4000);
      expect(getFullStatusSpy).toHaveBeenCalledTimes(1);

      resolveFirst?.();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2000);
      expect(getFullStatusSpy).toHaveBeenCalledTimes(2);

      internals.stopStatusPolling();
    });

    it("throttles counter-only status changes but publishes state changes at once", async () => {
      const manager = new MeetingHelperManager();
      let frames = 0;
      let camera = 0;
      jest.spyOn(manager, "getFullStatus").mockImplementation(async () => ({
        manager: { state: "running" },
        engine: { active_camera_index: camera, rendered_frames: (frames += 1) },
        recording: null,
      }));
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
      };
      const statusEvents = () =>
        mockPublishBridgeEvent.mock.calls.filter(
          ([event]) => (event as { event: string }).event === "meeting_status",
        ).length;

      await internals.publishStatus("status_poll", false);
      expect(statusEvents()).toBe(1);
      await internals.publishStatus("status_poll", false);
      expect(statusEvents()).toBe(1);

      camera = 1;
      await internals.publishStatus("status_poll", false);
      expect(statusEvents()).toBe(2);
    });
  });
});
