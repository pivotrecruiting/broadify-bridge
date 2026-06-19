import { getApplyLayoutRuntimeScript } from "./layout-runtime.js";

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
});
