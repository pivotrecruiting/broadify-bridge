import { buildIdleFrameBuffer, resolveIdleFrameColor } from "./idle-frame.js";

describe("resolveIdleFrameColor", () => {
  it("maps the background modes to the DOM runtime colours", () => {
    expect(resolveIdleFrameColor("green", null)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(resolveIdleFrameColor("black", null)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(resolveIdleFrameColor("white", null)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(resolveIdleFrameColor("transparent", null)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("treats an unknown or missing mode as transparent", () => {
    expect(resolveIdleFrameColor("chartreuse", null)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(resolveIdleFrameColor(null, null)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("lets an explicit clear colour win and scales its alpha to bytes", () => {
    expect(
      resolveIdleFrameColor("green", { r: 10, g: 20, b: 30, a: 1 })
    ).toEqual({ r: 10, g: 20, b: 30, a: 255 });
    expect(
      resolveIdleFrameColor("green", { r: 0, g: 0, b: 0, a: 0.5 })
    ).toEqual({ r: 0, g: 0, b: 0, a: 128 });
  });

  it("clamps out-of-range clear colour channels", () => {
    expect(
      resolveIdleFrameColor(null, { r: -5, g: 999, b: 12.4, a: 3 })
    ).toEqual({ r: 0, g: 255, b: 12, a: 255 });
  });

  it("falls back to the mode when the clear colour is unusable", () => {
    expect(
      resolveIdleFrameColor("green", { r: Number.NaN, g: 0, b: 0, a: 1 })
    ).toEqual({ r: 0, g: 255, b: 0, a: 255 });
  });
});

describe("buildIdleFrameBuffer", () => {
  it("fills every pixel with the colour", () => {
    const buffer = buildIdleFrameBuffer(2, 2, { r: 0, g: 255, b: 0, a: 255 });
    expect(buffer.length).toBe(2 * 2 * 4);
    expect(Array.from(buffer)).toEqual([
      0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
    ]);
  });

  it("produces all zeros for transparent, byte for byte as before", () => {
    const buffer = buildIdleFrameBuffer(3, 2, { r: 0, g: 0, b: 0, a: 0 });
    expect(buffer.equals(Buffer.alloc(3 * 2 * 4, 0))).toBe(true);
  });

  it("returns an empty buffer for a degenerate size", () => {
    expect(buildIdleFrameBuffer(0, 0, { r: 0, g: 255, b: 0, a: 255 }).length).toBe(0);
  });
});
