const mockGetClient = jest.fn();
const mockIsRunning = jest.fn();
const mockGetStatus = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockGetFullStatus = jest.fn();
const mockGetProgramFormat = jest.fn();
const mockGetPendingStart = jest.fn();
const mockGetMeetingCapabilities = jest.fn(() => ({ program_portrait: true }));
const mockNotifyRecordingChanged = jest.fn();
const mockRequestStatusPublish = jest.fn();
const mockMeetingBackGraphicsConfigureOutputs = jest.fn();
const mockMeetingFrontGraphicsConfigureOutputs = jest.fn();
const mockMeetingBackGraphicsInvalidate = jest.fn();
const mockMeetingFrontGraphicsInvalidate = jest.fn();
const mockMeetingBackGraphicsSendInternalLayer = jest.fn();
const mockMeetingBackGraphicsRemoveLayer = jest.fn();
const mockMeetingBackGraphicsGetStatus = jest.fn(() => ({ layers: [] }));
const mockFrameBusWriteFrame = jest.fn();
const mockFrameBusClose = jest.fn();
const mockFrameBusCreateWriter = jest.fn(() => ({
  writeFrame: mockFrameBusWriteFrame,
  close: mockFrameBusClose,
}));
const mockLoadFrameBusModule = jest.fn(() => ({
  createWriter: mockFrameBusCreateWriter,
}));

jest.mock("./meeting-helper-manager.js", () => ({
  meetingHelperManager: {
    getClient: (...args: unknown[]) => mockGetClient(...args),
    isRunning: (...args: unknown[]) => mockIsRunning(...args),
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
    start: (...args: unknown[]) => mockStart(...args),
    stop: (...args: unknown[]) => mockStop(...args),
    getFullStatus: (...args: unknown[]) => mockGetFullStatus(...args),
    getProgramFormat: (...args: unknown[]) => mockGetProgramFormat(...args),
    getPendingStart: (...args: unknown[]) => mockGetPendingStart(...args),
    noteCameraCall: () => undefined,
    noteCameraStopped: () => undefined,
    noteVirtualCameraStarted: () => undefined,
    noteVirtualCameraStopped: () => undefined,
    noteKeyerConfigured: () => undefined,
    notifyRecordingChanged: (...args: unknown[]) =>
      mockNotifyRecordingChanged(...args),
    requestStatusPublish: (...args: unknown[]) =>
      mockRequestStatusPublish(...args),
  },
}));

jest.mock("./meeting-capabilities.js", () => ({
  ...jest.requireActual<typeof import("./meeting-capabilities.js")>(
    "./meeting-capabilities.js",
  ),
  getMeetingCapabilities: (...args: unknown[]) =>
    mockGetMeetingCapabilities(...args),
}));

jest.mock("./meeting-graphics-manager.js", () => ({
  MEETING_GRAPHICS_BACK_FRAMEBUS_NAME: "bfy-meet-gfx-back",
  MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME: "bfy-meet-gfx-front",
  meetingBackGraphicsManager: {
    configureOutputs: (...args: unknown[]) =>
      mockMeetingBackGraphicsConfigureOutputs(...args),
    invalidateRendererFrameBusAttachment: (...args: unknown[]) =>
      mockMeetingBackGraphicsInvalidate(...args),
    sendInternalLayer: (...args: unknown[]) =>
      mockMeetingBackGraphicsSendInternalLayer(...args),
    removeLayer: (...args: unknown[]) =>
      mockMeetingBackGraphicsRemoveLayer(...args),
    getStatus: (...args: unknown[]) => mockMeetingBackGraphicsGetStatus(...args),
  },
  meetingFrontGraphicsManager: {
    configureOutputs: (...args: unknown[]) =>
      mockMeetingFrontGraphicsConfigureOutputs(...args),
    invalidateRendererFrameBusAttachment: (...args: unknown[]) =>
      mockMeetingFrontGraphicsInvalidate(...args),
  },
}));

jest.mock("../graphics/framebus/framebus-client.js", () => ({
  loadFrameBusModule: (...args: unknown[]) => mockLoadFrameBusModule(...args),
}));

const mockMeetingMediaGetAsset = jest.fn();
const mockMeetingMediaListAssets = jest.fn();
const mockMeetingMediaSaveUpload = jest.fn();
const mockMeetingMediaRenderingStatus = jest.fn();
jest.mock("./meeting-media-service.js", () => ({
  meetingMediaService: {
    getAsset: (...args: unknown[]) => mockMeetingMediaGetAsset(...args),
    listAssets: (...args: unknown[]) => mockMeetingMediaListAssets(...args),
    saveUpload: (...args: unknown[]) => mockMeetingMediaSaveUpload(...args),
    renderingStatus: (...args: unknown[]) =>
      mockMeetingMediaRenderingStatus(...args),
  },
  videoMimeForFilename: (filename: string) =>
    filename.endsWith(".mp4")
      ? "video/mp4"
      : filename.endsWith(".webm")
        ? "video/webm"
        : null,
}));

const mockConferenceDisplayStart = jest.fn();
const mockConferenceDisplayStop = jest.fn();
jest.mock("../conference/conference-display-output.js", () => ({
  ConferenceDisplayOutput: class {
    start = (...args: unknown[]) => mockConferenceDisplayStart(...args);
    stop = (...args: unknown[]) => mockConferenceDisplayStop(...args);
    status = () => ({ running: false, frameBusName: "bfy", target: {}, lastError: null });
  },
}));

const mockPickRecordingSavePath = jest.fn();
jest.mock("./meeting-recording-dialog.js", () => ({
  pickRecordingSavePath: (...args: unknown[]) =>
    mockPickRecordingSavePath(...args),
}));

// The Stream Deck REC toggle derives its default recording path from the
// shared recording-paths helper, which resolves the home folder and creates
// the recordings directory. Keep both off the real machine in tests.
jest.mock("node:os", () => ({
  ...jest.requireActual<typeof import("node:os")>("node:os"),
  homedir: () => "/home/test-user",
}));
const mockMkdirSync = jest.fn();
jest.mock("node:fs", () => ({
  ...jest.requireActual<typeof import("node:fs")>("node:fs"),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

import {
  handleMeetingCommand,
  isMeetingCommand,
} from "./meeting-command-handler.js";
import { MeetingHelperRequestError } from "./meeting-helper-client.js";
import { meetingContentSourceState } from "./meeting-content-source-state.js";
import { setBridgeContext } from "../bridge-context.js";

const mockClient = {
  getState: jest.fn(),
  listCameras: jest.fn(),
  cameraSelect: jest.fn(),
  cameraStart: jest.fn(),
  cameraStop: jest.fn(),
  cameraOpenSet: jest.fn(),
  cameraProgramSelect: jest.fn(),
  cameraPipSet: jest.fn(),
  cameraAudioLevels: jest.fn(),
  cameraAutoDirector: jest.fn(),
  screenList: jest.fn(),
  screenStart: jest.fn(),
  screenStop: jest.fn(),
  screenPick: jest.fn(),
  keyerGet: jest.fn(),
  keyerConfigure: jest.fn(),
  keyerReset: jest.fn(),
  programGet: jest.fn(),
  programUpdate: jest.fn(),
  framebusStatus: jest.fn(),
  framebusStart: jest.fn(),
  framebusStop: jest.fn(),
  framebusConfigure: jest.fn(),
  virtualCameraStart: jest.fn(),
  virtualCameraStop: jest.fn(),
  virtualCameraConfigure: jest.fn(),
  recordingMicrophones: jest.fn(),
  recordingStart: jest.fn(),
  recordingStop: jest.fn(),
  recordingStatus: jest.fn(),
};

describe("meeting-command-handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BRIDGE_FRAMEBUS_NAME;
    delete process.env.BRIDGE_FRAMEBUS_SLOT_COUNT;
    delete process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT;
    mockGetClient.mockReturnValue(mockClient);
    mockIsRunning.mockReturnValue(true);
    mockGetProgramFormat.mockReturnValue(null);
    mockGetPendingStart.mockReturnValue(null);
    mockGetMeetingCapabilities.mockReturnValue({ program_portrait: true });
    mockClient.getState.mockResolvedValue({ camera_permission_status: "authorized" });
    mockMeetingBackGraphicsConfigureOutputs.mockResolvedValue(undefined);
    mockMeetingFrontGraphicsConfigureOutputs.mockResolvedValue(undefined);
    mockMeetingBackGraphicsSendInternalLayer.mockResolvedValue(undefined);
    mockMeetingBackGraphicsRemoveLayer.mockResolvedValue(undefined);
    mockMeetingBackGraphicsGetStatus.mockReturnValue({ layers: [] });
    mockMeetingMediaGetAsset.mockResolvedValue({
      assetId: "asset-video",
      filename: "clip.mp4",
      sourceFormat: "video",
      renderStatus: "ready",
    });
    mockMeetingMediaListAssets.mockResolvedValue([]);
    mockMeetingMediaSaveUpload.mockResolvedValue({});
    mockMeetingMediaRenderingStatus.mockResolvedValue({});
    meetingContentSourceState.reset();
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      serverPort: 32123,
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      publishBridgeEvent: jest.fn(),
    });
    mockLoadFrameBusModule.mockReturnValue({
      createWriter: mockFrameBusCreateWriter,
    });
    mockFrameBusCreateWriter.mockReturnValue({
      writeFrame: mockFrameBusWriteFrame,
      close: mockFrameBusClose,
    });
  });

  describe("isMeetingCommand", () => {
    it("detects meeting commands by prefix", () => {
      expect(isMeetingCommand("meeting_get_state")).toBe(true);
      expect(isMeetingCommand("engine_connect")).toBe(false);
    });
  });

  describe("meeting_get_state", () => {
    it("returns full status from manager", async () => {
      mockGetFullStatus.mockResolvedValue({ manager: { state: "running" } });

      const result = await handleMeetingCommand("meeting_get_state", {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ manager: { state: "running" } });
    });

    it("preserves camera_stalled in the status snapshot", async () => {
      mockGetFullStatus.mockResolvedValue({
        manager: { state: "running" },
        engine: { camera_running: true, camera_stalled: true },
        recording: null,
      });

      const result = await handleMeetingCommand("meeting_get_state", {});

      expect(result).toEqual({
        success: true,
        data: {
          manager: { state: "running" },
          engine: { camera_running: true, camera_stalled: true },
          recording: null,
        },
      });
    });

  });

  describe("meeting_engine_start", () => {
    it("starts the engine and returns status", async () => {
      mockIsRunning.mockReturnValue(false);
      mockStart.mockResolvedValue({ state: "running", port: 9100 });

      const result = await handleMeetingCommand("meeting_engine_start", {
        width: 1280,
        height: 720,
      });

      expect(mockStart).toHaveBeenCalledWith({ width: 1280, height: 720 });
      expect(result.success).toBe(true);
      // The bus regions were force-recreated for this start: already-running
      // renderers must be told to drop their (now orphaned) writers, or every
      // graphics frame they write stays invisible to the fresh helper.
      expect(mockMeetingBackGraphicsInvalidate).toHaveBeenCalledTimes(1);
      expect(mockMeetingFrontGraphicsInvalidate).toHaveBeenCalledTimes(1);
    });

    it("auto-arms the virtual camera without starting the FrameBus output", async () => {
      // Not running for the start decision, running for the arm that follows.
      mockIsRunning.mockReturnValueOnce(false);
      mockStart.mockResolvedValue({ state: "running", port: 9100 });
      mockClient.virtualCameraStart.mockResolvedValue({ active: true });

      const result = await handleMeetingCommand("meeting_engine_start", {});
      // The arm runs detached from the engine start; let it settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.success).toBe(true);
      expect(mockClient.virtualCameraStart).toHaveBeenCalledTimes(1);
      // Unattended arm: the registration self-heal must never raise UAC.
      expect(mockClient.virtualCameraStart).toHaveBeenCalledWith({
        allowElevation: false,
      });
      expect(mockClient.framebusStart).not.toHaveBeenCalled();
    });

    it("is idempotent while running: no FrameBus clear, no renderer invalidate", async () => {
      // isRunning=true from the global beforeEach; pin it for clarity.
      mockIsRunning.mockReturnValue(true);
      mockGetStatus.mockReturnValue({ state: "running" });

      const result = await handleMeetingCommand("meeting_engine_start", {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ state: "running" });
      expect(mockStart).not.toHaveBeenCalled();
      // A second client's autostart must never force-recreate the graphics
      // regions under the live helper.
      expect(mockFrameBusCreateWriter).not.toHaveBeenCalled();
      expect(mockMeetingBackGraphicsInvalidate).not.toHaveBeenCalled();
      expect(mockMeetingFrontGraphicsInvalidate).not.toHaveBeenCalled();
    });

    it("fails when the engine does not reach running state", async () => {
      mockIsRunning.mockReturnValue(false);
      mockStart.mockResolvedValue({
        state: "error",
        lastError: "spawn failed",
      });

      const result = await handleMeetingCommand("meeting_engine_start", {});

      expect(result.success).toBe(false);
      expect(result.error).toBe("spawn failed");
    });

    it("rejects invalid payloads", async () => {
      await expect(
        handleMeetingCommand("meeting_engine_start", { width: 1 }),
      ).rejects.toThrow("Invalid payload for meeting_engine_start");
    });

    describe("program geometry", () => {
      const LANDSCAPE = { width: 1920, height: 1080, fps: 30 };
      const PORTRAIT = { width: 1080, height: 1920, fps: 30 };
      const settlePrewarm = () =>
        new Promise((resolve) => setImmediate(resolve));

      // A refused start must leave alone everything a real start mutates. Two
      // of those are module state without an accessor: the requested plane
      // size and the configured-outputs key. They are primed to a recognizable
      // value and read back through the commands that use them - the plane
      // size through the content-layer stage, the key through the configure
      // cache.
      const PRIMED_PLANES = { width: 1080, height: 1920, fps: 50 };

      const primeGraphicsState = async () => {
        await handleMeetingCommand(
          "meeting_graphics_configure_outputs",
          PRIMED_PLANES,
        );
        await settlePrewarm();
        mockMeetingBackGraphicsConfigureOutputs.mockClear();
        mockMeetingFrontGraphicsConfigureOutputs.mockClear();
      };

      const readPrimedGraphicsState = async () => {
        mockGetProgramFormat.mockReturnValue(null);
        await handleMeetingCommand("meeting_browser_source_set", {
          url: "https://example.test/source",
          mode: "fullscreen",
        });
        const stageHtml = (
          mockMeetingBackGraphicsSendInternalLayer.mock.calls.at(-1)?.[0] as {
            html: string;
          }
        ).html;
        // A cache hit configures nothing; after a reset the planes are
        // configured again.
        await handleMeetingCommand(
          "meeting_graphics_configure_outputs",
          PRIMED_PLANES,
        );
        await settlePrewarm();
        return {
          planeSizeKept: stageHtml.includes("width:1080px;height:1920px;"),
          outputsKeyKept:
            mockMeetingBackGraphicsConfigureOutputs.mock.calls.length === 0 &&
            mockMeetingFrontGraphicsConfigureOutputs.mock.calls.length === 0,
        };
      };

      /** Call after a refused start that followed `primeGraphicsState()`. */
      const expectNoStartSideEffects = async () => {
        await settlePrewarm();
        // Graphics FrameBus regions not cleared or recreated.
        expect(mockFrameBusCreateWriter).not.toHaveBeenCalled();
        expect(mockFrameBusWriteFrame).not.toHaveBeenCalled();
        expect(mockLoadFrameBusModule).not.toHaveBeenCalled();
        // Renderer attachments untouched.
        expect(mockMeetingBackGraphicsInvalidate).not.toHaveBeenCalled();
        expect(mockMeetingFrontGraphicsInvalidate).not.toHaveBeenCalled();
        // Neither started (or joined) nor stopped, and no recording finalized.
        expect(mockStart).not.toHaveBeenCalled();
        expect(mockStop).not.toHaveBeenCalled();
        expect(mockClient.recordingStop).not.toHaveBeenCalled();
        // No pre-warm, no virtual camera arm.
        expect(mockMeetingBackGraphicsConfigureOutputs).not.toHaveBeenCalled();
        expect(mockMeetingFrontGraphicsConfigureOutputs).not.toHaveBeenCalled();
        expect(mockClient.virtualCameraStart).not.toHaveBeenCalled();
        // requestedGraphicsPlaneSize and lastConfiguredGraphicsOutputsKey.
        expect(await readPrimedGraphicsState()).toEqual({
          planeSizeKept: true,
          outputsKeyKept: true,
        });
      };

      it("an attempted start does reset the graphics state (control for the read-back)", async () => {
        // Shows that the read-back above can see the mutation at all.
        await primeGraphicsState();
        mockIsRunning.mockReturnValue(false);
        mockStart.mockResolvedValue({ state: "error", lastError: "spawn failed" });

        const result = await handleMeetingCommand("meeting_engine_start", PORTRAIT);

        expect(result.success).toBe(false);
        expect(mockFrameBusCreateWriter).toHaveBeenCalledTimes(2);
        expect(mockMeetingBackGraphicsInvalidate).toHaveBeenCalledTimes(1);
        expect(mockMeetingFrontGraphicsInvalidate).toHaveBeenCalledTimes(1);
        expect(await readPrimedGraphicsState()).toEqual({
          planeSizeKept: false,
          outputsKeyKept: false,
        });
      });

      it("refuses a portrait start on a platform without the capability", async () => {
        await primeGraphicsState();
        mockIsRunning.mockReturnValue(false);
        mockGetMeetingCapabilities.mockReturnValue({ program_portrait: false });

        const result = await handleMeetingCommand("meeting_engine_start", PORTRAIT);

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe("meeting_program_portrait_unsupported");
        await expectNoStartSideEffects();
      });

      it("refuses portrait on an incapable platform even while a landscape engine runs", async () => {
        await primeGraphicsState();
        mockGetMeetingCapabilities.mockReturnValue({ program_portrait: false });
        mockGetProgramFormat.mockReturnValue(LANDSCAPE);

        const result = await handleMeetingCommand("meeting_engine_start", PORTRAIT);

        expect(result.errorCode).toBe("meeting_program_portrait_unsupported");
        expect(mockClient.recordingStatus).not.toHaveBeenCalled();
        await expectNoStartSideEffects();
      });

      it("still starts landscape on a platform without the capability", async () => {
        mockIsRunning.mockReturnValueOnce(false);
        mockGetMeetingCapabilities.mockReturnValue({ program_portrait: false });
        mockStart.mockResolvedValue({ state: "running", program_format: LANDSCAPE });

        const result = await handleMeetingCommand("meeting_engine_start", LANDSCAPE);
        await settlePrewarm();

        expect(result.success).toBe(true);
        expect(mockStart).toHaveBeenCalledWith(LANDSCAPE);
      });

      it("starts a portrait engine where the capability is present", async () => {
        mockIsRunning.mockReturnValueOnce(false);
        mockStart.mockResolvedValue({ state: "running", program_format: PORTRAIT });

        const result = await handleMeetingCommand("meeting_engine_start", PORTRAIT);
        await settlePrewarm();

        expect(result.success).toBe(true);
        expect(mockStart).toHaveBeenCalledWith(PORTRAIT);
      });

      it("requires a restart when the running engine has a different geometry", async () => {
        await primeGraphicsState();
        mockGetProgramFormat.mockReturnValue(LANDSCAPE);
        mockGetStatus.mockReturnValue({ state: "running", program_format: LANDSCAPE });
        mockClient.recordingStatus.mockResolvedValue({ recording: { active: false } });

        const result = await handleMeetingCommand("meeting_engine_start", PORTRAIT);

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe("meeting_engine_restart_required");
        expect(result.error).toContain("1920x1080");
        expect(result.data).toEqual({ state: "running", program_format: LANDSCAPE });
        // Never restart or touch the live graphics regions from here.
        await expectNoStartSideEffects();
      });

      it("names the running recording when a geometry change is refused", async () => {
        await primeGraphicsState();
        mockGetProgramFormat.mockReturnValue(LANDSCAPE);
        mockGetStatus.mockReturnValue({ state: "running" });
        mockClient.recordingStatus.mockResolvedValue({ recording: { active: true } });

        const result = await handleMeetingCommand("meeting_engine_start", PORTRAIT);

        expect(result.errorCode).toBe("meeting_engine_restart_required");
        expect(result.error).toContain("recording");
        // The recording keeps running: nothing is stopped or finalized.
        await expectNoStartSideEffects();
      });

      it("still refuses the geometry change when recording.status fails", async () => {
        await primeGraphicsState();
        mockGetProgramFormat.mockReturnValue(PORTRAIT);
        mockGetStatus.mockReturnValue({ state: "running" });
        mockClient.recordingStatus.mockRejectedValue(new Error("rpc down"));

        const result = await handleMeetingCommand("meeting_engine_start", LANDSCAPE);

        expect(result.errorCode).toBe("meeting_engine_restart_required");
        await expectNoStartSideEffects();
      });

      it.each([
        ["explicit landscape", LANDSCAPE, LANDSCAPE],
        ["defaults", {}, LANDSCAPE],
        ["portrait", PORTRAIT, PORTRAIT],
        ["another frame rate", { ...LANDSCAPE, fps: 60 }, LANDSCAPE],
      ])("stays idempotent for the same geometry (%s)", async (_name, payload, running) => {
        mockGetProgramFormat.mockReturnValue(running);
        mockGetStatus.mockReturnValue({ state: "running", program_format: running });

        const result = await handleMeetingCommand("meeting_engine_start", payload);

        expect(result).toEqual({
          success: true,
          data: { state: "running", program_format: running },
        });
        expect(mockStart).not.toHaveBeenCalled();
        expect(mockClient.recordingStatus).not.toHaveBeenCalled();
        expect(mockFrameBusCreateWriter).not.toHaveBeenCalled();
      });

      describe("while another start is in flight", () => {
        type StartOptionsT = { width?: number; height?: number; fps?: number };
        type PendingStatusT = {
          state: string;
          program_format?: unknown;
          lastError?: string;
        };

        /**
         * A start in flight that the test finishes by hand, modelled on the
         * manager: getPendingStart() reports it and start() would join it.
         */
        const pendingStartAt = (format: typeof LANDSCAPE) => {
          let finish!: (status: PendingStatusT) => void;
          const settled = new Promise<PendingStatusT>((resolve) => {
            finish = resolve;
          });
          mockIsRunning.mockReturnValue(false);
          mockGetPendingStart.mockReturnValue({ format, settled });
          mockStart.mockReturnValue(settled);
          return { finish };
        };

        afterEach(() => {
          mockStart.mockReset();
        });

        it("refuses another geometry without touching anything and answers once that start runs", async () => {
          await primeGraphicsState();
          const pendingStart = pendingStartAt(LANDSCAPE);

          let answered = false;
          const refusal = handleMeetingCommand("meeting_engine_start", PORTRAIT).then(
            (result) => {
              answered = true;
              return result;
            },
          );
          // "Restart required" tells the web app that the engine is up, so the
          // answer waits for the start in flight - as the join did before.
          await settlePrewarm();
          expect(answered).toBe(false);

          pendingStart.finish({ state: "running", program_format: LANDSCAPE });

          expect(await refusal).toEqual({
            success: false,
            error:
              "The meeting engine is running at 1920x1080; stop it before starting 1080x1920.",
            errorCode: "meeting_engine_restart_required",
            data: { state: "running", program_format: LANDSCAPE },
          });
          // The regions, renderers and plane state belong to the other start.
          await expectNoStartSideEffects();
        });

        it("reports the failure of that start when it was refused for another geometry", async () => {
          await primeGraphicsState();
          const pendingStart = pendingStartAt(PORTRAIT);
          pendingStart.finish({ state: "error", lastError: "spawn failed" });

          const result = await handleMeetingCommand("meeting_engine_start", LANDSCAPE);

          expect(result).toEqual({
            success: false,
            error: "spawn failed",
            data: { state: "error", lastError: "spawn failed" },
          });
          await expectNoStartSideEffects();
        });

        it.each([
          ["landscape", LANDSCAPE, LANDSCAPE],
          ["defaults", {}, LANDSCAPE],
          ["portrait", PORTRAIT, PORTRAIT],
          ["another frame rate", { ...PORTRAIT, fps: 60 }, PORTRAIT],
        ])("joins the same geometry exactly as before (%s)", async (_name, payload, pending) => {
          pendingStartAt(pending);
          // Not running for the start decision, running for the arm after it.
          mockIsRunning.mockReturnValueOnce(false).mockReturnValue(true);
          mockStart.mockResolvedValue({ state: "running", program_format: pending });
          mockClient.virtualCameraStart.mockResolvedValue({ active: true });

          const result = await handleMeetingCommand("meeting_engine_start", payload);
          await settlePrewarm();

          expect(result).toEqual({
            success: true,
            data: { state: "running", program_format: pending },
          });
          expect(mockStart).toHaveBeenCalledWith(payload);
          // Unchanged for a join: the regions are cleared at the requested
          // size, the renderers re-attach, the planes are pre-warmed and the
          // virtual camera is armed.
          const requested = { ...LANDSCAPE, ...payload };
          for (const name of ["bfy-meet-gfx-back", "bfy-meet-gfx-front"]) {
            expect(mockFrameBusCreateWriter).toHaveBeenCalledWith(
              expect.objectContaining({ name, ...requested, forceRecreate: true }),
            );
          }
          expect(mockFrameBusCreateWriter).toHaveBeenCalledTimes(2);
          expect(mockMeetingBackGraphicsInvalidate).toHaveBeenCalledTimes(1);
          expect(mockMeetingFrontGraphicsInvalidate).toHaveBeenCalledTimes(1);
          const planes = pending === PORTRAIT ? PORTRAIT : LANDSCAPE;
          expect(mockMeetingBackGraphicsConfigureOutputs).toHaveBeenCalledWith(
            expect.objectContaining({ format: planes }),
          );
          expect(mockMeetingFrontGraphicsConfigureOutputs).toHaveBeenCalledWith(
            expect.objectContaining({ format: planes }),
          );
          expect(mockClient.virtualCameraStart).toHaveBeenCalledTimes(1);
        });

        it("decides and claims in one step: of two simultaneous starts only the first touches anything", async () => {
          // The real manager decides who starts and who joins; only the
          // helper spawn is replaced by a start the test finishes by hand.
          const { MeetingHelperManager } = jest.requireActual<
            typeof import("./meeting-helper-manager.js")
          >("./meeting-helper-manager.js");
          const manager = new MeetingHelperManager();
          const internals = manager as unknown as {
            state: string;
            client: unknown;
            startInternal: (options: StartOptionsT) => Promise<PendingStatusT>;
          };
          let finishSpawn!: (status: PendingStatusT) => void;
          const spawnHelper = jest.fn(
            (_options: StartOptionsT) =>
              new Promise<PendingStatusT>((resolve) => {
                finishSpawn = resolve;
              }),
          );
          internals.startInternal = spawnHelper;
          mockIsRunning.mockImplementation(() => manager.isRunning());
          mockGetPendingStart.mockImplementation(() => manager.getPendingStart());
          mockStart.mockImplementation((options: StartOptionsT) =>
            manager.start(options),
          );
          mockClient.virtualCameraStart.mockResolvedValue({ active: true });

          // Same tick, no await in between - two clients autostarting with
          // different stored formats.
          const first = handleMeetingCommand("meeting_engine_start", LANDSCAPE);
          const second = handleMeetingCommand("meeting_engine_start", PORTRAIT);
          // Both wait for the one start now; let it finish.
          await settlePrewarm();
          internals.state = "running";
          internals.client = mockClient;
          finishSpawn({ state: "running", program_format: LANDSCAPE });

          expect(await second).toMatchObject({
            success: false,
            errorCode: "meeting_engine_restart_required",
            data: { state: "running", program_format: LANDSCAPE },
          });
          expect(await first).toEqual({
            success: true,
            data: { state: "running", program_format: LANDSCAPE },
          });
          await settlePrewarm();

          // Everything that was touched was touched for the first start.
          expect(mockStart).toHaveBeenCalledTimes(1);
          expect(spawnHelper).toHaveBeenCalledTimes(1);
          expect(spawnHelper).toHaveBeenCalledWith(LANDSCAPE);
          expect(mockFrameBusCreateWriter).toHaveBeenCalledTimes(2);
          for (const nthCall of [1, 2]) {
            expect(mockFrameBusCreateWriter).toHaveBeenNthCalledWith(
              nthCall,
              expect.objectContaining({ width: 1920, height: 1080 }),
            );
          }
          expect(mockMeetingBackGraphicsInvalidate).toHaveBeenCalledTimes(1);
          expect(mockMeetingFrontGraphicsInvalidate).toHaveBeenCalledTimes(1);
          expect(mockMeetingBackGraphicsConfigureOutputs).toHaveBeenCalledTimes(1);
          expect(mockMeetingBackGraphicsConfigureOutputs).toHaveBeenCalledWith(
            expect.objectContaining({ format: LANDSCAPE }),
          );
          expect(mockClient.virtualCameraStart).toHaveBeenCalledTimes(1);
        });

        it("still reports restart-required if the manager joined another geometry after all", async () => {
          // Guard behind the decision above; the real manager cannot get here.
          mockIsRunning.mockReturnValueOnce(false);
          mockStart.mockResolvedValue({ state: "running", program_format: LANDSCAPE });
          const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);

          try {
            const result = await handleMeetingCommand("meeting_engine_start", PORTRAIT);

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe("meeting_engine_restart_required");
            expect(warn).toHaveBeenCalledWith(
              expect.stringContaining("joined a start with another geometry"),
            );
          } finally {
            warn.mockRestore();
          }
        });
      });

      it("pre-warms the graphics planes at 1920x1080@30 for a landscape engine", async () => {
        mockIsRunning.mockReturnValueOnce(false);
        mockStart.mockResolvedValue({ state: "running" });

        await handleMeetingCommand("meeting_engine_start", { width: 1280, height: 720 });
        await settlePrewarm();

        expect(mockMeetingBackGraphicsConfigureOutputs).toHaveBeenCalledWith(
          expect.objectContaining({ format: LANDSCAPE }),
        );
        expect(mockMeetingFrontGraphicsConfigureOutputs).toHaveBeenCalledWith(
          expect.objectContaining({ format: LANDSCAPE }),
        );
      });

      it("pre-warms the graphics planes at the canvas size for a portrait engine", async () => {
        mockIsRunning.mockReturnValueOnce(false);
        mockStart.mockResolvedValue({ state: "running", program_format: PORTRAIT });

        await handleMeetingCommand("meeting_engine_start", PORTRAIT);
        await settlePrewarm();

        expect(mockMeetingBackGraphicsConfigureOutputs).toHaveBeenCalledWith(
          expect.objectContaining({ format: PORTRAIT }),
        );
        expect(mockMeetingFrontGraphicsConfigureOutputs).toHaveBeenCalledWith(
          expect.objectContaining({ format: PORTRAIT }),
        );
      });
    });
  });

  describe("meeting_engine_stop", () => {
    it("stops the engine", async () => {
      mockStop.mockResolvedValue({ state: "stopped" });

      const result = await handleMeetingCommand("meeting_engine_stop", {});

      expect(mockStop).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  describe("engine-dependent commands", () => {
    it("fails when the engine is not running", async () => {
      mockIsRunning.mockReturnValue(false);

      await expect(
        handleMeetingCommand("meeting_camera_list", {}),
      ).rejects.toThrow("Meeting engine is not running");
      await expect(
        handleMeetingCommand("meeting_screen_start", { source_id: "display:1" }),
      ).rejects.toThrow("Meeting engine is not running");
    });

    it("lists cameras via the client", async () => {
      mockClient.listCameras.mockResolvedValue([{ index: 0 }]);

      const result = await handleMeetingCommand("meeting_camera_list", {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ index: 0 }]);
    });

    it("returns structured camera errors from the helper", async () => {
      mockClient.listCameras.mockRejectedValue(
        new MeetingHelperRequestError(
          "camera_permission_denied",
          "Camera permission was not granted.",
        ),
      );

      const result = await handleMeetingCommand("meeting_camera_list", {});

      expect(result).toEqual({
        success: false,
        error: "Camera permission was not granted.",
        errorCode: "camera_permission_denied",
      });
    });

    it("returns a pending camera permission state before listing cameras", async () => {
      mockClient.getState.mockResolvedValue({
        camera_permission_status: "prompt_requested",
      });

      const result = await handleMeetingCommand("meeting_camera_list", {});

      expect(mockClient.listCameras).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        error: "Camera permission request is still pending.",
        errorCode: "camera_permission_pending",
      });
    });

    it("returns structured camera start permission errors from the helper", async () => {
      mockClient.cameraStart.mockRejectedValue(
        new MeetingHelperRequestError(
          "camera_permission_denied",
          "Camera permission was not granted.",
        ),
      );

      const result = await handleMeetingCommand("meeting_camera_start", {});

      expect(result).toEqual({
        success: false,
        error: "Camera permission was not granted.",
        errorCode: "camera_permission_denied",
      });
    });

    it("lists screen sources via the client", async () => {
      mockClient.screenList.mockResolvedValue({
        sources: [{ source_id: "display:1", title: "Display 1" }],
        capabilities: { supported: true },
      });

      const result = await handleMeetingCommand("meeting_screen_list", {});

      expect(result).toEqual({
        success: true,
        data: {
          sources: [{ source_id: "display:1", title: "Display 1" }],
          capabilities: { supported: true },
        },
      });
    });

    it("starts screen sharing and requests a status publish", async () => {
      mockClient.screenStart.mockResolvedValue({
        ok: true,
        source_id: "display:1",
        kind: "display",
        width: 1920,
        height: 1080,
        reopened: false,
      });

      const result = await handleMeetingCommand("meeting_screen_start", {
        source_id: "display:1",
        include_cursor: true,
        future_field: "strip-me",
      });

      expect(result.success).toBe(true);
      expect(mockClient.screenStart).toHaveBeenCalledWith({
        source_id: "display:1",
        include_cursor: true,
      });
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("screen_start");
    });

    it("returns structured screen start errors from the helper", async () => {
      mockClient.screenStart.mockRejectedValue(
        new MeetingHelperRequestError(
          "screen_source_not_found",
          "Screen source not found.",
        ),
      );

      const result = await handleMeetingCommand("meeting_screen_start", {
        source_id: "missing",
      });

      expect(result).toEqual({
        success: false,
        error: "Screen source not found.",
        errorCode: "screen_source_not_found",
      });
    });

    it("rejects invalid screen start payloads", async () => {
      await expect(
        handleMeetingCommand("meeting_screen_start", { source_id: "" }),
      ).rejects.toThrow("Invalid payload for meeting_screen_start");
      expect(mockClient.screenStart).not.toHaveBeenCalled();
    });

    it("picks a screen source and requests a status publish", async () => {
      mockClient.screenPick.mockResolvedValue({
        ok: true,
        picker_pending: true,
      });

      const result = await handleMeetingCommand("meeting_screen_pick", {
        include_cursor: false,
      });

      expect(result).toEqual({
        success: true,
        data: { ok: true, picker_pending: true },
      });
      expect(mockClient.screenPick).toHaveBeenCalledWith({
        include_cursor: false,
      });
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("screen_pick");
    });

    it("stops screen sharing and requests a status publish", async () => {
      mockClient.screenStop.mockResolvedValue({ ok: true });

      const result = await handleMeetingCommand("meeting_screen_stop", {});

      expect(result).toEqual({ success: true, data: { ok: true } });
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("screen_stop");
    });

    it("forwards keyer configuration", async () => {
      mockClient.keyerConfigure.mockResolvedValue({ enabled: true });

      const result = await handleMeetingCommand("meeting_keyer_configure", {
        enabled: true,
        model: "vision_person_segmentation",
        background_type: "mode",
        background_mode: "transparent",
        background_template_id: null,
        background_template_name: "Default background",
        quality_mode: "accurate",
        performance_mode: "balanced",
        mask_erode_px: 0.5,
        mask_dilate_px: 0,
        mask_feather_px: 0,
        dynamic_dilation: false,
        temporal_blend_enabled: false,
        edge_stabilization_enabled: true,
        edge_stabilization_strength: 0.35,
        fresh_mask_age_ms: 60,
        max_mask_age_ms: 220,
      });

      expect(mockClient.keyerConfigure).toHaveBeenCalledWith({
        enabled: true,
        model: "vision_person_segmentation",
        background_type: "mode",
        background_mode: "transparent",
        background_template_id: null,
        background_template_name: "Default background",
        quality_mode: "accurate",
        performance_mode: "balanced",
        mask_erode_px: 0.5,
        mask_dilate_px: 0,
        mask_feather_px: 0,
        dynamic_dilation: false,
        temporal_blend_enabled: false,
        edge_stabilization_enabled: true,
        edge_stabilization_strength: 0.35,
        fresh_mask_age_ms: 60,
        max_mask_age_ms: 220,
      });
      expect(result.success).toBe(true);
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("keyer_configure");
    });

    it("forwards automatic keyer configuration without forcing a model", async () => {
      mockClient.keyerConfigure.mockResolvedValue({ enabled: true });

      const result = await handleMeetingCommand("meeting_keyer_configure", {
        enabled: true,
        performance_mode: "balanced",
        mask_erode_px: 0.5,
        mask_feather_px: 1,
        edge_stabilization_enabled: true,
        edge_stabilization_strength: 0.5,
        background_type: "mode",
        background_mode: "transparent",
      });

      expect(mockClient.keyerConfigure).toHaveBeenCalledWith({
        enabled: true,
        performance_mode: "balanced",
        mask_erode_px: 0.5,
        mask_feather_px: 1,
        edge_stabilization_enabled: true,
        edge_stabilization_strength: 0.5,
        background_type: "mode",
        background_mode: "transparent",
      });
      expect(mockClient.keyerConfigure.mock.calls[0]?.[0]).not.toHaveProperty(
        "model",
      );
      expect(result.success).toBe(true);
    });

    it("forwards background identity fields and strips unknown keys", async () => {
      mockClient.keyerConfigure.mockResolvedValue({ enabled: true });

      const result = await handleMeetingCommand("meeting_keyer_configure", {
        background_asset_id: "asset-1",
        background_template_id: "template-1",
        unknown_key: "strip-me",
      });

      expect(mockClient.keyerConfigure).toHaveBeenCalledWith({
        background_asset_id: "asset-1",
        background_template_id: "template-1",
      });
      expect(mockClient.keyerConfigure.mock.calls[0]?.[0]).not.toHaveProperty(
        "unknown_key",
      );
      expect(result.success).toBe(true);
    });

    it("rejects invalid keyer configuration", async () => {
      await expect(
        handleMeetingCommand("meeting_keyer_configure", {
          enabled: true,
          model: "unknown",
        }),
      ).rejects.toThrow("Invalid payload for meeting_keyer_configure");

      await expect(
        handleMeetingCommand("meeting_keyer_configure", {
          mask_erode_px: 3.5,
        }),
      ).rejects.toThrow("Invalid payload for meeting_keyer_configure");

      await expect(
        handleMeetingCommand("meeting_keyer_configure", {
          edge_stabilization_strength: 1.5,
        }),
      ).rejects.toThrow("Invalid payload for meeting_keyer_configure");

      await expect(
        handleMeetingCommand("meeting_keyer_configure", {
          fresh_mask_age_ms: 240,
          max_mask_age_ms: 220,
        }),
      ).rejects.toThrow("Invalid payload for meeting_keyer_configure");

      await expect(
        handleMeetingCommand("meeting_keyer_configure", {
          performance_mode: "turbo",
        }),
      ).rejects.toThrow("Invalid payload for meeting_keyer_configure");

      expect(mockClient.keyerConfigure).not.toHaveBeenCalled();
    });

    it("updates program sections", async () => {
      mockClient.programUpdate.mockResolvedValue({ enabled: true });

      const result = await handleMeetingCommand("meeting_program_update", {
        section: "cornerbug",
        values: { enabled: true },
      });

      expect(mockClient.programUpdate).toHaveBeenCalledWith("cornerbug", {
        enabled: true,
      });
      expect(result.success).toBe(true);
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("program_update");
    });

    it("meeting_program_update requests a status publish", async () => {
      mockClient.programUpdate.mockResolvedValue({ ok: true });

      const result = await handleMeetingCommand("meeting_program_update", {
        section: "graphics",
        values: { enabled: true },
      });

      expect(result.success).toBe(true);
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("program_update");
    });

    it("updates camera render settings", async () => {
      mockClient.programUpdate.mockResolvedValue({ mirror: false });

      const result = await handleMeetingCommand("meeting_program_update", {
        section: "camera",
        values: { mirror: false },
      });

      expect(mockClient.programUpdate).toHaveBeenCalledWith("camera", {
        mirror: false,
      });
      expect(result.success).toBe(true);
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("program_update");
    });

    it("rejects unknown program sections", async () => {
      await expect(
        handleMeetingCommand("meeting_program_update", {
          section: "unknown",
          values: {},
        }),
      ).rejects.toThrow("Invalid payload for meeting_program_update");
    });

  });

  describe("conference_display_start/stop", () => {
    it("starts the helper FrameBus output before the display window", async () => {
      const order: string[] = [];
      mockClient.framebusStart.mockImplementation(async () => {
        order.push("framebus");
        return { running: true };
      });
      mockConferenceDisplayStart.mockImplementation(async () => {
        order.push("display");
      });

      const result = await handleMeetingCommand("conference_display_start", {});

      expect(result.success).toBe(true);
      expect(order).toEqual(["framebus", "display"]);
    });

    it("stops the helper FrameBus output after the display window", async () => {
      mockClient.framebusStop.mockResolvedValue({ running: false });
      mockConferenceDisplayStop.mockResolvedValue(undefined);

      const result = await handleMeetingCommand("conference_display_stop", {});

      expect(result.success).toBe(true);
      expect(mockConferenceDisplayStop).toHaveBeenCalledTimes(1);
      expect(mockClient.framebusStop).toHaveBeenCalledTimes(1);
    });
  });

  describe("meeting_output_configure", () => {
    it("starts the framebus output", async () => {
      mockClient.framebusStart.mockResolvedValue({ running: true });

      const result = await handleMeetingCommand("meeting_output_configure", {
        target: "framebus",
        action: "start",
      });

      expect(mockClient.framebusStart).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it("starts the virtual camera with elevation allowed on explicit operator request", async () => {
      mockClient.virtualCameraStart.mockResolvedValue({ active: true });

      const result = await handleMeetingCommand("meeting_output_configure", {
        target: "virtual_camera",
        action: "start",
      });

      expect(result.success).toBe(true);
      // Only the explicit start may raise the one-shot UAC prompt.
      expect(mockClient.virtualCameraStart).toHaveBeenCalledWith();
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("vcam_start");
    });

    it("stops the virtual camera and requests a status publish", async () => {
      mockClient.virtualCameraStop.mockResolvedValue({ active: false });

      const result = await handleMeetingCommand("meeting_output_configure", {
        target: "virtual_camera",
        action: "stop",
      });

      expect(result.success).toBe(true);
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("vcam_stop");
    });

    it("configures the virtual camera", async () => {
      mockClient.virtualCameraConfigure.mockResolvedValue({});

      const result = await handleMeetingCommand("meeting_output_configure", {
        target: "virtual_camera",
        action: "configure",
        settings: { fps: 30 },
      });

      expect(mockClient.virtualCameraConfigure).toHaveBeenCalledWith({
        fps: 30,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("meeting_graphics_configure_outputs", () => {
    it("configures the meeting graphics manager for renderer FrameBus output", async () => {
      const result = await handleMeetingCommand(
        "meeting_graphics_configure_outputs",
        {
          width: 1280,
          height: 720,
          fps: 30,
        },
      );

      expect(result.success).toBe(true);
      expect(mockMeetingBackGraphicsConfigureOutputs).toHaveBeenCalledWith({
        outputKey: "framebus",
        targets: {},
        format: { width: 1280, height: 720, fps: 30 },
        range: "full",
        colorspace: "rec709",
      });
      expect(mockMeetingFrontGraphicsConfigureOutputs).toHaveBeenCalledWith({
        outputKey: "framebus",
        targets: {},
        format: { width: 1280, height: 720, fps: 30 },
        range: "full",
        colorspace: "rec709",
      });
      expect(result.data).toMatchObject({
        framebusName: "bfy-meet-gfx-front",
        framebusNames: {
          back: "bfy-meet-gfx-back",
          front: "bfy-meet-gfx-front",
        },
        width: 1280,
        height: 720,
        fps: 30,
      });
    });

    it("restores the previous FrameBus env after configuring meeting graphics", async () => {
      process.env.BRIDGE_FRAMEBUS_NAME = "studio-bus";
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "4";
      process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = "1";

      const result = await handleMeetingCommand(
        "meeting_graphics_configure_outputs",
        {
          width: 1290,
          height: 720,
          fps: 30,
        },
      );

      expect(result.success).toBe(true);
      expect(process.env.BRIDGE_FRAMEBUS_NAME).toBe("studio-bus");
      expect(process.env.BRIDGE_FRAMEBUS_SLOT_COUNT).toBe("4");
      expect(process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT).toBe("1");
    });

    it("removes temporary FrameBus env when it was unset before configuring meeting graphics", async () => {
      const result = await handleMeetingCommand(
        "meeting_graphics_configure_outputs",
        {
          width: 1291,
          height: 720,
          fps: 30,
        },
      );

      expect(result.success).toBe(true);
      expect(process.env.BRIDGE_FRAMEBUS_NAME).toBeUndefined();
      expect(process.env.BRIDGE_FRAMEBUS_SLOT_COUNT).toBeUndefined();
      expect(process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT).toBeUndefined();
    });

    it("follows a portrait engine when the request is landscape", async () => {
      mockGetProgramFormat.mockReturnValue({ width: 1080, height: 1920, fps: 30 });

      const result = await handleMeetingCommand(
        "meeting_graphics_configure_outputs",
        { width: 1920, height: 1080, fps: 25 },
      );

      expect(mockMeetingBackGraphicsConfigureOutputs).toHaveBeenCalledWith(
        expect.objectContaining({ format: { width: 1080, height: 1920, fps: 25 } }),
      );
      expect(mockMeetingFrontGraphicsConfigureOutputs).toHaveBeenCalledWith(
        expect.objectContaining({ format: { width: 1080, height: 1920, fps: 25 } }),
      );
      // The response reports what was configured, not what was asked for.
      expect(result.data).toMatchObject({ width: 1080, height: 1920, fps: 25 });
    });

    it("follows a landscape engine when the request is portrait", async () => {
      mockGetProgramFormat.mockReturnValue({ width: 1280, height: 720, fps: 30 });

      const result = await handleMeetingCommand(
        "meeting_graphics_configure_outputs",
        { width: 1080, height: 1920, fps: 24 },
      );

      expect(result.data).toMatchObject({ width: 1280, height: 720, fps: 24 });
    });

    it("keeps the requested size when the orientation matches the engine", async () => {
      // A 1280x720 engine with 1920x1080 planes is today's default pairing.
      mockGetProgramFormat.mockReturnValue({ width: 1280, height: 720, fps: 30 });

      const landscape = await handleMeetingCommand(
        "meeting_graphics_configure_outputs",
        { width: 1920, height: 1080, fps: 23 },
      );
      expect(landscape.data).toMatchObject({ width: 1920, height: 1080, fps: 23 });

      mockGetProgramFormat.mockReturnValue({ width: 1080, height: 1920, fps: 30 });
      const portrait = await handleMeetingCommand(
        "meeting_graphics_configure_outputs",
        { width: 720, height: 1280, fps: 23 },
      );
      expect(portrait.data).toMatchObject({ width: 720, height: 1280, fps: 23 });
    });

    it("restores FrameBus env when meeting graphics configuration fails", async () => {
      process.env.BRIDGE_FRAMEBUS_NAME = "studio-bus";
      process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = "4";
      process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = "1";
      mockMeetingFrontGraphicsConfigureOutputs.mockRejectedValueOnce(
        new Error("front failed"),
      );

      await expect(
        handleMeetingCommand("meeting_graphics_configure_outputs", {
          width: 1292,
          height: 720,
          fps: 30,
        }),
      ).rejects.toThrow("front failed");

      expect(process.env.BRIDGE_FRAMEBUS_NAME).toBe("studio-bus");
      expect(process.env.BRIDGE_FRAMEBUS_SLOT_COUNT).toBe("4");
      expect(process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT).toBe("1");
    });
  });

  describe("meeting recording commands", () => {
    it("lists microphones via the client", async () => {
      mockClient.recordingMicrophones.mockResolvedValue({
        microphones: [{ device_id: "m1", label: "Mic 1", is_default: true }],
      });

      const result = await handleMeetingCommand(
        "meeting_recording_microphones",
        {},
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        microphones: [{ device_id: "m1", label: "Mic 1", is_default: true }],
      });
    });

    it("returns the picked path for meeting_recording_pick_path", async () => {
      mockPickRecordingSavePath.mockResolvedValue("/Users/x/Movies/rec.mp4");

      const result = await handleMeetingCommand("meeting_recording_pick_path", {
        default_name: "rec.mp4",
        locale: "en",
      });

      expect(mockPickRecordingSavePath).toHaveBeenCalledWith("rec.mp4", "en");
      expect(result).toEqual({
        success: true,
        data: { cancelled: false, file_path: "/Users/x/Movies/rec.mp4" },
      });
    });

    it("reports cancellation when the save panel is dismissed", async () => {
      mockPickRecordingSavePath.mockResolvedValue(null);

      const result = await handleMeetingCommand(
        "meeting_recording_pick_path",
        {},
      );

      expect(result).toEqual({ success: true, data: { cancelled: true } });
    });

    it("starts recording for a valid absolute .mp4 path", async () => {
      mockClient.recordingStart.mockResolvedValue({
        recording: { active: true },
      });

      const result = await handleMeetingCommand("meeting_recording_start", {
        file_path: "/Users/x/Movies/rec.mp4",
        mic_device_id: "m1",
      });

      expect(result.success).toBe(true);
      expect(mockClient.recordingStart).toHaveBeenCalledWith({
        file_path: "/Users/x/Movies/rec.mp4",
        mic_device_id: "m1",
      });
    });

    it.each([
      ["/Users/x/.zshrc"],
      ["relative.mp4"],
      ["/tmp/x.txt"],
      ["/Users/x/../../etc/hosts.mp4"],
    ])("rejects unsafe recording path %s before hitting the client", async (
      filePath,
    ) => {
      await expect(
        handleMeetingCommand("meeting_recording_start", {
          file_path: filePath,
        }),
      ).rejects.toThrow("Invalid payload for meeting_recording_start");
      expect(mockClient.recordingStart).not.toHaveBeenCalled();
    });

    it("promotes known recorder failure tokens to the errorCode", async () => {
      mockClient.recordingStart.mockRejectedValue(
        new MeetingHelperRequestError(
          "recording_start_failed",
          "microphone_permission_denied",
        ),
      );

      const result = await handleMeetingCommand("meeting_recording_start", {
        file_path: "/Users/x/Movies/rec.mp4",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("microphone_permission_denied");
      expect(result.errorCode).toBe("microphone_permission_denied");
      expect(mockNotifyRecordingChanged).not.toHaveBeenCalled();
    });

    it("keeps unknown recorder failures on the generic RPC code", async () => {
      mockClient.recordingStart.mockRejectedValue(
        new MeetingHelperRequestError(
          "recording_start_failed",
          "something unexpected happened",
        ),
      );

      const result = await handleMeetingCommand("meeting_recording_start", {
        file_path: "/Users/x/Movies/rec.mp4",
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("recording_start_failed");
    });

    it("stops recording via the client", async () => {
      mockClient.recordingStop.mockResolvedValue({
        recording: { active: false },
      });

      const result = await handleMeetingCommand("meeting_recording_stop", {});

      expect(result.success).toBe(true);
      expect(mockClient.recordingStop).toHaveBeenCalled();
      // The deck REC mirror and the pushed status snapshot are updated by the
      // manager's status publisher, not by the handler directly (WP-2.4).
      expect(mockNotifyRecordingChanged).toHaveBeenCalled();
    });

    it("returns recording status via the client", async () => {
      mockClient.recordingStatus.mockResolvedValue({
        recording: { active: false },
      });

      const result = await handleMeetingCommand("meeting_recording_status", {});

      expect(result.success).toBe(true);
      expect(mockClient.recordingStatus).toHaveBeenCalled();
    });

    it("REC toggle starts into the shared default recordings folder", async () => {
      mockClient.recordingStatus.mockResolvedValue({
        recording: { active: false },
      });
      mockClient.recordingStart.mockResolvedValue({
        recording: { active: true },
      });

      const result = await handleMeetingCommand("meeting_recording_toggle", {
        mic_device_id: "m1",
      });

      expect(result.success).toBe(true);
      expect(mockClient.recordingStart).toHaveBeenCalledTimes(1);
      const [options] = mockClient.recordingStart.mock.calls[0] as [
        { file_path: string; mic_device_id: string },
      ];
      // One default folder for every trigger: ~/Movies/Broadify (macOS/Linux)
      // or ~/Videos/Broadify (Windows), prefix Broadify-Meeting-.
      expect(options.file_path).toMatch(
        /(Movies|Videos)[\\/]Broadify[\\/]Broadify-Meeting-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/,
      );
      expect(options.file_path).not.toContain("Broadify Recordings");
      expect(options.mic_device_id).toBe("m1");
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringMatching(/(Movies|Videos)[\\/]Broadify$/),
        { recursive: true },
      );
      expect(mockNotifyRecordingChanged).toHaveBeenCalled();
    });

    it("REC toggle stops an active recording without starting a new one", async () => {
      mockClient.recordingStatus.mockResolvedValue({
        recording: { active: true },
      });
      mockClient.recordingStop.mockResolvedValue({
        recording: { active: false },
      });

      const result = await handleMeetingCommand("meeting_recording_toggle", {});

      expect(result.success).toBe(true);
      expect(mockClient.recordingStop).toHaveBeenCalled();
      expect(mockClient.recordingStart).not.toHaveBeenCalled();
    });
  });

  describe("push-on-write meeting commands", () => {
    it.each([
      ["meeting_camera_select", { stable_key: "cam-a" }, "camera_select"],
      ["meeting_camera_start", { stable_key: "cam-a" }, "camera_start"],
      ["meeting_camera_stop", {}, "camera_stop"],
      ["meeting_screen_start", { source_id: "display:1" }, "screen_start"],
      ["meeting_screen_stop", {}, "screen_stop"],
      ["meeting_screen_pick", {}, "screen_pick"],
      [
        "meeting_camera_program_select",
        { camera_index: 1 },
        "camera_program_select",
      ],
    ])("%s requests a status publish", async (command, payload, reason) => {
      mockClient.cameraSelect.mockResolvedValue({ ok: true });
      mockClient.cameraStart.mockResolvedValue({ ok: true });
      mockClient.cameraStop.mockResolvedValue({ ok: true });
      mockClient.cameraProgramSelect.mockResolvedValue({ ok: true });
      mockClient.screenStart.mockResolvedValue({ ok: true });
      mockClient.screenStop.mockResolvedValue({ ok: true });
      mockClient.screenPick.mockResolvedValue({ ok: true });

      const result = await handleMeetingCommand(command, payload);

      expect(result.success).toBe(true);
      expect(mockRequestStatusPublish).toHaveBeenCalledWith(reason);
    });

    it("meeting_keyer_reset requests a status publish", async () => {
      mockClient.keyerReset.mockResolvedValue({ ok: true });

      const result = await handleMeetingCommand("meeting_keyer_reset", {});

      expect(result.success).toBe(true);
      expect(mockRequestStatusPublish).toHaveBeenCalledWith("keyer_reset");
    });

    it("meeting_content_video_set records content_source.video and null clears it; both request a publish", async () => {
      mockMeetingBackGraphicsGetStatus.mockReturnValue({
        layers: [{ layerId: "meeting-content-video" }],
      });

      const setResult = await handleMeetingCommand("meeting_content_video_set", {
        asset_id: "asset-video",
        muted: true,
        loop: false,
      });

      expect(setResult.success).toBe(true);
      expect(mockMeetingBackGraphicsSendInternalLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          layerId: "meeting-content-video",
          zIndex: 10,
        }),
      );
      expect(meetingContentSourceState.snapshot().video).toMatchObject({
        asset_id: "asset-video",
        muted: true,
        loop: false,
      });
      expect(mockRequestStatusPublish).toHaveBeenCalledWith(
        "content_video_set",
      );

      mockMeetingBackGraphicsGetStatus.mockReturnValue({ layers: [] });
      const clearResult = await handleMeetingCommand("meeting_content_video_set", {
        asset_id: null,
      });

      expect(clearResult.success).toBe(true);
      expect(mockMeetingBackGraphicsRemoveLayer).toHaveBeenCalledWith({
        layerId: "meeting-content-video",
      });
      expect(meetingContentSourceState.snapshot().video).toBeNull();
      expect(mockRequestStatusPublish).toHaveBeenCalledWith(
        "content_video_set",
      );
    });

    it("meeting_browser_source_set records and clears content_source.browser", async () => {
      mockMeetingBackGraphicsGetStatus.mockReturnValue({
        layers: [{ layerId: "meeting-browser-source" }],
      });

      const setResult = await handleMeetingCommand("meeting_browser_source_set", {
        url: "https://example.test/source",
      });

      expect(setResult.success).toBe(true);
      expect(mockMeetingBackGraphicsSendInternalLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          layerId: "meeting-browser-source",
          zIndex: 11,
        }),
      );
      expect(meetingContentSourceState.snapshot().browser).toMatchObject({
        url: "https://example.test/source",
      });
      expect(mockRequestStatusPublish).toHaveBeenCalledWith(
        "browser_source_set",
      );

      mockMeetingBackGraphicsGetStatus.mockReturnValue({ layers: [] });
      const clearResult = await handleMeetingCommand("meeting_browser_source_set", {
        url: null,
      });

      expect(clearResult.success).toBe(true);
      expect(meetingContentSourceState.snapshot().browser).toBeNull();
      expect(mockRequestStatusPublish).toHaveBeenCalledWith(
        "browser_source_set",
      );
    });
  });

  describe("content layer stage", () => {
    const sentHtml = (): string =>
      (mockMeetingBackGraphicsSendInternalLayer.mock.calls.at(-1)?.[0] as { html: string })
        .html;

    it("places content layers on the 1920x1080 stage for landscape planes", async () => {
      await handleMeetingCommand("meeting_graphics_configure_outputs", {
        width: 1280,
        height: 720,
        fps: 22,
      });

      await handleMeetingCommand("meeting_browser_source_set", {
        url: "https://example.test/source",
        mode: "fullscreen",
      });
      expect(sentHtml()).toContain("width:1920px;height:1080px;");

      await handleMeetingCommand("meeting_content_video_set", {
        asset_id: "asset-video",
        mode: "pip",
        x: 0.5,
        y: 0.5,
        width: 0.5,
        height: 0.5,
      });
      expect(sentHtml()).toContain("left:960px;top:540px;width:960px;height:540px;");
    });

    it("places content layers on the plane size of a portrait program", async () => {
      mockGetProgramFormat.mockReturnValue({ width: 1080, height: 1920, fps: 30 });
      await handleMeetingCommand("meeting_graphics_configure_outputs", {
        width: 1920,
        height: 1080,
        fps: 21,
      });

      await handleMeetingCommand("meeting_browser_source_set", {
        url: "https://example.test/source",
        mode: "fullscreen",
      });
      expect(sentHtml()).toContain("width:1080px;height:1920px;");

      await handleMeetingCommand("meeting_content_video_set", {
        asset_id: "asset-video",
        mode: "pip",
        x: 0.5,
        y: 0.5,
        width: 0.5,
        height: 0.5,
      });
      expect(sentHtml()).toContain("left:540px;top:960px;width:540px;height:960px;");
    });
  });

  describe("unknown commands", () => {
    it("returns an error for unknown meeting commands", async () => {
      const result = await handleMeetingCommand("meeting_unknown", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown meeting command");
    });
  });
});
