import { buildSingleWindowDocument } from "./electron-renderer-dom-runtime.js";

jest.mock("./animation-css.js", () => ({
  getStandardAnimationCss: () => "/* mock animation css */",
}));

describe("foreign template animation tolerance", () => {
  // AI-generated templates routinely ship their own anim-in/anim-out classes
  // and hand-written keyframes. The runtime must neither strip those classes
  // (which cancelled a running entrance mid-flight - the graphic snapped) nor
  // require [data-animate] to wait for the exit. These are contract tests on
  // the generated script; the behaviour itself runs in Chromium.
  const script = buildSingleWindowDocument(1, null);

  it("strips only the namespaced runtime classes, never foreign anim-*", () => {
    expect(script).toContain('startsWith("bfy-anim-")');
    expect(script).not.toContain('startsWith("anim-")');
    expect(script).toContain('"bfy-anim-ease-out"');
  });

  it("triggers a template-authored anim-out exit convention", () => {
    expect(script).toContain("legacyExitClass");
    expect(script).toContain('classList.add("anim-out")');
    expect(script).toContain('classList.remove("anim-in")');
  });

  it("waits for whatever exit animations actually run, capped at 2s", () => {
    expect(script).toContain("getAnimations({ subtree: true })");
    expect(script).toContain("2000");
    expect(script).toContain("iterations === Infinity");
    // The helper must actually be awaited on the removal path - defining it
    // without calling it would silently restore the hard cut.
    expect(script).toContain("await waitForExitAnimations(rootElement)");
  });
});

describe("buildSingleWindowDocument background", () => {
  /**
   * Read the effective background declaration of the page background layer.
   *
   * @param html Generated document.
   * @returns The CSS value, or null when the rule is missing.
   */
  const backgroundValue = (html: string): string | null => {
    const rule = html.slice(html.indexOf("#graphics-background"));
    const match = rule
      .slice(0, rule.indexOf("}"))
      .match(/background:\s*([^;]+);/);
    return match ? match[1].trim() : null;
  };

  it("bakes the session background into the document", () => {
    // The offscreen window starts painting the moment the page loads, and
    // those first paints go straight to the FrameBus. Applying the background
    // by script afterwards published black frames on an output without alpha -
    // a visible flash before the first graphic.
    expect(backgroundValue(buildSingleWindowDocument(1, "green"))).toBe("#00FF00");
    expect(backgroundValue(buildSingleWindowDocument(1, "white"))).toBe("#FFFFFF");
  });

  it("stays transparent when no background mode is given", () => {
    expect(backgroundValue(buildSingleWindowDocument(1, null))).toBe("transparent");
    expect(backgroundValue(buildSingleWindowDocument(1))).toBe("transparent");
  });
});

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
      expect(doc).toContain("perspective: 1200px");
    });

    it("applies rotation fields in layer transforms", () => {
      const doc = buildSingleWindowDocument();
      expect(doc).toContain("layout?.scaleX");
      expect(doc).toContain("layout?.scaleY");
      expect(doc).toContain("layout?.rotationX");
      expect(doc).toContain("layout?.rotationY");
      expect(doc).toContain("layout?.rotationZ");
      expect(doc).toContain("rotateX(");
      expect(doc).toContain("rotateY(");
      expect(doc).toContain("rotateZ(");
    });
  });
});
