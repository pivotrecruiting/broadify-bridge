const mockGetClient = jest.fn();
const mockIsRunning = jest.fn();
const mockGetStatus = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockGetFullStatus = jest.fn();
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
  });

  describe("push-on-write meeting commands", () => {
    it.each([
      ["meeting_camera_select", { stable_key: "cam-a" }, "camera_select"],
      ["meeting_camera_start", { stable_key: "cam-a" }, "camera_start"],
      ["meeting_camera_stop", {}, "camera_stop"],
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

  describe("unknown commands", () => {
    it("returns an error for unknown meeting commands", async () => {
      const result = await handleMeetingCommand("meeting_unknown", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown meeting command");
    });
  });
});
