/**
 * @jest-environment jsdom
 */
import { buildBrowserInputPageHtml } from "./browser-input-page.js";

describe("browser input page animation tolerance", () => {
  // The browser-input page carries its own COPY of the renderer's animation
  // state logic. These contracts pin that both copies stay in lockstep: only
  // the namespaced runtime classes are stripped, a template-authored
  // anim-in/anim-out convention is triggered on exit, and the exit wait is
  // convention-independent.
  const html = buildBrowserInputPageHtml();

  it("strips only the namespaced runtime classes, never foreign anim-*", () => {
    expect(html).toContain('startsWith("bfy-anim-")');
    expect(html).not.toContain('startsWith("anim-")');
    expect(html).toContain('"bfy-anim-ease-out"');
  });

  it("triggers a template-authored anim-out exit convention", () => {
    expect(html).toContain("legacyExitClass");
    expect(html).toContain('classList.add("anim-out")');
  });

  it("emits the .anim-out detection regex intact (no backspace escape)", () => {
    // The page script is emitted from a template literal: a single \b there
    // becomes a literal backspace character in the generated source, so the
    // regex never matches and the exit convention silently stops firing.
    expect(html).not.toContain("\u0008");
    expect(html).toContain("/\\.anim-out\\b/");
  });

  it("waits for whatever exit animations actually run, capped at 2s", () => {
    expect(html).toContain("getAnimations({ subtree: true })");
    expect(html).toContain("2000");
    expect(html).toContain("iterations === Infinity");
    // The helper must actually be awaited on the removal path - defining it
    // without calling it would silently restore the hard cut.
    expect(html).toContain("await waitForExitAnimations(rootElement)");
  });
});

type LayerT = {
  layerId: string;
  html: string;
  css: string;
  layout: Record<string, number>;
  zIndex: number;
  canvas?: unknown;
};

/** Stand-in for the page's WebSocket: keeps the listeners for the test. */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readonly listeners = new Map<string, (event: { data: string }) => unknown>();

  constructor() {
    FakeWebSocket.last = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => unknown): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    return;
  }
}

describe("browser input page: layer box", () => {
  const pageGlobals = window as unknown as {
    fetch: unknown;
    WebSocket: unknown;
  };
  const originalFetch = pageGlobals.fetch;
  const originalWebSocket = pageGlobals.WebSocket;

  const layer = (overrides: Partial<LayerT> = {}): LayerT => ({
    layerId: "layer-1",
    html: '<div data-root="graphic">Title</div>',
    css: "",
    layout: { x: 0, y: 0, scale: 1 },
    zIndex: 1,
    ...overrides,
  });

  /**
   * Loads the generated page into jsdom. The page pulls its first snapshot
   * over HTTP and then opens a WebSocket for the following ones.
   */
  const loadPage = async (layers: LayerT[]): Promise<void> => {
    const html = buildBrowserInputPageHtml();
    const scriptStart = html.indexOf("<script>");
    document.body.innerHTML = html.slice(
      html.indexOf("<body>") + "<body>".length,
      scriptStart,
    );
    pageGlobals.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ layers }),
    }));
    pageGlobals.WebSocket = FakeWebSocket;
    new Function(
      html.slice(scriptStart + "<script>".length, html.lastIndexOf("</script>")),
    )();
    // Snapshot fetch -> json -> apply -> WebSocket connect.
    for (let turn = 0; turn < 5 && !FakeWebSocket.last; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const pushSnapshot = async (layers: LayerT[]): Promise<void> => {
    await FakeWebSocket.last?.listeners.get("message")?.({
      data: JSON.stringify({ type: "browser_input.snapshot", snapshot: { layers } }),
    });
  };

  const hostOf = (layerId = "layer-1"): HTMLElement =>
    document.querySelector(`[data-layer-id="${layerId}"]`) as HTMLElement;

  const graphicRootOf = (host: HTMLElement): HTMLElement =>
    host.shadowRoot?.querySelector("#graphic-root") as HTMLElement;

  const boxOf = (host: HTMLElement) => ({
    host: [host.style.width, host.style.height],
    graphicRoot: [
      graphicRootOf(host).style.width,
      graphicRootOf(host).style.height,
    ],
  });

  beforeEach(() => {
    FakeWebSocket.last = null;
  });

  afterEach(() => {
    pageGlobals.fetch = originalFetch;
    pageGlobals.WebSocket = originalWebSocket;
    document.body.innerHTML = "";
  });

  it("is the 1920x1080 baseline for a layer without a canvas, as before", async () => {
    await loadPage([layer({ layout: { x: 120, y: 780, scale: 1 } })]);

    const host = hostOf();
    expect(boxOf(host)).toEqual({
      host: ["1920px", "1080px"],
      graphicRoot: ["1920px", "1080px"],
    });
    expect(host.style.transformOrigin).toBe("top left");
    expect(host.style.transform).toBe(
      "translate3d(120px, 780px, 0) scale(1, 1) " +
        "rotateX(0deg) rotateY(0deg) rotateZ(0deg) translateZ(0)",
    );
  });

  it("leaves the DOM of a layer without a canvas exactly as an explicit 1920x1080", async () => {
    await loadPage([
      layer({ layerId: "absent" }),
      layer({ layerId: "explicit", canvas: { width: 1920, height: 1080 } }),
    ]);

    const absent = hostOf("absent");
    const explicit = hostOf("explicit");
    expect(absent.getAttribute("style")).toBe(explicit.getAttribute("style"));
    expect(graphicRootOf(absent).outerHTML).toBe(graphicRootOf(explicit).outerHTML);
  });

  it("takes the size of the canvas sent with the layer, like the offscreen renderer", async () => {
    await loadPage([layer({ canvas: { width: 1080, height: 1920 } })]);

    expect(boxOf(hostOf())).toEqual({
      host: ["1080px", "1920px"],
      graphicRoot: ["1080px", "1920px"],
    });
  });

  it("resizes the box when a later snapshot carries another canvas, or none", async () => {
    await loadPage([layer({ canvas: { width: 1080, height: 1920 } })]);
    const host = hostOf();

    await pushSnapshot([layer({ canvas: { width: 720, height: 1280 } })]);
    expect(hostOf()).toBe(host);
    expect(boxOf(host)).toEqual({
      host: ["720px", "1280px"],
      graphicRoot: ["720px", "1280px"],
    });

    await pushSnapshot([layer()]);
    expect(boxOf(hostOf())).toEqual({
      host: ["1920px", "1080px"],
      graphicRoot: ["1920px", "1080px"],
    });
  });
});
