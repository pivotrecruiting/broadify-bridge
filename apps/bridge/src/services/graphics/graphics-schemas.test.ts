import {
  GRAPHICS_OUTPUT_CONFIG_VERSION,
  GraphicsOutputKeySchema,
  GraphicsFormatSchema,
  GraphicsConfigureOutputsSchema,
  GraphicsLayoutSchema,
  GraphicsCategorySchema,
} from "./graphics-schemas.js";

describe("graphics-schemas", () => {
  it("exports GRAPHICS_OUTPUT_CONFIG_VERSION", () => {
    expect(GRAPHICS_OUTPUT_CONFIG_VERSION).toBe(1);
  });

  it("GraphicsOutputKeySchema accepts valid output keys", () => {
    expect(GraphicsOutputKeySchema.parse("stub")).toBe("stub");
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
    const result = GraphicsLayoutSchema.parse({ x: 0, y: 0, scale: 1 });
    expect(result).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("GraphicsCategorySchema accepts valid categories", () => {
    expect(GraphicsCategorySchema.parse("lower-thirds")).toBe("lower-thirds");
    expect(GraphicsCategorySchema.parse("overlays")).toBe("overlays");
    expect(GraphicsCategorySchema.parse("slides")).toBe("slides");
  });
});
