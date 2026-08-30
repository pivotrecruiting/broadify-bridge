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
