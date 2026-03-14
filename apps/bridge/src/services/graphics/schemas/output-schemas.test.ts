import {
  GRAPHICS_OUTPUT_CONFIG_VERSION,
  GraphicsOutputKeySchema,
  GraphicsFormatSchema,
  GraphicsConfigureOutputsSchema,
} from "./output-schemas.js";

describe("output-schemas", () => {
  describe("GRAPHICS_OUTPUT_CONFIG_VERSION", () => {
    it("is 1", () => {
      expect(GRAPHICS_OUTPUT_CONFIG_VERSION).toBe(1);
    });
  });

  describe("GraphicsOutputKeySchema", () => {
    it("accepts valid output keys", () => {
      expect(GraphicsOutputKeySchema.parse("stub")).toBe("stub");
      expect(GraphicsOutputKeySchema.parse("video_hdmi")).toBe("video_hdmi");
      expect(GraphicsOutputKeySchema.parse("key_fill_sdi")).toBe("key_fill_sdi");
    });

    it("rejects invalid output key", () => {
      expect(() => GraphicsOutputKeySchema.parse("invalid")).toThrow();
    });
  });

  describe("GraphicsFormatSchema", () => {
    it("accepts valid format", () => {
      const result = GraphicsFormatSchema.parse({
        width: 1920,
        height: 1080,
        fps: 30,
      });
      expect(result).toEqual({ width: 1920, height: 1080, fps: 30 });
    });

    it("rejects invalid dimensions", () => {
      expect(() =>
        GraphicsFormatSchema.parse({ width: 0, height: 1080, fps: 30 })
      ).toThrow();
    });
  });

  describe("GraphicsConfigureOutputsSchema", () => {
    it("accepts minimal valid config with defaults", () => {
      const result = GraphicsConfigureOutputsSchema.parse({
        outputKey: "stub",
        targets: {},
        format: { width: 1920, height: 1080, fps: 30 },
      });
      expect(result.version).toBe(GRAPHICS_OUTPUT_CONFIG_VERSION);
      expect(result.range).toBe("legal");
      expect(result.colorspace).toBe("auto");
    });

    it("accepts config with targets", () => {
      const result = GraphicsConfigureOutputsSchema.parse({
        outputKey: "video_hdmi",
        targets: { output1Id: "display-1", output2Id: "decklink-1" },
        format: { width: 1920, height: 1080, fps: 50 },
      });
      expect(result.targets.output1Id).toBe("display-1");
      expect(result.format.fps).toBe(50);
    });

    it("rejects invalid outputKey", () => {
      expect(() =>
        GraphicsConfigureOutputsSchema.parse({
          outputKey: "invalid",
          targets: {},
          format: { width: 1920, height: 1080, fps: 30 },
        })
      ).toThrow();
    });
  });
});
