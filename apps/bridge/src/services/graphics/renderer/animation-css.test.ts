import { getStandardAnimationCss } from "./animation-css.js";

describe("animation-css", () => {
  describe("getStandardAnimationCss", () => {
    it("returns non-empty string", () => {
      const css = getStandardAnimationCss();
      expect(typeof css).toBe("string");
      expect(css.length).toBeGreaterThan(0);
    });

    it("includes standard animation classes", () => {
      const css = getStandardAnimationCss();
      expect(css).toContain("anim-ease");
      expect(css).toContain("anim-ease-in");
      expect(css).toContain("anim-ease-out");
      expect(css).toContain("anim-ease-in-out");
      expect(css).toContain("anim-linear");
      expect(css).toContain("anim-slide-up");
      expect(css).toContain("anim-slide-down");
      expect(css).toContain("anim-slide-left");
      expect(css).toContain("anim-slide-right");
    });

    it("includes keyframe definitions", () => {
      const css = getStandardAnimationCss();
      expect(css).toContain("@keyframes fade-enter");
      expect(css).toContain("@keyframes fade-exit");
      expect(css).toContain("@keyframes slide-up-enter");
      expect(css).toContain("@keyframes slide-down-exit");
    });

    it("uses CSS variables for duration", () => {
      const css = getStandardAnimationCss();
      expect(css).toContain("--anim-dur-enter");
      expect(css).toContain("--anim-dur-exit");
    });
  });
});
