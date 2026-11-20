/**
 * @jest-environment jsdom
 */
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

  it("emits the .anim-out detection regex intact (no backspace escape)", () => {
    // The runtime script is emitted from a template literal: a single \b there
    // becomes a literal backspace character in the generated source, so the
    // regex never matches and the exit convention silently stops firing.
    expect(script).not.toContain("\u0008");
    expect(script).toContain("/\\.anim-out\\b/");
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

describe("layer box", () => {
  type LayerPayloadT = {
    layerId: string;
    html: string;
    css: string;
    layout: Record<string, number>;
    zIndex?: number;
    canvas?: unknown;
  };
  type RuntimeWindowT = {
    __createLayer: (payload: LayerPayloadT) => void;
    __updateLayout: (
      layerId: string,
      layout: Record<string, number>,
      zIndex?: number | null,
    ) => void;
  };

  // The layer content lives in a closed shadow root; the spy keeps a handle.
  const shadowRoots = new Map<Element, ShadowRoot>();
  const nativeAttachShadow = Element.prototype.attachShadow;

  /** Loads the generated document into jsdom and returns its page API. */
  const loadRuntime = (renderScale = 1): RuntimeWindowT => {
    const html = buildSingleWindowDocument(renderScale, null);
    const scriptStart = html.indexOf("<script>");
    document.body.innerHTML = html.slice(
      html.indexOf("<body>") + "<body>".length,
      scriptStart,
    );
    new Function(
      html.slice(scriptStart + "<script>".length, html.lastIndexOf("</script>")),
    )();
    return window as unknown as RuntimeWindowT;
  };

  const layer = (overrides: Partial<LayerPayloadT> = {}): LayerPayloadT => ({
    layerId: "layer-1",
    html: '<div data-root="graphic">Title</div>',
    css: "",
    layout: { x: 0, y: 0, scale: 1 },
    zIndex: 1,
    ...overrides,
  });

  const hostOf = (layerId = "layer-1"): HTMLElement =>
    document.querySelector(`[data-layer-id="${layerId}"]`) as HTMLElement;

  const graphicRootOf = (host: HTMLElement): HTMLElement =>
    shadowRoots.get(host)?.querySelector("#graphic-root") as HTMLElement;

  const boxOf = (host: HTMLElement) => ({
    host: [host.style.width, host.style.height],
    graphicRoot: [
      graphicRootOf(host).style.width,
      graphicRootOf(host).style.height,
    ],
  });

  beforeEach(() => {
    shadowRoots.clear();
    jest
      .spyOn(Element.prototype, "attachShadow")
      .mockImplementation(function (this: Element, init: ShadowRootInit) {
        const root = nativeAttachShadow.call(this, init);
        shadowRoots.set(this, root);
        return root;
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("is the 1920x1080 baseline for a layer without a canvas, as before", () => {
    const runtime = loadRuntime();

    runtime.__createLayer(layer({ layout: { x: 0, y: 656.25, scale: 0.5625 } }));

    const host = hostOf();
    expect(boxOf(host)).toEqual({
      host: ["1920px", "1080px"],
      graphicRoot: ["1920px", "1080px"],
    });
    expect(host.style.transformOrigin).toBe("top left");
    expect(host.style.transform).toBe(
      "translate3d(0px, 656.25px, 0) scale(0.5625, 0.5625) " +
        "rotateX(0deg) rotateY(0deg) rotateZ(0deg) translateZ(0)",
    );
  });

  it("leaves the DOM of a layer without a canvas exactly as an explicit 1920x1080", () => {
    const runtime = loadRuntime();

    runtime.__createLayer(layer({ layerId: "absent" }));
    runtime.__createLayer(
      layer({ layerId: "explicit", canvas: { width: 1920, height: 1080 } }),
    );

    const absent = hostOf("absent");
    const explicit = hostOf("explicit");
    expect(absent.getAttribute("style")).toBe(explicit.getAttribute("style"));
    expect(graphicRootOf(absent).outerHTML).toBe(graphicRootOf(explicit).outerHTML);
  });

  it("takes the size of the canvas sent with the layer: host and #graphic-root", () => {
    const runtime = loadRuntime();

    runtime.__createLayer(layer({ canvas: { width: 1080, height: 1920 } }));

    expect(boxOf(hostOf())).toEqual({
      host: ["1080px", "1920px"],
      graphicRoot: ["1080px", "1920px"],
    });
  });

  it("leaves the layout transform alone: the canvas only sizes the box", () => {
    const runtime = loadRuntime();
    const layout = { x: 108, y: 192, scale: 1, scaleX: 0.4, scaleY: 0.4 };

    runtime.__createLayer(layer({ layerId: "baseline", layout }));
    runtime.__createLayer(
      layer({ layerId: "portrait", layout, canvas: { width: 1080, height: 1920 } }),
    );

    expect(hostOf("portrait").style.transform).toBe(
      hostOf("baseline").style.transform,
    );
    expect(hostOf("portrait").style.transform).toBe(
      "translate3d(108px, 192px, 0) scale(0.4, 0.4) " +
        "rotateX(0deg) rotateY(0deg) rotateZ(0deg) translateZ(0)",
    );
  });

  it("does not multiply the box by the render scale; the transform carries it", () => {
    // Supersampling (meeting planes render at 2x): the window is twice the
    // plane, the box stays in plane pixels and the transform scales it - the
    // same way the 1920x1080 baseline has always been treated.
    const runtime = loadRuntime(2);
    const layout = { x: 108, y: 192, scale: 1, scaleX: 0.4, scaleY: 0.4 };

    runtime.__createLayer(layer({ layerId: "baseline", layout }));
    runtime.__createLayer(
      layer({ layerId: "portrait", layout, canvas: { width: 1080, height: 1920 } }),
    );

    expect(boxOf(hostOf("baseline")).host).toEqual(["1920px", "1080px"]);
    expect(boxOf(hostOf("portrait"))).toEqual({
      host: ["1080px", "1920px"],
      graphicRoot: ["1080px", "1920px"],
    });
    expect(hostOf("portrait").style.transform).toBe(
      "translate3d(216px, 384px, 0) scale(0.8, 0.8) " +
        "rotateX(0deg) rotateY(0deg) rotateZ(0deg) translateZ(0)",
    );
  });

  it("resizes the box when the same layerId is sent again with another canvas", () => {
    const runtime = loadRuntime();

    runtime.__createLayer(layer({ canvas: { width: 1080, height: 1920 } }));
    const host = hostOf();
    runtime.__createLayer(layer({ canvas: { width: 720, height: 1280 } }));

    expect(document.querySelectorAll('[data-layer-id="layer-1"]')).toHaveLength(1);
    expect(hostOf()).toBe(host);
    expect(boxOf(host)).toEqual({
      host: ["720px", "1280px"],
      graphicRoot: ["720px", "1280px"],
    });
  });

  it("returns to the baseline when the same layerId is sent again without a canvas", () => {
    const runtime = loadRuntime();

    runtime.__createLayer(layer({ canvas: { width: 1080, height: 1920 } }));
    runtime.__createLayer(layer());

    expect(boxOf(hostOf())).toEqual({
      host: ["1920px", "1080px"],
      graphicRoot: ["1920px", "1080px"],
    });
  });

  it("keeps the box on a layout update", () => {
    const runtime = loadRuntime();

    runtime.__createLayer(layer({ canvas: { width: 1080, height: 1920 } }));
    runtime.__updateLayout("layer-1", { x: 120, y: 780, scale: 1 }, null);

    const host = hostOf();
    expect(boxOf(host)).toEqual({
      host: ["1080px", "1920px"],
      graphicRoot: ["1080px", "1920px"],
    });
    expect(host.style.transform).toContain("translate3d(120px, 780px, 0)");
  });

  it("falls back to the baseline for a canvas it cannot use", () => {
    const runtime = loadRuntime();

    runtime.__createLayer(layer({ canvas: { width: 0, height: 1920 } }));

    expect(boxOf(hostOf())).toEqual({
      host: ["1920px", "1080px"],
      graphicRoot: ["1920px", "1080px"],
    });
  });
});
