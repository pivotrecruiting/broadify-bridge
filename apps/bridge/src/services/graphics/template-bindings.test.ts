import {
  getAnimationClassFromValue,
  deriveTemplateBindings,
  type TemplateBindingsT,
} from "./template-bindings.js";

describe("getAnimationClassFromValue", () => {
  it("returns anim-{value} for valid animation values", () => {
    expect(getAnimationClassFromValue("ease")).toBe("anim-ease");
    expect(getAnimationClassFromValue("ease-in")).toBe("anim-ease-in");
    expect(getAnimationClassFromValue("ease-out")).toBe("anim-ease-out");
    expect(getAnimationClassFromValue("linear")).toBe("anim-linear");
    expect(getAnimationClassFromValue("slide-up")).toBe("anim-slide-up");
    expect(getAnimationClassFromValue("slide-down")).toBe("anim-slide-down");
    expect(getAnimationClassFromValue("slide-left")).toBe("anim-slide-left");
    expect(getAnimationClassFromValue("slide-right")).toBe("anim-slide-right");
  });

  it("normalizes to lowercase", () => {
    expect(getAnimationClassFromValue("EASE-OUT")).toBe("anim-ease-out");
  });

  it("returns anim-ease-out for invalid values", () => {
    expect(getAnimationClassFromValue("invalid")).toBe("anim-ease-out");
    expect(getAnimationClassFromValue("")).toBe("anim-ease-out");
  });

  it("returns anim-ease-out for null/undefined", () => {
    expect(getAnimationClassFromValue(null)).toBe("anim-ease-out");
    expect(getAnimationClassFromValue(undefined)).toBe("anim-ease-out");
  });
});

describe("deriveTemplateBindings", () => {
  it("returns empty bindings for empty schema and values", () => {
    const result = deriveTemplateBindings(
      { schema: {}, defaults: {} },
      {}
    );
    expect(result).toEqual({
      cssVariables: {},
      textContent: {},
      textTypes: {},
      animationClass: "anim-ease-out",
    });
  });

  it("derives number type as css variable with unit", () => {
    const result = deriveTemplateBindings(
      {
        schema: { opacity: { type: "number", unit: "%" } },
        defaults: { opacity: 80 },
      },
      {}
    );
    expect(result.cssVariables["--opacity"]).toBe("80%");
  });

  it("derives number type without unit", () => {
    const result = deriveTemplateBindings(
      {
        schema: { scale: { type: "number" } },
        defaults: { scale: 1.5 },
      },
      {}
    );
    expect(result.cssVariables["--scale"]).toBe("1.5");
  });

  it("uses runtime values over defaults", () => {
    const result = deriveTemplateBindings(
      {
        schema: { opacity: { type: "number", unit: "%" } },
        defaults: { opacity: 50 },
      },
      { opacity: 90 }
    );
    expect(result.cssVariables["--opacity"]).toBe("90%");
  });

  it("derives string with contentType as textContent", () => {
    const result = deriveTemplateBindings(
      {
        schema: { title: { type: "string", contentType: "text" } },
        defaults: { title: "Default" },
      },
      {}
    );
    expect(result.textContent.title).toBe("Default");
    expect(result.textTypes.title).toBe("text");
  });

  it("skips entries without type", () => {
    const result = deriveTemplateBindings(
      {
        schema: { foo: { unit: "px" } },
        defaults: {},
      },
      {}
    );
    expect(result.cssVariables["--foo"]).toBeUndefined();
  });

  it("skips null/undefined values", () => {
    const result = deriveTemplateBindings(
      {
        schema: { opacity: { type: "number" } },
        defaults: {},
      },
      {}
    );
    expect(result.cssVariables["--opacity"]).toBeUndefined();
  });

  it("derives animation class from schema and values", () => {
    const result = deriveTemplateBindings(
      {
        schema: { animation: { type: "string" } },
        defaults: { animation: "slide-up" },
      },
      {}
    );
    expect(result.animationClass).toBe("anim-slide-up");
  });

  it("uses values.animation over defaults.animation", () => {
    const result = deriveTemplateBindings(
      {
        schema: { animation: { type: "string" } },
        defaults: { animation: "ease" },
      },
      { animation: "slide-down" }
    );
    expect(result.animationClass).toBe("anim-slide-down");
  });
});
