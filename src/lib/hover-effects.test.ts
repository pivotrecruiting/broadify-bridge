import { hoverEffects, type HoverEffect } from "./hover-effects.js";

describe("hoverEffects", () => {
  it("has default variant none with base transition classes", () => {
    const result = hoverEffects();
    expect(result).toContain("transition-all");
    expect(result).toContain("duration-300");
  });

  it("returns glow variant classes", () => {
    const result = hoverEffects({ hover: "glow" });
    expect(result).toContain("shadow-lg");
    expect(result).toContain("shadow-purple-500");
    expect(result).toContain("hover:shadow-xl");
  });

  it("returns shimmer variant with overflow and pseudo classes", () => {
    const result = hoverEffects({ hover: "shimmer" });
    expect(result).toContain("overflow-hidden");
    expect(result).toContain("before:absolute");
    expect(result).toContain("before:bg-gradient-to-r");
  });

  it("returns ripple variant with after pseudo and scale", () => {
    const result = hoverEffects({ hover: "ripple" });
    expect(result).toContain("after:absolute");
    expect(result).toContain("after:scale-0");
    expect(result).toContain("hover:after:scale-150");
  });

  it("returns lift variant with translate and shadow", () => {
    const result = hoverEffects({ hover: "lift" });
    expect(result).toContain("hover:-translate-y-1");
    expect(result).toContain("hover:shadow-lg");
  });

  it("returns scale variant with scale transform", () => {
    const result = hoverEffects({ hover: "scale" });
    expect(result).toContain("hover:scale-105");
  });

  it("returns only base classes for none variant", () => {
    const result = hoverEffects({ hover: "none" });
    expect(result).toBe("transition-all duration-300");
  });
});

describe("HoverEffect type", () => {
  const validEffects: HoverEffect[] = [
    "none",
    "glow",
    "shimmer",
    "ripple",
    "lift",
    "scale",
  ];

  it("accepts all documented hover effect values", () => {
    validEffects.forEach((effect) => {
      const result = hoverEffects({ hover: effect });
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
