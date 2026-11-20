import {
  GRAPHICS_OUTPUT_CONFIG_VERSION,
  GraphicsOutputKeySchema,
  GraphicsFormatSchema,
  GraphicsConfigureOutputsSchema,
  GraphicsLayoutSchema,
  GraphicsLayerCanvasSchema,
  GraphicsSendSchema,
  GraphicsCategorySchema,
} from "./graphics-schemas.js";

describe("graphics-schemas", () => {
  it("exports GRAPHICS_OUTPUT_CONFIG_VERSION", () => {
    expect(GRAPHICS_OUTPUT_CONFIG_VERSION).toBe(1);
  });

  it("GraphicsOutputKeySchema accepts valid output keys", () => {
    expect(GraphicsOutputKeySchema.parse("stub")).toBe("stub");
    expect(GraphicsOutputKeySchema.parse("framebus")).toBe("framebus");
    expect(GraphicsOutputKeySchema.parse("key_fill_sdi")).toBe("key_fill_sdi");
    expect(GraphicsOutputKeySchema.parse("video_hdmi")).toBe("video_hdmi");
  });

  it("GraphicsFormatSchema accepts valid format", () => {
    const result = GraphicsFormatSchema.parse({
      width: 1920,
      height: 1080,
      fps: 30,
    });
    expect(result).toEqual({ width: 1920, height: 1080, fps: 30 });
  });

  it("GraphicsConfigureOutputsSchema accepts minimal config with defaults", () => {
    const result = GraphicsConfigureOutputsSchema.parse({
      outputKey: "stub",
      targets: {},
      format: { width: 1920, height: 1080, fps: 30 },
    });
    expect(result.version).toBe(1);
    expect(result.range).toBe("legal");
    expect(result.colorspace).toBe("auto");
  });

  it("GraphicsLayoutSchema accepts valid layout", () => {
    const result = GraphicsLayoutSchema.parse({
      x: 0,
      y: 0,
      scale: 1,
      scaleX: 0.8,
      scaleY: 0.6,
      rotationX: 10,
      rotationY: -12,
      rotationZ: 18,
    });
    expect(result).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      scaleX: 0.8,
      scaleY: 0.6,
      rotationX: 10,
      rotationY: -12,
      rotationZ: 18,
    });
  });

  describe("graphics_send canvas", () => {
    const send = {
      layerId: "layer-1",
      category: "overlays",
      backgroundMode: "transparent",
      layout: { x: 0, y: 0, scale: 1 },
      zIndex: 1,
      bundle: { manifest: {}, html: "<div></div>" },
    };

    it("is optional: a payload without it parses without a canvas key", () => {
      const result = GraphicsSendSchema.parse(send);

      // Not even `canvas: undefined`: everything downstream sees the payload
      // it saw before the field existed.
      expect("canvas" in result).toBe(false);
    });

    it("accepts integer sizes from 16 to 7680", () => {
      expect(
        GraphicsSendSchema.parse({ ...send, canvas: { width: 1080, height: 1920 } })
          .canvas,
      ).toEqual({ width: 1080, height: 1920 });
      expect(GraphicsLayerCanvasSchema.parse({ width: 16, height: 7680 })).toEqual({
        width: 16,
        height: 7680,
      });
    });

    it.each([
      ["below 16", { width: 15, height: 1920 }],
      ["above 7680", { width: 1080, height: 7681 }],
      ["with a fractional size", { width: 1080.5, height: 1920 }],
      ["with a string size", { width: "1080", height: 1920 }],
      ["missing a side", { width: 1080 }],
      ["with an unknown key", { width: 1080, height: 1920, depth: 1 }],
      ["of null", null],
    ])("rejects a canvas %s", (_name, canvas) => {
      expect(GraphicsSendSchema.safeParse({ ...send, canvas }).success).toBe(false);
    });
  });

  it("GraphicsCategorySchema accepts valid categories", () => {
    expect(GraphicsCategorySchema.parse("backgrounds")).toBe("backgrounds");
    expect(GraphicsCategorySchema.parse("lower-thirds")).toBe("lower-thirds");
    expect(GraphicsCategorySchema.parse("overlays")).toBe("overlays");
    expect(GraphicsCategorySchema.parse("slides")).toBe("slides");
  });
});
