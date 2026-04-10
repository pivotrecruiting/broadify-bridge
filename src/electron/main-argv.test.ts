import {
  getArgValue,
  getArgMap,
  resolveRendererEntry,
} from "./main-argv.js";

describe("main-argv", () => {
  describe("getArgValue", () => {
    it("returns value when flag is present and followed by non-flag", () => {
      expect(getArgValue(["a", "--foo", "bar", "b"], "--foo")).toBe("bar");
    });
    it("returns null when flag is missing", () => {
      expect(getArgValue(["a", "b"], "--foo")).toBeNull();
    });
    it("returns null when value is another flag", () => {
      expect(getArgValue(["a", "--foo", "--bar"], "--foo")).toBeNull();
    });
    it("returns null when flag is last", () => {
      expect(getArgValue(["a", "--foo"], "--foo")).toBeNull();
    });
  });

  describe("getArgMap", () => {
    it("parses key=value style", () => {
      const map = getArgMap(["--renderer-entry=/path/entry.js"]);
      expect(map.get("renderer-entry")).toBe("/path/entry.js");
    });
    it("parses separate flag and value", () => {
      const map = getArgMap(["--foo", "bar"]);
      expect(map.get("foo")).toBe("bar");
    });
    it("parses boolean flag without value", () => {
      const map = getArgMap(["--graphics-renderer"]);
      expect(map.get("graphics-renderer")).toBe(true);
    });
    it("skips non-flag args", () => {
      const map = getArgMap(["node", "script.js", "--a", "1"]);
      expect(map.get("a")).toBe("1");
    });
    it("handles multiple flags", () => {
      const map = getArgMap(["--x", "1", "--y", "--z=2"]);
      expect(map.get("x")).toBe("1");
      expect(map.get("y")).toBe(true);
      expect(map.get("z")).toBe("2");
    });
  });

  describe("resolveRendererEntry", () => {
    it("returns explicit renderer-entry from map (key=value)", () => {
      expect(
        resolveRendererEntry(["--renderer-entry=/path/renderer.js"]),
      ).toBe("/path/renderer.js");
    });
    it("returns explicit renderer-entry from separate args", () => {
      expect(
        resolveRendererEntry(["--renderer-entry", "/path/entry.js"]),
      ).toBe("/path/entry.js");
    });
    it("returns path ending with electron-renderer-entry.js when no explicit flag", () => {
      const argv = ["node", "dist/electron-renderer-entry.js"];
      expect(resolveRendererEntry(argv)).toBe("dist/electron-renderer-entry.js");
    });
    it("returns null when no renderer entry in argv", () => {
      expect(resolveRendererEntry(["node", "main.js"])).toBeNull();
    });
    it("returns null for empty renderer-entry string in map", () => {
      expect(resolveRendererEntry(["--renderer-entry="])).toBeNull();
    });
  });
});
