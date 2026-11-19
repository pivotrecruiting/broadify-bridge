import {
  DEFAULT_MEETING_PROGRAM_FORMAT,
  MEETING_ENGINE_RESTART_REQUIRED_CODE,
  MEETING_PROGRAM_PORTRAIT_UNSUPPORTED_CODE,
  getMeetingCapabilities,
  isPortraitGeometry,
  isSameProgramGeometry,
  resolveMeetingProgramFormat,
} from "./meeting-capabilities.js";

describe("meeting-capabilities", () => {
  it("advertises the portrait program on macOS only", () => {
    expect(getMeetingCapabilities({ platform: "darwin" })).toEqual({
      program_portrait: true,
    });
    // Same helper code, but not verified on a Windows device yet.
    expect(getMeetingCapabilities({ platform: "win32" })).toEqual({
      program_portrait: false,
    });
    expect(getMeetingCapabilities({ platform: "linux" })).toEqual({
      program_portrait: false,
    });
  });

  it("defaults to the platform of the running process", () => {
    expect(getMeetingCapabilities()).toEqual({
      program_portrait: process.platform === "darwin",
    });
  });

  it("keeps the error codes the web app matches on", () => {
    expect(MEETING_PROGRAM_PORTRAIT_UNSUPPORTED_CODE).toBe(
      "meeting_program_portrait_unsupported",
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

  it("compares geometry by width and height, not frame rate", () => {
    expect(
      isSameProgramGeometry(
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
      ),
    ).toBe(true);
    expect(
      isSameProgramGeometry(
        { width: 1920, height: 1080 },
        { width: 1080, height: 1920 },
      ),
    ).toBe(false);
  });
});
