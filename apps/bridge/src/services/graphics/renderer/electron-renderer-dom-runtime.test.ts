import { buildSingleWindowDocument } from "./electron-renderer-dom-runtime.js";

jest.mock("./animation-css.js", () => ({
  getStandardAnimationCss: () => "/* mock animation css */",
}));

describe("electron-renderer-dom-runtime", () => {
  describe("buildSingleWindowDocument", () => {
    it("returns a string", () => {
      const doc = buildSingleWindowDocument();
      expect(typeof doc).toBe("string");
    });

    it("returns valid HTML with DOCTYPE and root structure", () => {
      const doc = buildSingleWindowDocument();
      expect(doc).toContain("<!DOCTYPE html>");
      expect(doc).toContain("<html>");
      expect(doc).toContain("<head>");
      expect(doc).toContain("<body>");
      expect(doc).toContain('id="graphics-background"');
      expect(doc).toContain('id="graphics-root"');
    });

    it("embeds BASE_WIDTH 1920 and BASE_HEIGHT 1080 in script", () => {
      const doc = buildSingleWindowDocument();
      expect(doc).toContain("BASE_WIDTH = 1920");
      expect(doc).toContain("BASE_HEIGHT = 1080");
    });

    it("embeds STANDARD_CSS from animation module", () => {
      const doc = buildSingleWindowDocument();
      expect(doc).toContain('STANDARD_CSS = "/* mock animation css */"');
    });

    it("exposes renderer API globals in script", () => {
      const doc = buildSingleWindowDocument();
      expect(doc).toContain("window.__setBackground");
      expect(doc).toContain("window.__setClearColor");
      expect(doc).toContain("window.__createLayer");
      expect(doc).toContain("window.__updateValues");
      expect(doc).toContain("window.__updateLayout");
      expect(doc).toContain("window.__removeLayer");
    });

    it("includes styles for graphics-background and graphics-root", () => {
      const doc = buildSingleWindowDocument();
      expect(doc).toContain("#graphics-background");
      expect(doc).toContain("#graphics-root");
    });
  });
});
