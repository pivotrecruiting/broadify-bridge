import { normalize } from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import {
  diffMeetingSummary,
  summarizeMeetingStatus,
} from "../session-log/meeting-session-events.js";
import { recordSwitcherEvent } from "../session-log/session-log-service.js";
import { noteMeetingStatusForRecordingUpload } from "../postpro/recording-upload-service.js";
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
import {
  MEETING_RECORDING_PROBE_MAX_ATTEMPTS,
  runMeetingRecordingProbe,
  type MeetingRecordingProbeOutcomeT,
} from "./meeting-recording-probe.js";
import type { MeetingStatusT } from "./meeting-status-types.js";

// The encoder probe is its own helper process; the manager tests script it.
jest.mock("./meeting-recording-probe.js", () => ({
  ...jest.requireActual("./meeting-recording-probe.js"),
  runMeetingRecordingProbe: jest.fn(),
}));

// SessionEventLog sink and status diff spied (real implementations); the
// on/off switch (isSessionLogEnabled) stays real.
jest.mock("../session-log/session-log-service.js", () => ({
  ...jest.requireActual("../session-log/session-log-service.js"),
  recordSwitcherEvent: jest.fn(),
}));
jest.mock("../postpro/recording-upload-service.js", () => ({
  noteMeetingStatusForRecordingUpload: jest.fn(),
}));
jest.mock("../session-log/meeting-session-events.js", () => {
  const actual = jest.requireActual("../session-log/meeting-session-events.js");
  return {
    ...actual,
    summarizeMeetingStatus: jest.fn(actual.summarizeMeetingStatus),
    diffMeetingSummary: jest.fn(actual.diffMeetingSummary),
  };
});

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

  describe("recording encoder probe", () => {
    const mockRunProbe = jest.mocked(runMeetingRecordingProbe);
    const PROBE = {
      backend: "videotoolbox",
      encoders: [{ codec: "h264" as const, name: "Apple H.264 (HW)" }],
    };

    beforeEach(() => {
      __setMeetingHelperPathForTesting("/path/to/meeting-helper");
    });

    it("runs the helper's probe mode once and hands every caller the same result", async () => {
      let finish!: (outcome: MeetingRecordingProbeOutcomeT) => void;
      mockRunProbe.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const manager = new MeetingHelperManager();

      const first = manager.probeRecordingEncoders();
      const second = manager.probeRecordingEncoders();
      // Not known yet: the synchronous read neither waits nor starts a run.
      expect(manager.getRecordingProbe()).toBeNull();
      expect(manager.getRecordingProbeState()).toBe("pending");
      finish({ ok: true, probe: PROBE });

      expect(await first).toEqual(PROBE);
      expect(await second).toEqual(PROBE);
      expect(await manager.probeRecordingEncoders()).toEqual(PROBE);
      expect(manager.getRecordingProbe()).toEqual(PROBE);
      expect(manager.getRecordingProbeState()).toBe("done");
      expect(mockRunProbe).toHaveBeenCalledTimes(1);
      expect(mockRunProbe).toHaveBeenCalledWith("/path/to/meeting-helper");
      expect(mockLogger.info).toHaveBeenCalledWith(
        "[Meeting] Recording encoder probe: backend=videotoolbox hardware_codecs=h264",
      );
    });

    it.each(["invalid_output", "helper_missing", "enumeration_failed"] as const)(
      "keeps a definitive failure (%s) for the bridge run and logs it once",
      async (reason) => {
        mockRunProbe.mockResolvedValue({ ok: false, reason });
        const manager = new MeetingHelperManager();

        expect(await manager.probeRecordingEncoders()).toBeNull();
        expect(await manager.probeRecordingEncoders()).toBeNull();

        expect(manager.getRecordingProbe()).toBeNull();
        expect(manager.getRecordingProbeState()).toBe("failed");
        expect(mockRunProbe).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          `[Meeting] Recording encoder probe failed (${reason}); recording formats are not advertised.`,
        );
      },
    );

    it.each(["timeout", "spawn_failed"] as const)(
      "retries a transient failure (%s) in the background, without making later callers wait",
      async (reason) => {
        let finishRetry!: (outcome: MeetingRecordingProbeOutcomeT) => void;
        mockRunProbe
          .mockResolvedValueOnce({ ok: false, reason })
          .mockReturnValueOnce(
            new Promise((resolve) => {
              finishRetry = resolve;
            }),
          );
        const manager = new MeetingHelperManager();

        // The first caller waits for the first run.
        expect(await manager.probeRecordingEncoders()).toBeNull();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          `[Meeting] Recording encoder probe failed (${reason}), attempt 1/${MEETING_RECORDING_PROBE_MAX_ATTEMPTS}; retrying on the next status request.`,
        );

        // A retry is left: not failed, the web app keeps asking.
        expect(manager.getRecordingProbeState()).toBe("pending");

        // Later callers start one retry and get their answer while it runs.
        expect(await manager.probeRecordingEncoders()).toBeNull();
        expect(await manager.probeRecordingEncoders()).toBeNull();
        expect(mockRunProbe).toHaveBeenCalledTimes(2);
        expect(manager.getRecordingProbeState()).toBe("pending");

        finishRetry({ ok: true, probe: PROBE });
        await Promise.resolve();
        await Promise.resolve();

        expect(await manager.probeRecordingEncoders()).toEqual(PROBE);
        expect(manager.getRecordingProbe()).toEqual(PROBE);
        expect(manager.getRecordingProbeState()).toBe("done");
        expect(mockRunProbe).toHaveBeenCalledTimes(2);
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      },
    );

    describe("awaitRecordingProbe", () => {
      it("starts the probe when nobody has asked for it yet and waits for the result", async () => {
        // A REC key press with no web app connected: no get_status ran.
        mockRunProbe.mockResolvedValue({ ok: true, probe: PROBE });
        const manager = new MeetingHelperManager();

        expect(await manager.awaitRecordingProbe()).toEqual(PROBE);
        expect(manager.getRecordingProbeState()).toBe("done");
        expect(mockRunProbe).toHaveBeenCalledTimes(1);
      });

      it("waits for a retry in flight, where probeRecordingEncoders answers at once", async () => {
        let finishRetry!: (outcome: MeetingRecordingProbeOutcomeT) => void;
        mockRunProbe
          .mockResolvedValueOnce({ ok: false, reason: "timeout" })
          .mockReturnValueOnce(
            new Promise((resolve) => {
              finishRetry = resolve;
            }),
          );
        const manager = new MeetingHelperManager();
        expect(await manager.probeRecordingEncoders()).toBeNull();
        // Starts the retry and does not wait for it.
        expect(await manager.probeRecordingEncoders()).toBeNull();

        let waited: unknown = "waiting";
        const waiting = manager.awaitRecordingProbe().then((probe) => {
          waited = probe;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(waited).toBe("waiting");

        finishRetry({ ok: true, probe: PROBE });
        await waiting;
        expect(waited).toEqual(PROBE);
        // Joined the retry in flight instead of starting a third run.
        expect(mockRunProbe).toHaveBeenCalledTimes(2);
      });

      it("starts the next attempt after a transient failure and counts it against the bound", async () => {
        mockRunProbe.mockResolvedValue({ ok: false, reason: "timeout" });
        const manager = new MeetingHelperManager();

        for (let call = 0; call < MEETING_RECORDING_PROBE_MAX_ATTEMPTS + 2; call += 1) {
          expect(await manager.awaitRecordingProbe()).toBeNull();
        }

        expect(mockRunProbe).toHaveBeenCalledTimes(MEETING_RECORDING_PROBE_MAX_ATTEMPTS);
        expect(manager.getRecordingProbeState()).toBe("failed");
      });

      it("answers from the settled state without another run", async () => {
        mockRunProbe.mockResolvedValue({ ok: false, reason: "helper_missing" });
        const manager = new MeetingHelperManager();

        expect(await manager.awaitRecordingProbe()).toBeNull();
        expect(await manager.awaitRecordingProbe()).toBeNull();

        expect(mockRunProbe).toHaveBeenCalledTimes(1);
        expect(manager.getRecordingProbeState()).toBe("failed");
      });
    });

    it("gives up after the bounded number of runs when the failure stays transient", async () => {
      mockRunProbe.mockResolvedValue({ ok: false, reason: "timeout" });
      const manager = new MeetingHelperManager();

      for (let call = 0; call < MEETING_RECORDING_PROBE_MAX_ATTEMPTS + 3; call += 1) {
        expect(await manager.probeRecordingEncoders()).toBeNull();
        // Lets a background retry finish before the next call.
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(mockRunProbe).toHaveBeenCalledTimes(MEETING_RECORDING_PROBE_MAX_ATTEMPTS);
      expect(mockLogger.warn).toHaveBeenCalledTimes(MEETING_RECORDING_PROBE_MAX_ATTEMPTS);
      expect(mockLogger.warn).toHaveBeenLastCalledWith(
        "[Meeting] Recording encoder probe failed (timeout); recording formats are not advertised.",
      );
      expect(manager.getRecordingProbe()).toBeNull();
      expect(manager.getRecordingProbeState()).toBe("failed");
    });

    it("stops retrying once a retry fails definitively", async () => {
      mockRunProbe
        .mockResolvedValueOnce({ ok: false, reason: "timeout" })
        .mockResolvedValueOnce({ ok: false, reason: "invalid_output" });
      const manager = new MeetingHelperManager();

      for (let call = 0; call < 4; call += 1) {
        expect(await manager.probeRecordingEncoders()).toBeNull();
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(mockRunProbe).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        "the helper path cannot be resolved",
        () => {
          mockRunProbe.mockImplementationOnce(() => {
            throw new Error("no helper path");
          });
        },
      ],
      [
        "the probe rejects",
        () => {
          mockRunProbe.mockRejectedValueOnce(new Error("EACCES"));
        },
      ],
      [
        "the logger throws",
        () => {
          mockRunProbe.mockResolvedValueOnce({ ok: false, reason: "helper_missing" });
          mockLogger.warn.mockImplementationOnce(() => {
            throw new Error("log sink closed");
          });
        },
      ],
    ])("resolves null instead of rejecting when %s", async (_name, arrange) => {
      arrange();
      const manager = new MeetingHelperManager();

      await expect(manager.probeRecordingEncoders()).resolves.toBeNull();
    });

    it("is not part of an engine start", async () => {
      const manager = new MeetingHelperManager();
      (
        manager as unknown as { startInternal: () => Promise<unknown> }
      ).startInternal = jest.fn(async () => manager.getStatus());

      await manager.start({ fps: 25 });

      expect(mockRunProbe).not.toHaveBeenCalled();
      expect(manager.getRecordingProbe()).toBeNull();
    });
  });

  describe("status platform", () => {
    it("exposes process.platform in manager and full status snapshots", async () => {
      const manager = new MeetingHelperManager();

      expect(manager.getStatus()).toMatchObject({
        platform: process.platform,
      });
      await expect(manager.getFullStatus()).resolves.toMatchObject({
        platform: process.platform,
        manager: { platform: process.platform },
      });
    });
  });

  describe("program_format", () => {
    type InternalsT = {
      state: string;
      lastStartOptions: { width?: number; height?: number; fps?: number };
    };

    it("is null while the engine is not running", async () => {
      const manager = new MeetingHelperManager();

      expect(manager.getProgramFormat()).toBeNull();
      expect(manager.getStatus().program_format).toBeNull();
      await expect(manager.getFullStatus()).resolves.toMatchObject({
        program_format: null,
        manager: { program_format: null },
      });
    });

    it("reports the start options with the engine defaults filled in", () => {
      const manager = new MeetingHelperManager();
      const internals = manager as unknown as InternalsT;
      internals.state = "running";

      internals.lastStartOptions = {};
      expect(manager.getStatus().program_format).toEqual({
        width: 1920,
        height: 1080,
        fps: 30,
      });

      internals.lastStartOptions = { width: 1080, height: 1920 };
      expect(manager.getProgramFormat()).toEqual({
        width: 1080,
        height: 1920,
        fps: 30,
      });
    });

    it("is part of the full status of a running engine", async () => {
      const manager = new MeetingHelperManager();
      const internals = manager as unknown as InternalsT & { client: unknown };
      internals.state = "running";
      internals.lastStartOptions = { width: 1080, height: 1920, fps: 25 };
      internals.client = {
        getState: jest.fn(async () => ({})),
        framebusStatus: jest.fn(async () => ({})),
        keyerGet: jest.fn(async () => ({})),
        recordingStatus: jest.fn(async () => ({})),
        virtualCameraStatus: jest.fn(async () => ({})),
      };

      const status = await manager.getFullStatus();

      expect(status.program_format).toEqual({ width: 1080, height: 1920, fps: 25 });
      expect(status.manager.program_format).toEqual(status.program_format);
    });

    it("a start while running keeps the options of the running engine", async () => {
      const manager = new MeetingHelperManager();
      const internals = manager as unknown as InternalsT;
      internals.state = "running";
      internals.lastStartOptions = { width: 1920, height: 1080, fps: 30 };

      const status = await manager.start({ width: 1080, height: 1920 });

      // A crash-recovery restart replays lastStartOptions: a no-op start must
      // not swap the geometry underneath the running engine.
      expect(internals.lastStartOptions).toEqual({ width: 1920, height: 1080, fps: 30 });
      expect(status.program_format).toEqual({ width: 1920, height: 1080, fps: 30 });
    });
  });

  describe("getPendingStart", () => {
    type StartOptionsT = { width?: number; height?: number; fps?: number };
    type InternalsT = {
      state: string;
      lastStartOptions: StartOptionsT;
      startPromise: Promise<unknown> | null;
      startInternal: (options: StartOptionsT) => Promise<unknown>;
      handleProcessExit: (code: number | null) => void;
    };

    /** Replaces the helper spawn with a start the test finishes by hand. */
    const stubHelperSpawn = (manager: MeetingHelperManager) => {
      const internals = manager as unknown as InternalsT;
      let finish!: (status: unknown) => void;
      const startInternal = jest.fn(
        (_options: StartOptionsT) =>
          new Promise<unknown>((resolve) => {
            finish = resolve;
          }),
      );
      internals.startInternal = startInternal;
      return {
        internals,
        startInternal,
        finish: (status: unknown) => finish(status),
      };
    };

    it("is null while no start is in flight", () => {
      const manager = new MeetingHelperManager();

      expect(manager.getPendingStart()).toBeNull();
    });

    it("reports a start from the call to start() on, with the defaults filled in", async () => {
      const manager = new MeetingHelperManager();
      const { finish } = stubHelperSpawn(manager);

      const started = manager.start({ width: 1080, height: 1920 });
      // No await before this read: start() claims the start synchronously.
      // meeting_engine_start decides and starts in one tick and relies on it.
      const pending = manager.getPendingStart();

      expect(pending?.format).toEqual({ width: 1080, height: 1920, fps: 30 });

      finish({ state: "running" });
      await expect(pending?.settled).resolves.toEqual({ state: "running" });
      await started;
      expect(manager.getPendingStart()).toBeNull();
    });

    it("keeps its geometry when a second start joins it", async () => {
      const manager = new MeetingHelperManager();
      const { internals, startInternal, finish } = stubHelperSpawn(manager);

      const first = manager.start({ width: 1920, height: 1080 });
      const second = manager.start({ width: 1080, height: 1920 });

      expect(startInternal).toHaveBeenCalledTimes(1);
      expect(startInternal).toHaveBeenCalledWith({ width: 1920, height: 1080 });
      expect(manager.getPendingStart()?.format).toEqual({
        width: 1920,
        height: 1080,
        fps: 30,
      });
      // What a crash-recovery restart replays stays the first start's.
      expect(internals.lastStartOptions).toEqual({ width: 1920, height: 1080 });

      finish({ state: "running" });
      await expect(second).resolves.toEqual({ state: "running" });
      await first;
    });

    it("reports a crash-recovery restart with the geometry it replays", async () => {
      jest.useFakeTimers();
      try {
        const manager = new MeetingHelperManager();
        const { internals, startInternal, finish } = stubHelperSpawn(manager);
        internals.state = "running";
        internals.lastStartOptions = { width: 1080, height: 1920, fps: 25 };

        internals.handleProcessExit(null);
        // Only the restart timer is armed: a start() now would supersede it
        // and spawn with its own options, so nothing is pending yet.
        expect(manager.getPendingStart()).toBeNull();

        jest.runOnlyPendingTimers();
        expect(startInternal).toHaveBeenCalledWith({
          width: 1080,
          height: 1920,
          fps: 25,
        });
        const pending = manager.getPendingStart();
        expect(pending?.format).toEqual({ width: 1080, height: 1920, fps: 25 });

        // Keep the failed attempt below from arming the next restart timer.
        manager.beginShutdown();
        finish({ state: "error" });
        await expect(pending?.settled).resolves.toEqual({ state: "error" });
        expect(manager.getPendingStart()).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it("is null once the engine runs, while the start still finishes its publish", () => {
      const manager = new MeetingHelperManager();
      const internals = manager as unknown as InternalsT;
      internals.startPromise = new Promise(() => undefined);
      internals.state = "starting";
      expect(manager.getPendingStart()).not.toBeNull();

      // start() is a no-op for a running engine; it would not join anything.
      internals.state = "running";
      expect(manager.getPendingStart()).toBeNull();
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
          BROADIFY_MEETING_CAMERA_MAX_HEIGHT: "720",
          BROADIFY_MEETING_DML_QUEUE: "compute",
          BROADIFY_MEETING_RECORDER_CFR: "0",
          BROADIFY_MEETING_FUSED_EMA_STATIC: "0.85",
          BROADIFY_MEETING_FUSED_PIPELINE_DEPTH: "0",
          BROADIFY_MEETING_GUIDED_COEFF_EMA: "0",
          BROADIFY_MEETING_GPU_POLICY: "auto",
          BROADIFY_MEETING_GPU_PIPELINE: "0",
          BROADIFY_MEETING_GPU_REFINE_BUDGET_MS: "8.5",
          BROADIFY_MEETING_GPU_RESIDENT: "1",
          BROADIFY_MEETING_COREML_UNITS: "cpuAndNeuralEngine",
          BROADIFY_MEETING_KEYER_FP16: "1",
          BROADIFY_MEETING_KEYER_IO_BINDING: "1",
          BROADIFY_MEETING_KEYER_PREBUILD_TIERS: "256,320",
          BROADIFY_MEETING_KEYER_ZEROCOPY: "1",
          BROADIFY_MEETING_LIVE_SNAP: "0",
          BROADIFY_MEETING_MASK_WORK_WIDTH: "512",
          BROADIFY_MEETING_OVERRUN_STEPDOWN: "0",
          BROADIFY_MEETING_STAGING_RING: "1",
          BROADIFY_MEETING_FUTURE_SECRET: "do-not-forward",
          UNRELATED_VALUE: "ignored",
        }),
      ).toEqual([
        "--env",
        "BROADIFY_MEETING_CAMERA_MAX_HEIGHT=720",
        "--env",
        "BROADIFY_MEETING_COREML_UNITS=cpuAndNeuralEngine",
        "--env",
        "BROADIFY_MEETING_RECORDER_CFR=0",
        "--env",
        "BROADIFY_MEETING_FUSED_EMA_STATIC=0.85",
        "--env",
        "BROADIFY_MEETING_FUSED_PIPELINE_DEPTH=0",
        "--env",
        "BROADIFY_MEETING_GPU_PIPELINE=0",
        "--env",
        "BROADIFY_MEETING_GPU_POLICY=auto",
        "--env",
        "BROADIFY_MEETING_GPU_REFINE_BUDGET_MS=8.5",
        "--env",
        "BROADIFY_MEETING_GPU_RESIDENT=1",
        "--env",
        "BROADIFY_MEETING_GUIDED_COEFF_EMA=0",
        "--env",
        "BROADIFY_MEETING_KEYER_FP16=1",
        "--env",
        "BROADIFY_MEETING_KEYER_IO_BINDING=1",
        "--env",
        "BROADIFY_MEETING_KEYER_PREBUILD_TIERS=256,320",
        "--env",
        "BROADIFY_MEETING_KEYER_ZEROCOPY=1",
        "--env",
        "BROADIFY_MEETING_LIVE_SNAP=0",
        "--env",
        "BROADIFY_MEETING_MASK_WORK_WIDTH=512",
        "--env",
        "BROADIFY_MEETING_DML_QUEUE=compute",
        "--env",
        "BROADIFY_MEETING_OVERRUN_STEPDOWN=0",
        "--env",
        "BROADIFY_MEETING_STAGING_RING=1",
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

    describe("keyer replay after a crash restart", () => {
      type InternalsT = {
        client: { keyerConfigure: jest.Mock };
        state: string;
        lastStartOptions: { fps?: number };
        restoreRuntimeConfig: () => Promise<void>;
      };

      const restartedAt = (fps: number) => {
        const manager = new MeetingHelperManager();
        const internals = manager as unknown as InternalsT;
        internals.client = { keyerConfigure: jest.fn(async () => ({})) };
        internals.state = "running";
        internals.lastStartOptions = { fps };
        return { manager, internals };
      };

      it.each([25, 30])("replays keying into a %i fps engine", async (fps) => {
        const { manager, internals } = restartedAt(fps);
        manager.noteKeyerConfigured({ enabled: true, background_mode: "gradient" });

        await internals.restoreRuntimeConfig();

        expect(internals.client.keyerConfigure).toHaveBeenCalledWith({
          enabled: true,
          background_mode: "gradient",
        });
      });

      it.each([50, 60])(
        "replays a config noted on a slower engine into a %i fps engine with keying off",
        async (fps) => {
          const { manager, internals } = restartedAt(fps);
          manager.noteKeyerConfigured({ enabled: true, background_mode: "gradient" });

          await internals.restoreRuntimeConfig();
          await internals.restoreRuntimeConfig();

          expect(internals.client.keyerConfigure.mock.calls).toEqual([
            [{ enabled: false, background_mode: "gradient" }],
            [{ enabled: false, background_mode: "gradient" }],
          ]);
          expect(mockLogger.warn).toHaveBeenCalledTimes(1);
          expect(mockLogger.warn).toHaveBeenCalledWith(
            `[Meeting] Keying is not restored after the helper restart: the program runs at ${fps} fps, keying at up to 30 fps.`,
          );
        },
      );

      it("replays a config without keying into a 60 fps engine unchanged", async () => {
        const { manager, internals } = restartedAt(60);
        manager.noteKeyerConfigured({ enabled: false, background_mode: "gradient" });

        await internals.restoreRuntimeConfig();

        expect(internals.client.keyerConfigure).toHaveBeenCalledWith({
          enabled: false,
          background_mode: "gradient",
        });
        expect(mockLogger.warn).not.toHaveBeenCalled();
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

    it("mirrors the camera format selection into the bridge log without a status publish", () => {
      // camera_format_selected (macOS, Nov 2026) is a one-shot diagnostic per
      // camera open: it belongs in the bridge log next to meeting_recorder
      // lines, but it is no state transition and must not force a publish.
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;
      mockLogger.info.mockClear();
      mockPublishBridgeEvent.mockClear();

      const line = JSON.stringify({
        type: "camera_format_selected",
        camera_index: 0,
        width: 1920,
        height: 1080,
        fps: 30.00003,
        match: "tolerant",
        applied_fps: 30.00003,
      });
      internals.handleStdoutLine(line, mockLogger);
      internals.handleStdoutLine(
        JSON.stringify({ type: "camera_format_apply_failed", reason: "exception" }),
        mockLogger,
      );

      expect(mockLogger.info).toHaveBeenCalledWith(`[MeetingHelper] ${line}`);
      expect(mockLogger.info).toHaveBeenCalledTimes(2);
      expect(publishStatus).not.toHaveBeenCalled();
      expect(mockPublishBridgeEvent).not.toHaveBeenCalled();
    });

    it("forwards a camera stall as both a status publish and one error event", () => {
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;
      mockPublishBridgeEvent.mockClear();

      internals.handleStdoutLine(
        JSON.stringify({ type: "camera_stalled", age_ms: 2000 }),
        mockLogger,
      );

      expect(publishStatus).toHaveBeenCalledWith("camera_stalled", true);
      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "meeting_error",
          data: expect.objectContaining({ code: "camera_stalled" }),
        }),
      );
    });

    it("does not raise an error event for the periodic reopen stall re-trigger", () => {
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;
      mockPublishBridgeEvent.mockClear();

      internals.handleStdoutLine(
        JSON.stringify({
          type: "camera_stalled",
          event: "reopen",
          reopen_count_lifetime: 3,
        }),
        mockLogger,
      );

      expect(publishStatus).toHaveBeenCalledWith("camera_stalled", true);
      expect(mockPublishBridgeEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "meeting_error" }),
      );
    });

    it("forwards a reopen failure as a status publish without an error toast", () => {
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;
      mockPublishBridgeEvent.mockClear();

      internals.handleStdoutLine(
        JSON.stringify({
          type: "camera_reopen_failure",
          camera_index: 0,
          attempt: 4,
          error: "Could not reopen the camera.",
        }),
        mockLogger,
      );

      expect(publishStatus).toHaveBeenCalledWith("camera_reopen_failure", true);
      expect(mockPublishBridgeEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "meeting_error" }),
      );
    });

    it("ignores the noisy camera_reopen_attempt event", () => {
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;

      internals.handleStdoutLine(
        JSON.stringify({ type: "camera_reopen_attempt", attempt: 2 }),
        mockLogger,
      );

      expect(publishStatus).not.toHaveBeenCalled();
    });

    it("forwards item-closed screen capture stops as a forced publish and error event", () => {
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;
      mockPublishBridgeEvent.mockClear();

      internals.handleStdoutLine(
        JSON.stringify({
          type: "screen_capture_stopped",
          reason: "item_closed",
        }),
        mockLogger,
      );

      expect(publishStatus).toHaveBeenCalledWith(
        "screen_capture_stopped",
        true,
      );
      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "meeting_error",
          data: expect.objectContaining({
            code: "screen_capture_stopped",
            message: "Screen sharing stopped (item_closed)",
          }),
        }),
      );
    });

    it("forwards user-stopped screen capture stops without an error event", () => {
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;
      mockPublishBridgeEvent.mockClear();

      internals.handleStdoutLine(
        JSON.stringify({
          type: "screen_capture_stopped",
          reason: "user_stop",
        }),
        mockLogger,
      );

      expect(publishStatus).toHaveBeenCalledWith(
        "screen_capture_stopped",
        true,
      );
      expect(mockPublishBridgeEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "meeting_error" }),
      );
    });

    it("forwards screen capture errors with the helper error code", () => {
      const manager = new MeetingHelperManager();
      const publishStatus = jest.fn(async () => {});
      const internals = manager as unknown as {
        publishStatus: (reason: string, force: boolean) => Promise<void>;
        handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
      };
      internals.publishStatus = publishStatus;
      mockPublishBridgeEvent.mockClear();

      internals.handleStdoutLine(
        JSON.stringify({
          type: "screen_capture_error",
          code: "screen_start_failed",
          message: "Could not start screen sharing.",
        }),
        mockLogger,
      );

      expect(publishStatus).toHaveBeenCalledWith(
        "screen_capture_error",
        true,
      );
      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "meeting_error",
          data: expect.objectContaining({
            code: "screen_start_failed",
            message: "Could not start screen sharing.",
          }),
        }),
      );
    });

    it("getFullStatus returns manager status without helper when stopped", async () => {
      const manager = new MeetingHelperManager();
      const status = await manager.getFullStatus();

      expect(status).toMatchObject({
        platform: process.platform,
        manager: expect.objectContaining({ state: "stopped" }),
        engine: null,
        recording: null,
        call: { active: false, call_id: null },
        content_source: { video: null, browser: null },
        camera_permission_status: null,
      });
    });

    it("camera_permission_completed publishes a full snapshot", async () => {
      jest.useFakeTimers();
      try {
        const manager = new MeetingHelperManager();
        jest.spyOn(manager, "getFullStatus").mockResolvedValue({
          manager: { state: "running" },
          engine: { program: { camera_render: { enabled: true } } },
          recording: null,
          call: { active: false, call_id: null },
          content_source: { video: null, browser: null },
          camera_permission_status: "authorized",
        });
        const internals = manager as unknown as {
          handleStdoutLine: (line: string, logger: typeof mockLogger) => void;
        };

        internals.handleStdoutLine(
          JSON.stringify({
            type: "camera_permission_completed",
            camera_permission_status: "authorized",
          }),
          mockLogger,
        );
        await jest.advanceTimersByTimeAsync(150);

        const statusEvents = mockPublishBridgeEvent.mock.calls.filter(
          ([event]) => event?.event === "meeting_status",
        );
        const lastEvent = statusEvents.at(-1)?.[0];
        expect(lastEvent?.data?.status?.engine?.program).toEqual({
          camera_render: { enabled: true },
        });
        expect(lastEvent?.data?.status?.camera_permission_status).toBe(
          "authorized",
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it("requestStatusPublish coalesces", async () => {
      jest.useFakeTimers();
      try {
        const manager = new MeetingHelperManager();
        jest.spyOn(manager, "getFullStatus").mockResolvedValue({
          manager: { state: "running" },
          engine: null,
          recording: null,
          call: { active: false, call_id: null },
          content_source: { video: null, browser: null },
          camera_permission_status: null,
        });

        manager.requestStatusPublish("program_update");
        await jest.advanceTimersByTimeAsync(10);
        manager.requestStatusPublish("keyer_configure");
        await jest.advanceTimersByTimeAsync(10);
        manager.requestStatusPublish("program_update");
        await jest.advanceTimersByTimeAsync(10);
        manager.requestStatusPublish("keyer_configure");
        await jest.advanceTimersByTimeAsync(10);
        manager.requestStatusPublish("program_update");
        await jest.advanceTimersByTimeAsync(110);

        const statusEvents = mockPublishBridgeEvent.mock.calls.filter(
          ([event]) => event?.event === "meeting_status",
        );
        expect(statusEvents).toHaveLength(1);
        expect(statusEvents[0]?.[0]?.data?.reason).toBe(
          "program_update+keyer_configure",
        );
      } finally {
        jest.useRealTimers();
      }
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
      const os = require("node:os");

      type LivenessInternalsT = {
        state: string;
        client: unknown;
        process: unknown;
        restartTimer: NodeJS.Timeout | null;
        handleProcessExit: (code: number | null) => void;
      };

      const createFakeClient = (getState: jest.Mock) => ({
        getState,
        shutdown: jest.fn().mockResolvedValue(undefined),
        framebusStatus: jest.fn().mockResolvedValue({}),
        keyerGet: jest.fn().mockResolvedValue({}),
        recordingStatus: jest.fn().mockResolvedValue({ recording: null }),
        // W2 added output.vcam.status to the snapshot (best effort).
        virtualCameraStatus: jest.fn().mockResolvedValue(null),
      });

      const awaitWin32GracefulKill = async () => {
        if (os.platform() !== "win32") {
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
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
        internals.client = createFakeClient(getState);
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
        await awaitWin32GracefulKill();
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
        await awaitWin32GracefulKill();
        expect(kill).toHaveBeenCalledWith("SIGTERM");
      });

      it("win32 kill still terminates when graceful shutdown rejects", async () => {
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
      jest.useFakeTimers();
      try {
        const manager = new MeetingHelperManager();
        manager.notifyRecordingChanged();
        await jest.advanceTimersByTimeAsync(150);

        expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event: "meeting_status" }),
        );
      } finally {
        jest.useRealTimers();
      }
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

  describe("session event log (ADR-0008)", () => {
    type StatusInternalsT = {
      publishStatus: (reason: string, force: boolean) => Promise<void>;
    };

    const statusWithRecording = (
      manager: MeetingHelperManager,
      active: boolean,
    ): MeetingStatusT => ({
      manager: manager.getStatus(),
      engine: { program_revision: 3 },
      recording: { active },
      call: { active: false, call_id: null },
      content_source: { video: null, browser: null },
      camera_permission_status: null,
    });

    it("neither summarizes nor diffs the status without a post-production URL", async () => {
      const manager = new MeetingHelperManager();
      jest
        .spyOn(manager, "getFullStatus")
        .mockResolvedValue(statusWithRecording(manager, true));

      await (manager as unknown as StatusInternalsT).publishStatus("status_poll", true);

      expect(summarizeMeetingStatus).not.toHaveBeenCalled();
      expect(diffMeetingSummary).not.toHaveBeenCalled();
      expect(recordSwitcherEvent).not.toHaveBeenCalled();
      // The status itself still goes out.
      expect(mockPublishBridgeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: "meeting_status" }),
      );
    });

    it("records recorder and program changes once a post-production URL is set", async () => {
      setBridgeContext({
        userDataDir: "/tmp",
        logPath: "/tmp/bridge.log",
        logger: mockLogger,
        publishBridgeEvent: mockPublishBridgeEvent,
        postproApiUrl: "https://postpro.example",
      });
      const manager = new MeetingHelperManager();
      const getFullStatus = jest
        .spyOn(manager, "getFullStatus")
        .mockResolvedValue(statusWithRecording(manager, true));
      const internals = manager as unknown as StatusInternalsT;

      await internals.publishStatus("status_poll", true);
      getFullStatus.mockResolvedValue(statusWithRecording(manager, false));
      await internals.publishStatus("status_poll", true);

      expect(
        (recordSwitcherEvent as jest.Mock).mock.calls.map(([event]) => event),
      ).toEqual([
        { type: "recording_started", source: "meeting", at_ms: expect.any(Number) },
        {
          type: "program_changed",
          source: "meeting",
          me: 0,
          input_id: "3",
          input_name: "camera",
          at_ms: expect.any(Number),
        },
        { type: "recording_stopped", source: "meeting", at_ms: expect.any(Number) },
      ]);
    });
  });

  describe("recording upload (ADR-0011)", () => {
    it("hands every status snapshot to the recording upload, with or without a post-production URL", async () => {
      const manager = new MeetingHelperManager();
      const status: MeetingStatusT = {
        manager: manager.getStatus(),
        engine: { program_revision: 3 },
        recording: { active: true, file_path: "/tmp/take.mp4.part", codec: "h264" },
        call: { active: false, call_id: null },
        content_source: { video: null, browser: null },
        camera_permission_status: null,
        program_format: { width: 1920, height: 1080, fps: 30 },
      };
      jest.spyOn(manager, "getFullStatus").mockResolvedValue(status);

      await (
        manager as unknown as { publishStatus: (reason: string, force: boolean) => Promise<void> }
      ).publishStatus("recording_changed", true);

      expect(noteMeetingStatusForRecordingUpload).toHaveBeenCalledTimes(1);
      expect(noteMeetingStatusForRecordingUpload).toHaveBeenCalledWith(status);
    });
  });
});
