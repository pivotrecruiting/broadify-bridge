import {
  ENGINE_ATEM_OPTIONS,
  ENGINE_PORT_OPTIONS,
} from "./engine-constants.js";

describe("engine-constants", () => {
  describe("ENGINE_ATEM_OPTIONS", () => {
    it("is a non-empty readonly array", () => {
      expect(Array.isArray(ENGINE_ATEM_OPTIONS)).toBe(true);
      expect(ENGINE_ATEM_OPTIONS.length).toBeGreaterThan(0);
    });

    it("contains only ATEM-prefixed IP options", () => {
      ENGINE_ATEM_OPTIONS.forEach((opt) => {
        expect(opt).toMatch(/^ATEM\s/);
        expect(typeof opt).toBe("string");
      });
    });

    it("has expected predefined entries", () => {
      expect(ENGINE_ATEM_OPTIONS).toContain("ATEM 192.168.1.1");
      expect(ENGINE_ATEM_OPTIONS).toContain("ATEM 10.0.0.1");
    });

    it("has no duplicate entries", () => {
      const set = new Set(ENGINE_ATEM_OPTIONS);
      expect(set.size).toBe(ENGINE_ATEM_OPTIONS.length);
    });
  });

  describe("ENGINE_PORT_OPTIONS", () => {
    it("is a non-empty readonly array", () => {
      expect(Array.isArray(ENGINE_PORT_OPTIONS)).toBe(true);
      expect(ENGINE_PORT_OPTIONS.length).toBeGreaterThan(0);
    });

    it("contains only string port numbers", () => {
      ENGINE_PORT_OPTIONS.forEach((port) => {
        expect(typeof port).toBe("string");
        expect(port).toMatch(/^\d+$/);
      });
    });

    it("has expected predefined ports", () => {
      expect(ENGINE_PORT_OPTIONS).toContain("9091");
      expect(ENGINE_PORT_OPTIONS).toContain("8080");
    });

    it("has no duplicate entries", () => {
      const set = new Set(ENGINE_PORT_OPTIONS);
      expect(set.size).toBe(ENGINE_PORT_OPTIONS.length);
    });
  });
});
