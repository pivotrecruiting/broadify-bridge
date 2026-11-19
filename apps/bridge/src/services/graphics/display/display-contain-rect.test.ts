import { computeContainRect } from "./display-contain-rect.js";

describe("computeContainRect", () => {
  it("fills the canvas when the aspect ratios match", () => {
    expect(computeContainRect(1920, 1080, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(computeContainRect(1280, 720, 3840, 2160)).toEqual({
      x: 0,
      y: 0,
      width: 3840,
      height: 2160,
    });
  });

  it("pillarboxes a portrait frame on a landscape display", () => {
    expect(computeContainRect(1080, 1920, 1920, 1080)).toEqual({
      x: 656,
      y: 0,
      width: 608,
      height: 1080,
    });
  });

  it("letterboxes a 16:9 frame on a 16:10 display", () => {
    expect(computeContainRect(1920, 1080, 1920, 1200)).toEqual({
      x: 0,
      y: 60,
      width: 1920,
      height: 1080,
    });
  });

  it("letterboxes a landscape frame on a portrait display", () => {
    expect(computeContainRect(1920, 1080, 1080, 1920)).toEqual({
      x: 0,
      y: 656,
      width: 1080,
      height: 608,
    });
  });

  it("never leaves the canvas", () => {
    for (const [sw, sh, dw, dh] of [
      [1080, 1920, 1366, 768],
      [1921, 1079, 1920, 1080],
      [3, 1000, 7, 5],
      [1000, 3, 5, 7],
    ]) {
      const rect = computeContainRect(sw, sh, dw, dh);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.width).toBeGreaterThanOrEqual(1);
      expect(rect.height).toBeGreaterThanOrEqual(1);
      expect(rect.x + rect.width).toBeLessThanOrEqual(dw);
      expect(rect.y + rect.height).toBeLessThanOrEqual(dh);
    }
  });

  it("falls back to the full canvas for unusable input", () => {
    expect(computeContainRect(0, 1080, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(computeContainRect(Number.NaN, 1080, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    expect(computeContainRect(1920, 1080, 0, 0)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("stays self-contained so the display page can embed its source", () => {
    // display-output-entry.ts inlines computeContainRect.toString() into the
    // page script; rebuild it from source alone and compare results.
    const rebuilt = new Function(
      `return (${computeContainRect.toString()});`,
    )() as typeof computeContainRect;
    expect(rebuilt(1080, 1920, 1920, 1080)).toEqual(
      computeContainRect(1080, 1920, 1920, 1080),
    );
  });
});
