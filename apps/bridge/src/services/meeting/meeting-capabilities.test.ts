import {
  DEFAULT_MEETING_PROGRAM_FORMAT,
  MEETING_ENGINE_RESTART_REQUIRED_CODE,
  MEETING_KEYER_FPS_UNSUPPORTED_CODE,
  MEETING_PROGRAM_FORMAT_LIMITS,
  MEETING_PROGRAM_FORMAT_UNSUPPORTED_CODE,
  MEETING_PROGRAM_PORTRAIT_UNSUPPORTED_CODE,
  MEETING_RECORDER_SUPPORTED_CODECS,
  MEETING_RECORDING_CODEC_UNSUPPORTED_CODE,
  MEETING_RECORDER_CODEC_MAX_FPS,
  checkRequestedRecordingCodec,
  findKeyerFpsExcess,
  getMeetingCapabilities,
  getMeetingProgramFormatLimits,
  isPortraitGeometry,
  isSameProgramFormat,
  isSupportedProgramFormat,
  resolveMeetingProgramFormat,
} from "./meeting-capabilities.js";
import type { MeetingRecordingProbeT } from "./meeting-recording-probe.js";

const PROGRAM_FORMATS = {
  max_width: 1920,
  max_height: 1080,
  fps: [25, 30],
  keyer_max_fps: 30,
};
const MAC_PROGRAM_FORMATS = { ...PROGRAM_FORMATS, fps: [25, 30, 50, 60] };

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
      program_formats: MAC_PROGRAM_FORMATS,
      recording_probe: "pending",
      recording_upload: false,
    });
    // Same helper code, but not verified on a Windows device yet.
    expect(getMeetingCapabilities({ platform: "win32" })).toEqual({
      program_portrait: false,
      layer_canvas: true,
      program_formats: PROGRAM_FORMATS,
      recording_probe: "pending",
      recording_upload: false,
    });
    expect(getMeetingCapabilities({ platform: "linux" })).toMatchObject({
      program_portrait: false,
      layer_canvas: true,
      program_formats: PROGRAM_FORMATS,
    });
  });

  it("advertises 1080p everywhere: at 25/30 fps, on macOS at 50/60 fps as well, no 4K", () => {
    expect(MEETING_PROGRAM_FORMAT_LIMITS).toEqual({ darwin: MAC_PROGRAM_FORMATS });
    expect(getMeetingProgramFormatLimits("darwin")).toEqual(MAC_PROGRAM_FORMATS);
    expect(getMeetingProgramFormatLimits("win32")).toEqual(PROGRAM_FORMATS);
    expect(getMeetingProgramFormatLimits("linux")).toEqual(PROGRAM_FORMATS);
    expect(getMeetingProgramFormatLimits()).toEqual(
      getMeetingProgramFormatLimits(process.platform),
    );
  });

  it("hands out a copy of the frame rate list", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const before = getMeetingProgramFormatLimits(platform).fps;
      getMeetingCapabilities({ platform }).program_formats?.fps.push(120);
      getMeetingProgramFormatLimits(platform).fps.push(120);
      expect(getMeetingProgramFormatLimits(platform).fps).toEqual(before);
    }
  });

  describe("recording_probe", () => {
    it("is pending until a state is known and carries no recording block", () => {
      const capabilities = getMeetingCapabilities({ platform: "darwin" });
      expect(capabilities.recording_probe).toBe("pending");
      expect(capabilities).not.toHaveProperty("recording");
    });

    it.each(["pending", "failed"] as const)(
      "reports %s without a recording block",
      (recordingProbeState) => {
        const capabilities = getMeetingCapabilities({
          platform: "darwin",
          recordingProbe: null,
          recordingProbeState,
        });
        expect(capabilities.recording_probe).toBe(recordingProbeState);
        expect(capabilities).not.toHaveProperty("recording");
      },
    );

    it("is done exactly when the recording block is present, also with an empty list", () => {
      const capabilities = getMeetingCapabilities({
        platform: "darwin",
        recordingProbe: { backend: "videotoolbox", encoders: [] },
        recordingProbeState: "done",
      });
      expect(capabilities.recording_probe).toBe("done");
      expect(capabilities.recording).toEqual({ codecs: [], upload_copy: false });
    });

    it("is done with an empty list on a platform without a recorder, whatever the probe did", () => {
      for (const recordingProbeState of ["pending", "failed"] as const) {
        const capabilities = getMeetingCapabilities({
          platform: "linux",
          recordingProbeState,
        });
        expect(capabilities.recording_probe).toBe("done");
        expect(capabilities.recording).toEqual({ codecs: [], upload_copy: false });
      }
    });
  });

  describe("recording", () => {
    it("is left out while the encoder probe result is unknown", () => {
      for (const platform of ["darwin", "win32"] as const) {
        expect(getMeetingCapabilities({ platform })).not.toHaveProperty("recording");
        expect(
          getMeetingCapabilities({ platform, recordingProbe: null }),
        ).not.toHaveProperty("recording");
      }
    });

    it("lists what each platform recorder writes: everything on macOS, H.264 on Windows", () => {
      expect(MEETING_RECORDER_SUPPORTED_CODECS).toEqual({
        darwin: ["h264", "hevc", "prores_422_lt", "prores_422", "prores_422_hq"],
        win32: ["h264"],
      });
    });

    it("advertises every codec on a Mac with HEVC and ProRes hardware, each in its container", () => {
      expect(
        getMeetingCapabilities({ platform: "darwin", recordingProbe: MAC_PROBE })
          .recording,
      ).toEqual({
        codecs: [
          { codec: "h264", container: "mp4", max_height: 1080, max_fps: 60 },
          { codec: "hevc", container: "mp4", max_height: 1080, max_fps: 60 },
          { codec: "prores_422_lt", container: "mov", max_height: 1080, max_fps: 60 },
          { codec: "prores_422", container: "mov", max_height: 1080, max_fps: 60 },
          { codec: "prores_422_hq", container: "mov", max_height: 1080, max_fps: 60 },
        ],
        upload_copy: false,
      });
    });

    it("offers no ProRes on a Mac without ProRes hardware", () => {
      const noProRes: MeetingRecordingProbeT = {
        backend: "videotoolbox",
        encoders: [
          { codec: "h264", name: "Apple H.264 (HW)" },
          { codec: "hevc", name: "Apple HEVC (HW)" },
        ],
      };
      expect(
        getMeetingCapabilities({ platform: "darwin", recordingProbe: noProRes })
          .recording?.codecs.map((entry) => entry.codec),
      ).toEqual(["h264", "hevc"]);
    });

    it("stays at H.264 on Windows even with HEVC hardware, and has no recorder elsewhere", () => {
      const windowsProbe: MeetingRecordingProbeT = {
        backend: "mediafoundation",
        encoders: [
          { codec: "h264", name: "NVIDIA H.264 Encoder MFT", vendor: "nvidia" },
          { codec: "hevc", name: "NVIDIA HEVC Encoder MFT", vendor: "nvidia" },
        ],
      };
      expect(
        getMeetingCapabilities({ platform: "win32", recordingProbe: windowsProbe })
          .recording,
      ).toEqual({
        codecs: [{ codec: "h264", container: "mp4", max_height: 1080, max_fps: 30 }],
        upload_copy: false,
      });
      expect(
        getMeetingCapabilities({ platform: "linux", recordingProbe: windowsProbe })
          .recording,
      ).toEqual({ codecs: [], upload_copy: false });
    });

    it("caps every codec of a platform recorder at a frame rate the platform runs", () => {
      expect(MEETING_RECORDER_CODEC_MAX_FPS).toEqual({
        darwin: {
          h264: 60,
          hevc: 60,
          prores_422_lt: 60,
          prores_422: 60,
          prores_422_hq: 60,
        },
        win32: { h264: 30 },
      });
      for (const platform of ["darwin", "win32"] as const) {
        expect(Object.keys(MEETING_RECORDER_CODEC_MAX_FPS[platform] ?? {})).toEqual(
          MEETING_RECORDER_SUPPORTED_CODECS[platform],
        );
        const capabilities = getMeetingCapabilities({
          platform,
          recordingProbe: MAC_PROBE,
        });
        const limits = getMeetingProgramFormatLimits(platform);
        for (const entry of capabilities.recording?.codecs ?? []) {
          expect(entry.max_height).toBeLessThanOrEqual(limits.max_height);
          expect(limits.fps).toContain(entry.max_fps);
          expect(entry.max_fps).toBe(MEETING_RECORDER_CODEC_MAX_FPS[platform]?.[entry.codec]);
        }
      }
    });

    describe("checkRequestedRecordingCodec", () => {
      const mac = getMeetingCapabilities({
        platform: "darwin",
        recordingProbe: MAC_PROBE,
      });
      const windows = getMeetingCapabilities({
        platform: "win32",
        recordingProbe: MAC_PROBE,
      });
      const refused = (reason: string) => ({ ok: false, reason });

      it("passes an advertised codec and names it", () => {
        expect(checkRequestedRecordingCodec(mac, "prores_422_hq", null)).toEqual({
          ok: true,
          codec: "prores_422_hq",
        });
        expect(checkRequestedRecordingCodec(windows, "h264", null)).toEqual({
          ok: true,
          codec: "h264",
        });
      });

      it("refuses a codec that is not advertised, a name outside the contract included", () => {
        expect(checkRequestedRecordingCodec(windows, "hevc", null)).toEqual(
          refused("encoder_unavailable"),
        );
        expect(checkRequestedRecordingCodec(mac, "av1", null)).toEqual(
          refused("encoder_unavailable"),
        );
      });

      it.each(["pending", "failed"] as const)(
        "refuses every codec while the probe is %s: the encoders are unknown",
        (recordingProbeState) => {
          const unknown = getMeetingCapabilities({
            platform: "darwin",
            recordingProbeState,
          });
          expect(checkRequestedRecordingCodec(unknown, "h264", null)).toEqual(
            refused("encoders_unknown"),
          );
        },
      );

      it("holds the codec to the running program: shorter edge and frame rate", () => {
        const capped = {
          ...mac,
          recording: {
            codecs: [
              { codec: "hevc", container: "mp4", max_height: 1080, max_fps: 30 },
            ],
            upload_copy: false,
          },
        } as const;
        const check = (width: number, height: number, fps: number) =>
          checkRequestedRecordingCodec(capped, "hevc", { width, height, fps });

        expect(check(1920, 1080, 30)).toEqual({ ok: true, codec: "hevc" });
        expect(check(1920, 1080, 25)).toEqual({ ok: true, codec: "hevc" });
        // Portrait is measured by its shorter edge.
        expect(check(1080, 1920, 30)).toEqual({ ok: true, codec: "hevc" });
        expect(check(1920, 1080, 50)).toEqual(refused("program_format_exceeded"));
        expect(check(1920, 1080, 60)).toEqual(refused("program_format_exceeded"));
        expect(check(3840, 2160, 30)).toEqual(refused("program_format_exceeded"));
        expect(check(2160, 3840, 30)).toEqual(refused("program_format_exceeded"));
      });

      it("records a 60 fps program with every macOS codec", () => {
        for (const entry of mac.recording?.codecs ?? []) {
          expect(
            checkRequestedRecordingCodec(mac, entry.codec, {
              width: 1920,
              height: 1080,
              fps: 60,
            }),
          ).toEqual({ ok: true, codec: entry.codec });
        }
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
      expect(
        getMeetingCapabilities({ platform: "win32", recordingProbe: hevcOnly })
          .recording,
      ).toEqual({
        codecs: [],
        upload_copy: false,
      });
      expect(
        getMeetingCapabilities({
          platform: "darwin",
          recordingProbe: { backend: "none", encoders: [] },
        }).recording,
      ).toEqual({ codecs: [], upload_copy: false });
    });
  });

  describe("recording_upload (ADR-0011)", () => {
    it("is false unless the bridge can upload, on every platform", () => {
      for (const platform of ["darwin", "win32", "linux"] as const) {
        expect(getMeetingCapabilities({ platform }).recording_upload).toBe(false);
        expect(getMeetingCapabilities({ platform, recordingUpload: true }).recording_upload).toBe(true);
      }
    });

    it("does not touch upload_copy, which stays reserved for the ProRes upload copy", () => {
      const capabilities = getMeetingCapabilities({
        platform: "darwin",
        recordingProbe: { backend: "videotoolbox", encoders: [{ codec: "h264" }] },
        recordingUpload: true,
      });
      expect(capabilities.recording_upload).toBe(true);
      expect(capabilities.recording?.upload_copy).toBe(false);
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
    expect(getMeetingCapabilities()).toEqual(
      getMeetingCapabilities({ platform: process.platform }),
    );
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
    expect(MEETING_RECORDING_CODEC_UNSUPPORTED_CODE).toBe(
      "meeting_recording_codec_unsupported",
    );
    expect(MEETING_KEYER_FPS_UNSUPPORTED_CODE).toBe("meeting_keyer_fps_unsupported");
  });

  describe("keyer_max_fps", () => {
    it.each(["darwin", "win32", "linux"] as const)(
      "advertises keying at up to 30 fps on %s",
      (platform) => {
        expect(
          getMeetingCapabilities({ platform }).program_formats?.keyer_max_fps,
        ).toBe(30);
      },
    );

    it.each(["darwin", "win32", "linux"] as const)(
      "starts a first-use engine on %s at 30 fps, a rate keying runs at",
      (platform) => {
        const firstUse = resolveMeetingProgramFormat({});
        const limits = getMeetingProgramFormatLimits(platform);
        expect(firstUse.fps).toBe(30);
        expect(isSupportedProgramFormat(firstUse, limits)).toBe(true);
        expect(findKeyerFpsExcess(firstUse, limits)).toBeNull();
      },
    );

    it.each([
      [25, null],
      [30, null],
      [50, { program_fps: 50, keyer_max_fps: 30 }],
      [60, { program_fps: 60, keyer_max_fps: 30 }],
    ])("checks a %i fps program against the limit", (fps, excess) => {
      expect(
        findKeyerFpsExcess(
          { width: 1920, height: 1080, fps },
          getMeetingProgramFormatLimits("darwin"),
        ),
      ).toEqual(excess);
    });

    it("follows the advertised limit, not a fixed 30", () => {
      const limits = { ...PROGRAM_FORMATS, fps: [25, 30, 50, 60], keyer_max_fps: 50 };
      expect(findKeyerFpsExcess({ width: 1920, height: 1080, fps: 50 }, limits)).toBeNull();
      expect(findKeyerFpsExcess({ width: 1920, height: 1080, fps: 60 }, limits)).toEqual({
        program_fps: 60,
        keyer_max_fps: 50,
      });
    });

    it("has nothing to exceed without a running program or without a limit", () => {
      expect(findKeyerFpsExcess(null, getMeetingProgramFormatLimits("darwin"))).toBeNull();
      const format = { width: 1920, height: 1080, fps: 60 };
      expect(findKeyerFpsExcess(format, undefined)).toBeNull();
      expect(
        findKeyerFpsExcess(format, { max_width: 1920, max_height: 1080, fps: [60] }),
      ).toBeNull();
    });
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
    [{ width: 1920, height: 1080, fps: 30 }, true, true],
    [{ width: 1920, height: 1080, fps: 25 }, true, true],
    [{ width: 1280, height: 720, fps: 30 }, true, true],
    // Portrait is measured with its edges swapped.
    [{ width: 1080, height: 1920, fps: 30 }, true, true],
    [{ width: 720, height: 1280, fps: 25 }, true, true],
    // 50 and 60 fps on macOS only.
    [{ width: 1920, height: 1080, fps: 50 }, true, false],
    [{ width: 1920, height: 1080, fps: 60 }, true, false],
    [{ width: 1080, height: 1920, fps: 60 }, true, false],
    [{ width: 1920, height: 1080, fps: 24 }, false, false],
    [{ width: 1920, height: 1080, fps: 120 }, false, false],
    [{ width: 3840, height: 2160, fps: 30 }, false, false],
    [{ width: 2160, height: 3840, fps: 30 }, false, false],
    [{ width: 1920, height: 1200, fps: 30 }, false, false],
    [{ width: 1200, height: 1920, fps: 30 }, false, false],
  ])(
    "checks %j against the advertised program formats: macOS %s, elsewhere %s",
    (format, onMac, elsewhere) => {
      expect(
        isSupportedProgramFormat(format, getMeetingProgramFormatLimits("darwin")),
      ).toBe(onMac);
      for (const platform of ["win32", "linux"] as const) {
        expect(
          isSupportedProgramFormat(format, getMeetingProgramFormatLimits(platform)),
        ).toBe(elsewhere);
      }
      expect(isSupportedProgramFormat(format)).toBe(
        isSupportedProgramFormat(format, getMeetingProgramFormatLimits(process.platform)),
      );
    },
  );

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
