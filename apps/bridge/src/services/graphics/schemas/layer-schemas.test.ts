import {
  GraphicsLayoutSchema,
  GraphicsAssetSchema,
  GraphicsBundleSchema,
  GraphicsBackgroundModeSchema,
  GraphicsCategorySchema,
  GraphicsSendSchema,
  GraphicsUpdateValuesSchema,
  GraphicsRemoveSchema,
  GraphicsRemovePresetSchema,
} from "./layer-schemas.js";

describe("layer-schemas", () => {
  describe("GraphicsLayoutSchema", () => {
    it("accepts valid layout", () => {
      expect(
        GraphicsLayoutSchema.parse({ x: 0, y: 100, scale: 1.5 })
      ).toEqual({ x: 0, y: 100, scale: 1.5 });
    });

    it("rejects invalid scale", () => {
      expect(() =>
        GraphicsLayoutSchema.parse({ x: 0, y: 0, scale: 0 })
      ).toThrow();
    });
  });

  describe("GraphicsAssetSchema", () => {
    it("accepts valid asset", () => {
      expect(
        GraphicsAssetSchema.parse({
          assetId: "img_1",
          name: "Logo",
          mime: "image/png",
        })
      ).toEqual({ assetId: "img_1", name: "Logo", mime: "image/png" });
    });

    it("rejects invalid assetId format", () => {
      expect(() =>
        GraphicsAssetSchema.parse({
          assetId: "invalid id!",
          name: "x",
          mime: "image/png",
        })
      ).toThrow();
    });
  });

  describe("GraphicsBundleSchema", () => {
    it("accepts minimal bundle with defaults", () => {
      const result = GraphicsBundleSchema.parse({
        manifest: {},
        html: "<div>test</div>",
      });
      expect(result.css).toBe("");
      expect(result.assets).toEqual([]);
    });
  });

  describe("GraphicsBackgroundModeSchema", () => {
    it("accepts valid modes", () => {
      expect(GraphicsBackgroundModeSchema.parse("transparent")).toBe("transparent");
      expect(GraphicsBackgroundModeSchema.parse("green")).toBe("green");
    });
  });

  describe("GraphicsCategorySchema", () => {
    it("accepts valid categories", () => {
      expect(GraphicsCategorySchema.parse("lower-thirds")).toBe("lower-thirds");
      expect(GraphicsCategorySchema.parse("overlays")).toBe("overlays");
    });
  });

  describe("GraphicsSendSchema", () => {
    it("accepts valid send payload", () => {
      const result = GraphicsSendSchema.parse({
        layerId: "layer-1",
        category: "lower-thirds",
        backgroundMode: "green",
        layout: { x: 0, y: 0, scale: 1 },
        zIndex: 1,
        bundle: { manifest: {}, html: "<div/>" },
      });
      expect(result.layerId).toBe("layer-1");
      expect(result.durationMs).toBeUndefined();
    });

    it("rejects durationMs over max", () => {
      expect(() =>
        GraphicsSendSchema.parse({
          layerId: "l1",
          category: "overlays",
          backgroundMode: "black",
          layout: { x: 0, y: 0, scale: 1 },
          zIndex: 0,
          bundle: { manifest: {}, html: "x" },
          durationMs: 60 * 60 * 1000 + 1,
        })
      ).toThrow();
    });
  });

  describe("GraphicsUpdateValuesSchema", () => {
    it("accepts valid update", () => {
      expect(
        GraphicsUpdateValuesSchema.parse({ layerId: "l1", values: { name: "x" } })
      ).toEqual({ layerId: "l1", values: { name: "x" } });
    });
  });

  describe("GraphicsRemoveSchema", () => {
    it("accepts valid remove", () => {
      expect(GraphicsRemoveSchema.parse({ layerId: "l1" })).toEqual({
        layerId: "l1",
      });
    });
  });

  describe("GraphicsRemovePresetSchema", () => {
    it("accepts valid remove preset", () => {
      expect(
        GraphicsRemovePresetSchema.parse({ presetId: "preset-1" })
      ).toEqual({ presetId: "preset-1" });
    });
  });
});
