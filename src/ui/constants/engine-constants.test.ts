import {
  ENGINE_DEFAULT_PORTS,
  ENGINE_IP_PLACEHOLDERS,
  ENGINE_PORT_OPTIONS,
  ENGINE_TYPE_OPTIONS,
} from "./engine-constants.js";

describe("engine-constants", () => {
  describe("ENGINE_TYPE_OPTIONS", () => {
    it("is a non-empty readonly array", () => {
      expect(Array.isArray(ENGINE_TYPE_OPTIONS)).toBe(true);
      expect(ENGINE_TYPE_OPTIONS.length).toBeGreaterThan(0);
    });

    it("contains the supported desktop engine types", () => {
      expect(ENGINE_TYPE_OPTIONS).toEqual([
        { value: "atem", label: "ATEM" },
        { value: "vmix", label: "vMix" },
      ]);
    });

    it("has no duplicate type values", () => {
      const values = ENGINE_TYPE_OPTIONS.map((option) => option.value);
      expect(new Set(values).size).toBe(values.length);
    });
  });

  describe("ENGINE_DEFAULT_PORTS", () => {
    it("maps atem and vmix to their default control ports", () => {
      expect(ENGINE_DEFAULT_PORTS.atem).toBe("9910");
      expect(ENGINE_DEFAULT_PORTS.vmix).toBe("8088");
    });
  });

  describe("ENGINE_IP_PLACEHOLDERS", () => {
    it("provides stable placeholders for supported engine types", () => {
      expect(ENGINE_IP_PLACEHOLDERS.atem).toBe("192.168.1.1");
      expect(ENGINE_IP_PLACEHOLDERS.vmix).toBe("127.0.0.1");
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

    it("has expected predefined entries", () => {
      expect(ENGINE_PORT_OPTIONS).toContain("8088");
      expect(ENGINE_PORT_OPTIONS).toContain("9910");
    });

    it("has no duplicate entries", () => {
      const set = new Set(ENGINE_PORT_OPTIONS);
      expect(set.size).toBe(ENGINE_PORT_OPTIONS.length);
    });
  });
});
