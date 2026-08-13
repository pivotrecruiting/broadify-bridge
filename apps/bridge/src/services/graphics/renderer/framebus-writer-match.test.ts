import {
  frameBusWriterMatchesTarget,
  normalizeFrameBusNameForCompare,
} from "./framebus-writer-match.js";

const geometry = {
  width: 1920,
  height: 1080,
  fps: 30,
  slotCount: 3,
  pixelFormat: 1,
};

const matchingHeader = {
  width: 1920,
  height: 1080,
  fps: 30,
  slotCount: 3,
  pixelFormat: 1,
};

describe("normalizeFrameBusNameForCompare", () => {
  it("strips POSIX leading slashes", () => {
    expect(normalizeFrameBusNameForCompare("/bfy-meet-gfx-back")).toBe(
      "bfy-meet-gfx-back",
    );
  });

  it("strips Windows Local/Global prefixes and trims", () => {
    expect(normalizeFrameBusNameForCompare("  Local\\bfy-meet-gfx-front ")).toBe(
      "bfy-meet-gfx-front",
    );
    expect(normalizeFrameBusNameForCompare("Global\\bus")).toBe("bus");
  });
});

describe("frameBusWriterMatchesTarget", () => {
  it("matches when geometry and name agree (POSIX writer name form)", () => {
    expect(
      frameBusWriterMatchesTarget({
        header: matchingHeader,
        writerName: "/bfy-meet-gfx-back",
        targetName: "bfy-meet-gfx-back",
        ...geometry,
      }),
    ).toBe(true);
  });

  it("does NOT match a same-geometry writer on a different bus (dual-renderer race)", () => {
    // Before-red proof for the field bug: the old entry logic compared only
    // geometry, so this case returned a match and the configure for the
    // front bus silently no-op'ed while the writer stayed on the back bus.
    expect(
      frameBusWriterMatchesTarget({
        header: matchingHeader,
        writerName: "/bfy-meet-gfx-back",
        targetName: "bfy-meet-gfx-front",
        ...geometry,
      }),
    ).toBe(false);
  });

  it("does not match when geometry differs even with equal names", () => {
    expect(
      frameBusWriterMatchesTarget({
        header: { ...matchingHeader, width: 1280, height: 720 },
        writerName: "/bus",
        targetName: "bus",
        ...geometry,
      }),
    ).toBe(false);
  });

  it("does not match when the writer name is unknown and a target is set", () => {
    expect(
      frameBusWriterMatchesTarget({
        header: matchingHeader,
        writerName: undefined,
        targetName: "bfy-meet-gfx-front",
        ...geometry,
      }),
    ).toBe(false);
  });
});
