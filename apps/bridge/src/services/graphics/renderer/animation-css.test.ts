import { getStandardAnimationCss } from "./animation-css.js";

describe("getStandardAnimationCss", () => {
  it("returns non-empty CSS string", () => {
    const css = getStandardAnimationCss();
    expect(css.length).toBeGreaterThan(0);
    expect(typeof css).toBe("string");
  });

  it("includes standard animation classes", () => {
    const css = getStandardAnimationCss();
    expect(css).toContain("anim-ease");
    expect(css).toContain("anim-ease-in");
    expect(css).toContain("anim-ease-out");
    expect(css).toContain("anim-linear");
    expect(css).toContain("anim-slide-up");
    expect(css).toContain("anim-slide-down");
    expect(css).toContain("anim-slide-left");
    expect(css).toContain("anim-slide-right");
  });

  it("includes state-enter and state-exit selectors", () => {
    const css = getStandardAnimationCss();
    expect(css).toContain("state-enter");
    expect(css).toContain("state-exit");
  });

  it("includes keyframes for fade and slide", () => {
    const css = getStandardAnimationCss();
    expect(css).toContain("@keyframes fade-enter");
    expect(css).toContain("@keyframes fade-exit");
    expect(css).toContain("@keyframes slide-up-enter");
    expect(css).toContain("@keyframes slide-down-exit");
  });

  it("uses CSS variables for animation duration", () => {
    const css = getStandardAnimationCss();
    expect(css).toContain("--anim-dur-enter");
    expect(css).toContain("--anim-dur-exit");
    expect(css).toContain("--anim-distance");
  });

  it("returns trimmed output without leading/trailing whitespace", () => {
    const css = getStandardAnimationCss();
    expect(css).toBe(css.trim());
  });
});
