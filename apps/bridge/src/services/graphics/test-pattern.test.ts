import {
  createTestPatternPayload,
  TEST_PATTERN_LAYER_ID,
} from "./test-pattern.js";

describe("test-pattern", () => {
  describe("createTestPatternPayload", () => {
    it("returns valid GraphicsSendPayloadT", () => {
      const payload = createTestPatternPayload();
      expect(payload.layerId).toBe(TEST_PATTERN_LAYER_ID);
      expect(payload.category).toBe("overlays");
      expect(payload.backgroundMode).toBe("transparent");
      expect(payload.layout).toEqual({ x: 0, y: 0, scale: 1 });
      expect(payload.zIndex).toBe(200);
    });

    it("includes bundle with html and css", () => {
      const payload = createTestPatternPayload();
      expect(payload.bundle.html).toContain("test-pattern");
      expect(payload.bundle.css).toContain(".test-pattern");
      expect(payload.bundle.manifest.name).toBe("test-pattern");
    });

    it("returns deterministic payload on multiple calls", () => {
      const a = createTestPatternPayload();
      const b = createTestPatternPayload();
      expect(a).toEqual(b);
    });
  });

  describe("TEST_PATTERN_LAYER_ID", () => {
    it("is test-pattern", () => {
      expect(TEST_PATTERN_LAYER_ID).toBe("test-pattern");
    });
  });
});
