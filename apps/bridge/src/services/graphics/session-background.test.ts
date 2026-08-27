import {
  resolveSessionBackgroundMode,
} from "./session-background.js";

describe("resolveSessionBackgroundMode", () => {
  it("keeps alpha outputs transparent", () => {
    // These consumers read the alpha channel, so the empty picture is an empty
    // frame - filling them with a colour would put a solid box on air.
    expect(resolveSessionBackgroundMode("key_fill_sdi")).toBe("transparent");
    expect(resolveSessionBackgroundMode("key_fill_ndi")).toBe("transparent");
    expect(resolveSessionBackgroundMode("browser_input")).toBe("transparent");
    expect(resolveSessionBackgroundMode("stub")).toBe("transparent");
  });

  it("keeps the meeting planes transparent", () => {
    // Acceptance criterion, not a detail: the meeting graphics planes run
    // through the SAME renderer under outputKey "framebus", and the native
    // compositor alpha-blends them over the camera. An opaque idle frame here
    // would cover the camera picture in every meeting.
    expect(resolveSessionBackgroundMode("framebus")).toBe("transparent");
  });

  it("uses the key colour for outputs without alpha", () => {
    expect(resolveSessionBackgroundMode("video_hdmi")).toBe("green");
    expect(resolveSessionBackgroundMode("video_sdi")).toBe("green");
  });

  it("honours the environment override for opaque outputs", () => {
    expect(resolveSessionBackgroundMode("video_hdmi", "black")).toBe("black");
    expect(resolveSessionBackgroundMode("video_hdmi", " WHITE ")).toBe("white");
  });

  it("ignores an unusable override instead of failing the output", () => {
    expect(resolveSessionBackgroundMode("video_hdmi", "chartreuse")).toBe("green");
    expect(resolveSessionBackgroundMode("video_hdmi", "")).toBe("green");
  });

  it("never lets the override reach an alpha output", () => {
    expect(resolveSessionBackgroundMode("framebus", "green")).toBe("transparent");
    expect(resolveSessionBackgroundMode("key_fill_sdi", "white")).toBe("transparent");
  });

  it("falls back to transparent without an output", () => {
    expect(resolveSessionBackgroundMode(null)).toBe("transparent");
    expect(resolveSessionBackgroundMode(undefined)).toBe("transparent");
  });
});
