import { StubRenderer } from "./stub-renderer.js";

describe("StubRenderer", () => {
  let renderer: StubRenderer;

  beforeEach(() => {
    renderer = new StubRenderer();
  });

  it("initializes without throwing", async () => {
    await expect(renderer.initialize()).resolves.toBeUndefined();
  });

  it("configureSession resolves without throwing", async () => {
    await expect(
      renderer.configureSession({
        width: 1920,
        height: 1080,
        fps: 60,
        pixelFormat: 1,
        framebusName: "",
        framebusSlotCount: 0,
        framebusSize: 0,
        backgroundMode: "transparent",
      })
    ).resolves.toBeUndefined();
  });

  it("setAssets resolves without throwing", async () => {
    await expect(
      renderer.setAssets({ id: { filePath: "/path", mime: "image/png" } })
    ).resolves.toBeUndefined();
  });

  it("renderLayer registers layer id", async () => {
    await renderer.renderLayer({
      layerId: "layer-1",
      html: "<div/>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 60,
    });
    await renderer.removeLayer("layer-1");
    // Stub does not expose layers; we only check no throw and shutdown clears
    await renderer.shutdown();
  });

  it("updateValues resolves without throwing", async () => {
    await renderer.updateValues("layer-1", { key: "value" });
  });

  it("updateLayout resolves without throwing", async () => {
    await renderer.updateLayout(
      "layer-1",
      { x: 10, y: 20, scale: 1 },
      1
    );
  });

  it("removeLayer resolves without throwing", async () => {
    await renderer.removeLayer("layer-1");
  });

  it("onError accepts callback without throwing", () => {
    expect(() => renderer.onError(() => {})).not.toThrow();
  });

  it("shutdown clears internal state and resolves", async () => {
    await renderer.renderLayer({
      layerId: "layer-1",
      html: "",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 60,
    });
    await expect(renderer.shutdown()).resolves.toBeUndefined();
  });
});
