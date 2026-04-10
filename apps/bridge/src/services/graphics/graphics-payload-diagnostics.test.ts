import {
  summarizeSendPayload,
  summarizeRawPayload,
} from "./graphics-payload-diagnostics.js";

describe("graphics-payload-diagnostics", () => {
  describe("summarizeSendPayload", () => {
    it("returns diagnostic summary for valid send payload", () => {
      const payload = {
        layerId: "layer-1",
        category: "lower_third" as const,
        presetId: "preset-a",
        durationMs: 5000,
        backgroundMode: "opaque" as const,
        layout: "fill" as const,
        zIndex: 1,
        bundle: {
          html: "<div>Hello</div>",
          css: ".x { color: red; }",
          manifest: { name: "LT", version: "1.0", type: "lower_third", render: {} },
          schema: { title: {} },
          defaults: { title: "" },
          assets: [{ assetId: "img-1", mimeType: "image/png", data: "base64..." }],
        },
        values: { title: "Guest" },
      };

      const result = summarizeSendPayload(payload);

      expect(result.layerId).toBe("layer-1");
      expect(result.category).toBe("lower_third");
      expect(result.presetId).toBe("preset-a");
      expect(result.durationMs).toBe(5000);
      expect(result.backgroundMode).toBe("opaque");
      expect(result.layout).toBe("fill");
      expect(result.zIndex).toBe(1);
      expect(result.manifest).toEqual({
        name: "LT",
        version: "1.0",
        type: "lower_third",
        render: {},
      });
      expect(result.htmlLength).toBe(16);
      expect(result.cssLength).toBe(payload.bundle.css.length);
      expect(result.schemaKeys).toEqual(["title"]);
      expect(result.defaultsKeys).toEqual(["title"]);
      expect(result.valuesKeys).toEqual(["title"]);
      expect(result.valuesCount).toBe(1);
      expect(result.assetsCount).toBe(1);
      expect(result.assetIds).toEqual(["img-1"]);
    });

    it("handles minimal payload with null/empty optional fields", () => {
      const payload = {
        layerId: "l1",
        category: "fullscreen" as const,
        backgroundMode: "transparent" as const,
        layout: "fill" as const,
        zIndex: 0,
        bundle: { html: "", css: "" },
      };

      const result = summarizeSendPayload(payload);

      expect(result.presetId).toBeNull();
      expect(result.durationMs).toBeNull();
      expect(result.manifest.name).toBeNull();
      expect(result.manifest.version).toBeNull();
      expect(result.manifest.type).toBeNull();
      expect(result.manifest.render).toBeNull();
      expect(result.htmlLength).toBe(0);
      expect(result.cssLength).toBe(0);
      expect(result.schemaKeys).toEqual([]);
      expect(result.defaultsKeys).toEqual([]);
      expect(result.valuesKeys).toEqual([]);
      expect(result.valuesCount).toBe(0);
      expect(result.assetsCount).toBe(0);
      expect(result.assetIds).toEqual([]);
    });
  });

  describe("summarizeRawPayload", () => {
    it("returns null for non-object payload", () => {
      expect(summarizeRawPayload(null)).toBeNull();
      expect(summarizeRawPayload(undefined)).toBeNull();
      expect(summarizeRawPayload("string")).toBeNull();
      expect(summarizeRawPayload(42)).toBeNull();
    });

    it("returns diagnostic summary for raw object payload", () => {
      const payload = {
        layerId: "raw-1",
        category: "bug",
        presetId: "p1",
        durationMs: 3000,
        backgroundMode: "opaque",
        layout: "fill",
        zIndex: 2,
        bundle: {
          html: "<p>Hi</p>",
          css: "p {}",
          manifest: { name: "Bug", version: "1", type: "bug", render: null },
        },
        values: { text: "Live" },
      };

      const result = summarizeRawPayload(payload);

      expect(result).not.toBeNull();
      expect(result!.layerId).toBe("raw-1");
      expect(result!.category).toBe("bug");
      expect(result!.presetId).toBe("p1");
      expect(result!.durationMs).toBe(3000);
      expect(result!.htmlLength).toBe(payload.bundle.html.length);
      expect(result!.cssLength).toBe(payload.bundle.css.length);
      expect(result!.valuesKeys).toEqual(["text"]);
    });

    it("handles malformed raw payload with missing bundle/values", () => {
      const result = summarizeRawPayload({ layerId: "x" });

      expect(result).not.toBeNull();
      expect(result!.layerId).toBe("x");
      expect(result!.htmlLength).toBe(0);
      expect(result!.cssLength).toBe(0);
      expect(result!.valuesKeys).toEqual([]);
    });
  });
});
