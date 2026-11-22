import {
  DEFAULT_MEETING_PROGRAM_FORMAT,
  MEETING_ENGINE_RESTART_REQUIRED_CODE,
  MEETING_PROGRAM_FORMAT_LIMITS,
  MEETING_PROGRAM_FORMAT_UNSUPPORTED_CODE,
  MEETING_PROGRAM_PORTRAIT_UNSUPPORTED_CODE,
  MEETING_RECORDER_SUPPORTED_CODECS,
  getMeetingCapabilities,
  isPortraitGeometry,
  isSameProgramFormat,
  isSupportedProgramFormat,
  resolveMeetingProgramFormat,
} from "./meeting-capabilities.js";
import type { MeetingRecordingProbeT } from "./meeting-recording-probe.js";

const PROGRAM_FORMATS = { max_width: 1920, max_height: 1080, fps: [25, 30] };

/** What an Apple Silicon Mac with ProRes hardware reports. */
const MAC_PROBE: MeetingRecordingProbeT = {
  backend: "videotoolbox",
  encoders: [
    { codec: "prores_422", name: "AppleProResHW 422" },
    { codec: "prores_422_hq", name: "AppleProResHW 422 HQ" },
    { codec: "prores_422_lt", name: "AppleProResHW 422 LT" },
    { codec: "h264", name: "Apple H.264 (HW)" },
    { codec: "hevc", name: "Apple HEVC (HW)" },
  ],
};

describe("meeting-capabilities", () => {
  it("advertises the portrait program on macOS only", () => {
    expect(getMeetingCapabilities({ platform: "darwin" })).toEqual({
      program_portrait: true,
      layer_canvas: true,
      program_formats: PROGRAM_FORMATS,
    });
    // Same helper code, but not verified on a Windows device yet.
    expect(getMeetingCapabilities({ platform: "win32" })).toEqual({
      program_portrait: false,
      layer_canvas: true,
      program_formats: PROGRAM_FORMATS,
    });
    expect(getMeetingCapabilities({ platform: "linux" })).toEqual({
      program_portrait: false,
      layer_canvas: true,
      program_formats: PROGRAM_FORMATS,
    });
  });

  it("advertises 1080p at 25 and 30 fps as the program formats, no 4K and no 50/60", () => {
    expect(MEETING_PROGRAM_FORMAT_LIMITS).toEqual(PROGRAM_FORMATS);
  });

  it("hands out a copy of the frame rate list", () => {
    getMeetingCapabilities().program_formats?.fps.push(60);
    expect(MEETING_PROGRAM_FORMAT_LIMITS.fps).toEqual([25, 30]);
  });

  describe("recording", () => {
    it("is left out while the encoder probe result is unknown", () => {
      expect(getMeetingCapabilities()).not.toHaveProperty("recording");
      expect(
        getMeetingCapabilities({ recordingProbe: null }),
      ).not.toHaveProperty("recording");
    });

    it("advertises only what the recorder writes today: H.264 in mp4", () => {
      // The machine has HEVC and ProRes hardware, the recorder does not write
      // them yet.
      expect(MEETING_RECORDER_SUPPORTED_CODECS).toEqual([
        { codec: "h264", container: "mp4" },
      ]);
      expect(getMeetingCapabilities({ recordingProbe: MAC_PROBE }).recording).toEqual({
        codecs: [{ codec: "h264", container: "mp4", max_height: 1080, max_fps: 30 }],
        upload_copy: false,
      });
    });

    it("lists a codec once even when two hardware encoders offer it", () => {
      const probe: MeetingRecordingProbeT = {
        backend: "mediafoundation",
        encoders: [
          { codec: "h264", name: "NVIDIA H.264 Encoder MFT", vendor: "nvidia" },
          { codec: "h264", name: "Intel Quick Sync H.264", vendor: "intel" },
        ],
      };
      expect(
        getMeetingCapabilities({ platform: "win32", recordingProbe: probe }).recording
          ?.codecs,
      ).toEqual([{ codec: "h264", container: "mp4", max_height: 1080, max_fps: 30 }]);
    });

    it("advertises no codec without a hardware encoder for it (no software fallback)", () => {
      const hevcOnly: MeetingRecordingProbeT = {
        backend: "mediafoundation",
        encoders: [{ codec: "hevc", name: "HEVC Encoder MFT", vendor: "amd" }],
      };
      expect(getMeetingCapabilities({ recordingProbe: hevcOnly }).recording).toEqual({
        codecs: [],
        upload_copy: false,
      });
      expect(
        getMeetingCapabilities({
          recordingProbe: { backend: "none", encoders: [] },
        }).recording,
      ).toEqual({ codecs: [], upload_copy: false });
    });
  });

  it("advertises the per-layer canvas on every platform", () => {
    // A feature of the graphics renderer, not of the portrait engine: it must
    // not follow program_portrait.
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(getMeetingCapabilities({ platform }).layer_canvas).toBe(true);
    }
  });

  it("defaults to the platform of the running process", () => {
    expect(getMeetingCapabilities()).toEqual({
      program_portrait: process.platform === "darwin",
      layer_canvas: true,
      program_formats: PROGRAM_FORMATS,
    });
  });

  it("keeps the error codes the web app matches on", () => {
    expect(MEETING_PROGRAM_PORTRAIT_UNSUPPORTED_CODE).toBe(
      "meeting_program_portrait_unsupported",
    );
    expect(MEETING_PROGRAM_FORMAT_UNSUPPORTED_CODE).toBe(
      "meeting_program_format_unsupported",
    );
    expect(MEETING_ENGINE_RESTART_REQUIRED_CODE).toBe(
      "meeting_engine_restart_required",
    );
  });

  it("fills the engine defaults into a partial start payload", () => {
    expect(DEFAULT_MEETING_PROGRAM_FORMAT).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(resolveMeetingProgramFormat({})).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(resolveMeetingProgramFormat({ width: 1080, height: 1920 })).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(resolveMeetingProgramFormat({ fps: 60 })).toEqual({
      width: 1920,
      height: 1080,
      fps: 60,
    });
  });

  it("treats only height > width as portrait", () => {
    expect(isPortraitGeometry({ width: 1080, height: 1920 })).toBe(true);
    expect(isPortraitGeometry({ width: 1920, height: 1080 })).toBe(false);
    expect(isPortraitGeometry({ width: 1080, height: 1080 })).toBe(false);
  });

  it("compares program formats by width, height and frame rate", () => {
    const format = { width: 1920, height: 1080, fps: 30 };
    expect(isSameProgramFormat(format, { ...format })).toBe(true);
    expect(isSameProgramFormat(format, { width: 1080, height: 1920, fps: 30 })).toBe(
      false,
    );
    expect(isSameProgramFormat(format, { ...format, fps: 25 })).toBe(false);
  });

  it.each([
    [{ width: 1920, height: 1080, fps: 30 }, true],
    [{ width: 1920, height: 1080, fps: 25 }, true],
    [{ width: 1280, height: 720, fps: 30 }, true],
    // Portrait is measured with its edges swapped.
    [{ width: 1080, height: 1920, fps: 30 }, true],
    [{ width: 720, height: 1280, fps: 25 }, true],
    [{ width: 1920, height: 1080, fps: 60 }, false],
    [{ width: 1920, height: 1080, fps: 24 }, false],
    [{ width: 3840, height: 2160, fps: 30 }, false],
    [{ width: 2160, height: 3840, fps: 30 }, false],
    [{ width: 1920, height: 1200, fps: 30 }, false],
    [{ width: 1200, height: 1920, fps: 30 }, false],
  ])("checks %j against the advertised program formats: %s", (format, supported) => {
    expect(isSupportedProgramFormat(format)).toBe(supported);
  });

  it("checks a program format against explicit limits", () => {
    const limits = { max_width: 3840, max_height: 2160, fps: [50] };
    expect(isSupportedProgramFormat({ width: 3840, height: 2160, fps: 50 }, limits)).toBe(
      true,
    );
    expect(isSupportedProgramFormat({ width: 3840, height: 2160, fps: 30 }, limits)).toBe(
      false,
    );
  });
});
