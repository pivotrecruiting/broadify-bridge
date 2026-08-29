import { selectFrameBusSeedFrame } from "./framebus-seed-frame.js";

describe("selectFrameBusSeedFrame", () => {
  const width = 4;
  const height = 2;
  const frameSize = width * height * 4;

  it("re-publishes a retained frame whose geometry still fits", () => {
    const retained = Buffer.alloc(frameSize, 7);
    expect(selectFrameBusSeedFrame(retained, width, height)).toBe(retained);
  });

  it("falls back to blank when nothing was retained", () => {
    expect(selectFrameBusSeedFrame(null, width, height)).toBeNull();
    expect(selectFrameBusSeedFrame(undefined, width, height)).toBeNull();
  });

  it("falls back to blank after a geometry change", () => {
    // A frame retained from the previous 1920x1080 session must not be pushed
    // into a writer configured for a different size: the native writer rejects
    // the length outright ("Frame size mismatch").
    const retained = Buffer.alloc(frameSize + 4, 7);
    expect(selectFrameBusSeedFrame(retained, width, height)).toBeNull();
  });

  it("falls back to blank for a degenerate target geometry", () => {
    const retained = Buffer.alloc(frameSize, 7);
    expect(selectFrameBusSeedFrame(retained, 0, height)).toBeNull();
    expect(selectFrameBusSeedFrame(retained, width, 0)).toBeNull();
  });

  it("treats an empty retained buffer as nothing to re-publish", () => {
    // Buffer.alloc(0) is falsy-adjacent but not falsy; guard against a
    // zero-length frame slipping through and being written as a valid seed.
    expect(selectFrameBusSeedFrame(Buffer.alloc(0), width, height)).toBeNull();
  });
});
