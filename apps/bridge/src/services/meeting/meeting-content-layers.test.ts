import {
  buildBrowserSourceLayerHtml,
  buildVideoLayerHtml,
  validateBrowserSourceUrl,
} from "./meeting-content-layers.js";

describe("meeting-content-layers", () => {
  const pip = {
    mode: "pip" as const,
    x: 0.5,
    y: 0.25,
    width: 0.25,
    height: 0.25,
    rotation: 10,
  };

  describe("buildVideoLayerHtml", () => {
    it("builds a pip video layer with pixel geometry and playback attributes", () => {
      const html = buildVideoLayerHtml(
        "http://127.0.0.1:8787/meeting/media/assets/a-1/video",
        pip,
        { muted: false, loop: true },
      );
      expect(html).toContain('src="http://127.0.0.1:8787/meeting/media/assets/a-1/video"');
      expect(html).toContain("left:960px");
      expect(html).toContain("top:270px");
      expect(html).toContain("width:480px");
      expect(html).toContain("height:270px");
      expect(html).toContain("rotate(10deg)");
      expect(html).toContain("autoplay");
      expect(html).toContain("loop");
      expect(html).not.toContain("muted");
    });

    it("fills the full stage in fullscreen mode and honors muted", () => {
      const html = buildVideoLayerHtml(
        "http://127.0.0.1:8787/v",
        { ...pip, mode: "fullscreen" },
        { muted: true, loop: false },
      );
      expect(html).toContain("width:1920px");
      expect(html).toContain("height:1080px");
      expect(html).toContain("muted");
      expect(html).not.toContain("loop");
    });

    it("applies the news-style 3D tilt (rotationY) with perspective", () => {
      const html = buildVideoLayerHtml(
        "http://127.0.0.1:8787/v",
        { ...pip, rotationY: 28, rotationX: 0 },
        { muted: false, loop: true },
      );
      expect(html).toContain("perspective(1200px)");
      expect(html).toContain("rotateY(28deg)");
    });

    it("escapes attribute-breaking characters in the URL", () => {
      const html = buildVideoLayerHtml('http://127.0.0.1/x?"<>', pip, {
        muted: false,
        loop: true,
      });
      expect(html).not.toContain('?"<>');
      expect(html).toContain("&quot;&lt;&gt;");
    });
  });

  describe("buildBrowserSourceLayerHtml", () => {
    it("builds an iframe layer with escaped URL", () => {
      const html = buildBrowserSourceLayerHtml(
        'https://example.com/page?a=1&b="x"',
        pip,
      );
      expect(html).toContain("<iframe");
      expect(html).toContain("https://example.com/page?a=1&amp;b=&quot;x&quot;");
      expect(html).toContain("border:0");
    });
  });

  describe("validateBrowserSourceUrl", () => {
    it("accepts plain HTTPS URLs", () => {
      expect(validateBrowserSourceUrl("https://example.com/scoreboard")).toBe(
        "https://example.com/scoreboard",
      );
    });

    it("rejects non-HTTPS protocols", () => {
      expect(() => validateBrowserSourceUrl("http://example.com")).toThrow(
        /HTTPS/,
      );
      expect(() => validateBrowserSourceUrl("javascript:alert(1)")).toThrow(
        /HTTPS/,
      );
      expect(() => validateBrowserSourceUrl("file:///etc/passwd")).toThrow(
        /HTTPS/,
      );
    });

    it("rejects embedded credentials and garbage", () => {
      expect(() =>
        validateBrowserSourceUrl("https://user:pass@example.com"),
      ).toThrow(/credentials/);
      expect(() => validateBrowserSourceUrl("not a url")).toThrow(/valid URL/);
    });
  });
});
