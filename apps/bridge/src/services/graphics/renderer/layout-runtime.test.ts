import { getApplyLayoutRuntimeScript } from "./layout-runtime.js";

type LayerCanvasT = { width: number; height: number };
type LayoutRuntimeT = {
  resolveLayerCanvas: (
    canvas: unknown,
    baseWidth: number,
    baseHeight: number,
  ) => LayerCanvasT;
  applyLayout: (
    host: { style: Record<string, string> },
    layout: Record<string, number>,
  ) => void;
};

/** Evaluates the generated browser script and hands back what it defines. */
const loadLayoutRuntime = (renderScale?: number): LayoutRuntimeT =>
  new Function(
    `${getApplyLayoutRuntimeScript(renderScale)}
      return { resolveLayerCanvas, applyLayout };`,
  )() as LayoutRuntimeT;

describe("layout-runtime", () => {
  it("builds the shared layout transform script", () => {
    const script = getApplyLayoutRuntimeScript(2);

    expect(script).toContain("const applyLayout");
    expect(script).toContain("GRAPHICS_RENDER_SCALE = 2");
    expect(script).toContain("layout?.scaleX");
    expect(script).toContain("layout?.scaleY");
    expect(script).toContain("layout?.rotationX");
    expect(script).toContain("layout?.rotationY");
    expect(script).toContain("layout?.rotationZ");
    expect(script).toContain("scale(\" + scaleX + \", \" + scaleY + \")");
    expect(script).toContain("translate3d(");
    expect(script).toContain("translateZ(0)");
    expect(script).toContain("preserve-3d");
    expect(script).toContain("backfaceVisibility");
    expect(script).toContain("willChange");
    expect(script).toContain("imageRendering");
  });

  describe("resolveLayerCanvas", () => {
    const { resolveLayerCanvas } = loadLayoutRuntime();

    it("keeps the baseline of the host when the layer has no canvas", () => {
      expect(resolveLayerCanvas(undefined, 1920, 1080)).toEqual({
        width: 1920,
        height: 1080,
      });
    });

    it("takes the canvas sent with the layer", () => {
      expect(resolveLayerCanvas({ width: 1080, height: 1920 }, 1920, 1080)).toEqual({
        width: 1080,
        height: 1920,
      });
    });

    it.each([
      ["null", null],
      ["a missing side", { width: 1080 }],
      ["a zero side", { width: 0, height: 1920 }],
      ["a negative side", { width: 1080, height: -1920 }],
      ["a non-numeric side", { width: "wide", height: 1920 }],
      ["an infinite side", { width: Infinity, height: 1920 }],
    ])("falls back to the baseline for %s", (_name, canvas) => {
      // The bridge validates the field; a box of 0 or NaN pixels would make
      // the layer vanish, so the page never trusts it blindly.
      expect(resolveLayerCanvas(canvas, 1920, 1080)).toEqual({
        width: 1920,
        height: 1080,
      });
    });
  });

  describe("applyLayout", () => {
    const layout = { x: 108, y: 192, scale: 1, scaleX: 0.4, scaleY: 0.4 };

    it("positions the box in plane pixels at render scale 1", () => {
      const host = { style: {} as Record<string, string> };

      loadLayoutRuntime(1).applyLayout(host, layout);

      expect(host.style.transform).toBe(
        "translate3d(108px, 192px, 0) scale(0.4, 0.4) " +
          "rotateX(0deg) rotateY(0deg) rotateZ(0deg) translateZ(0)",
      );
    });

    it("carries the render scale for the whole box: translation and scale", () => {
      // This is why the box size itself is never multiplied by the render
      // scale - neither the 1920x1080 baseline nor a per-layer canvas.
      const host = { style: {} as Record<string, string> };

      loadLayoutRuntime(2).applyLayout(host, layout);

      expect(host.style.transform).toBe(
        "translate3d(216px, 384px, 0) scale(0.8, 0.8) " +
          "rotateX(0deg) rotateY(0deg) rotateZ(0deg) translateZ(0)",
      );
    });
  });
});
