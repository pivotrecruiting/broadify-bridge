import { cn } from "./utils.js";

describe("cn", () => {
  it("returns empty string for no arguments", () => {
    expect(cn()).toBe("");
  });

  it("merges single string", () => {
    expect(cn("foo")).toBe("foo");
  });

  it("merges multiple strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("filters out falsy values", () => {
    expect(cn("a", undefined, null, false, "b")).toBe("a b");
  });

  it("handles conditional classes", () => {
    const active = true;
    expect(cn("base", active && "active")).toBe("base active");
    const inactive = false;
    expect(cn("base", inactive && "active")).toBe("base");
  });

  it("merges tailwind classes and resolves conflicts (twMerge)", () => {
    expect(cn("p-4", "p-2")).toBe("p-2");
  });

  it("handles array of class values", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("handles object form", () => {
    expect(cn({ foo: true, bar: false })).toBe("foo");
  });
});
