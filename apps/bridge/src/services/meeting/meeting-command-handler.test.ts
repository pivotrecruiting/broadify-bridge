const mockGetClient = jest.fn();
const mockIsRunning = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockGetFullStatus = jest.fn();
const mockMeetingGraphicsConfigureOutputs = jest.fn();
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
    start: (...args: unknown[]) => mockStart(...args),
    stop: (...args: unknown[]) => mockStop(...args),
    getFullStatus: (...args: unknown[]) => mockGetFullStatus(...args),
  },
}));

jest.mock("./meeting-graphics-manager.js", () => ({
  meetingGraphicsManager: {
    configureOutputs: (...args: unknown[]) =>
      mockMeetingGraphicsConfigureOutputs(...args),
  },
}));

jest.mock("../graphics/framebus/framebus-client.js", () => ({
  loadFrameBusModule: (...args: unknown[]) => mockLoadFrameBusModule(...args),
}));

import {
  handleMeetingCommand,
  isMeetingCommand,
} from "./meeting-command-handler.js";

const mockClient = {
  listCameras: jest.fn(),
  cameraSelect: jest.fn(),
  cameraStart: jest.fn(),
  cameraStop: jest.fn(),
  keyerGet: jest.fn(),
  keyerConfigure: jest.fn(),
  keyerReset: jest.fn(),
  programGet: jest.fn(),
  programUpdate: jest.fn(),
  buttonsList: jest.fn(),
  buttonTrigger: jest.fn(),
  framebusStart: jest.fn(),
  framebusStop: jest.fn(),
  framebusConfigure: jest.fn(),
  virtualCameraStart: jest.fn(),
  virtualCameraStop: jest.fn(),
  virtualCameraConfigure: jest.fn(),
};

describe("meeting-command-handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetClient.mockReturnValue(mockClient);
    mockIsRunning.mockReturnValue(true);
    mockMeetingGraphicsConfigureOutputs.mockResolvedValue(undefined);
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
  });

  describe("meeting_engine_start", () => {
    it("starts the engine and returns status", async () => {
      mockStart.mockResolvedValue({ state: "running", port: 9100 });

      const result = await handleMeetingCommand("meeting_engine_start", {
        width: 1280,
        height: 720,
      });

      expect(mockStart).toHaveBeenCalledWith({ width: 1280, height: 720 });
      expect(result.success).toBe(true);
    });

    it("fails when the engine does not reach running state", async () => {
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

    it("forwards keyer configuration", async () => {
      mockClient.keyerConfigure.mockResolvedValue({ enabled: true });

      const result = await handleMeetingCommand("meeting_keyer_configure", {
        enabled: true,
        model: "vision_person_segmentation",
        quality_mode: "accurate",
        mask_dilate_px: 4,
        mask_feather_px: 1,
        dynamic_dilation: true,
      });

      expect(mockClient.keyerConfigure).toHaveBeenCalledWith({
        enabled: true,
        model: "vision_person_segmentation",
        quality_mode: "accurate",
        mask_dilate_px: 4,
        mask_feather_px: 1,
        dynamic_dilation: true,
      });
      expect(result.success).toBe(true);
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
    });

    it("rejects unknown program sections", async () => {
      await expect(
        handleMeetingCommand("meeting_program_update", {
          section: "unknown",
          values: {},
        }),
      ).rejects.toThrow("Invalid payload for meeting_program_update");
    });

    it("triggers buttons", async () => {
      mockClient.buttonTrigger.mockResolvedValue({ ok: true });

      const result = await handleMeetingCommand("meeting_button_trigger", {
        mode: "meeting",
        buttonId: "btn-1",
      });

      expect(mockClient.buttonTrigger).toHaveBeenCalledWith("meeting", "btn-1");
      expect(result.success).toBe(true);
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
      expect(mockMeetingGraphicsConfigureOutputs).toHaveBeenCalledWith({
        outputKey: "framebus",
        targets: {},
        format: { width: 1280, height: 720, fps: 30 },
        range: "full",
        colorspace: "rec709",
      });
      expect(result.data).toMatchObject({
        framebusName: "bfy-meet-gfx",
        width: 1280,
        height: 720,
        fps: 30,
      });
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
