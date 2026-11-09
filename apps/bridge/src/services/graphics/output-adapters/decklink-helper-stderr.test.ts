import { classifyDeckLinkHelperStderrLine } from "./decklink-helper-stderr.js";

describe("classifyDeckLinkHelperStderrLine", () => {
  it("routes periodic playback telemetry to debug", () => {
    expect(
      classifyDeckLinkHelperStderrLine("Playback stats: completed=27 late=0 dropped=0"),
    ).toBe("debug");
    expect(classifyDeckLinkHelperStderrLine("Buffered video frame count: 4")).toBe("debug");
  });

  it("routes tolerated FrameBus size differences to info", () => {
    expect(
      classifyDeckLinkHelperStderrLine(
        "FrameBus size mismatch (tolerated). expected=24883328 got=24887296",
      ),
    ).toBe("info");
  });

  it("routes diagnostics without failure vocabulary to info", () => {
    expect(
      classifyDeckLinkHelperStderrLine(
        "[DeckLinkHelper] CreateVideoFrame (output) ok: rowBytes=7680",
      ),
    ).toBe("info");
    expect(
      classifyDeckLinkHelperStderrLine("Playback config: device=1 port=sdi fps=50"),
    ).toBe("info");
    expect(classifyDeckLinkHelperStderrLine("Selected display mode: 1080p50")).toBe("info");
    expect(classifyDeckLinkHelperStderrLine("FrameBus stale reader reopened.")).toBe("warn");
  });

  it.each([
    "StartScheduledPlayback failed. HRESULT=0x80004005",
    "ScheduleVideoFrame failed. HRESULT=0x80004005",
    "FrameBus open failed: ENOENT",
    "DeckLink device not found: 1",
    "DeckLink iterator could not be created. Check drivers.",
    "External keying not supported by device.",
    "Invalid playback configuration.",
    "Unsupported pixel format for RGBA conversion: error",
    "FrameBus header mismatch. expected=1 got=2",
    "Frame header mismatch. expected=1 got=2",
    "FrameBus reader stale; attempting reopen.",
    "[DeckLinkHelper] ScheduleFrame aborted: shutdown",
    "Unable to open device",
    "Cannot allocate frame",
    "Access denied",
    "Playback failure after 3 frames",
  ])("keeps failure lines at warn: %s", (line) => {
    expect(classifyDeckLinkHelperStderrLine(line)).toBe("warn");
  });

  it("matches failure vocabulary case-insensitively", () => {
    expect(classifyDeckLinkHelperStderrLine("ERROR: something")).toBe("warn");
    expect(classifyDeckLinkHelperStderrLine("Keyer enable FAILED")).toBe("warn");
  });

  it("does not treat telemetry as failure even when the line mentions dropped frames", () => {
    expect(
      classifyDeckLinkHelperStderrLine("Playback stats: completed=815 late=3 dropped=2"),
    ).toBe("debug");
  });
});
