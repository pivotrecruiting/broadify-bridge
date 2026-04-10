import {
  OUTPUT1_OPTIONS,
  OUTPUT2_OPTIONS,
} from "./output-constants.js";

describe("output-constants", () => {
  describe("OUTPUT1_OPTIONS", () => {
    it("is a non-empty readonly array", () => {
      expect(Array.isArray(OUTPUT1_OPTIONS)).toBe(true);
      expect(OUTPUT1_OPTIONS.length).toBeGreaterThan(0);
    });

    it("contains capture device options", () => {
      expect(OUTPUT1_OPTIONS).toContain("USB Capture");
    });

    it("has no duplicate entries", () => {
      const set = new Set(OUTPUT1_OPTIONS);
      expect(set.size).toBe(OUTPUT1_OPTIONS.length);
    });

    it("contains only strings", () => {
      OUTPUT1_OPTIONS.forEach((opt) => {
        expect(typeof opt).toBe("string");
      });
    });
  });

  describe("OUTPUT2_OPTIONS", () => {
    it("is a non-empty readonly array", () => {
      expect(Array.isArray(OUTPUT2_OPTIONS)).toBe(true);
      expect(OUTPUT2_OPTIONS.length).toBeGreaterThan(0);
    });

    it("contains connection type options", () => {
      const expected = ["SDI", "HDMI", "USB", "DisplayPort", "Thunderbolt"];
      expected.forEach((opt) => {
        expect(OUTPUT2_OPTIONS).toContain(opt);
      });
    });

    it("has exactly five options", () => {
      expect(OUTPUT2_OPTIONS).toHaveLength(5);
    });

    it("has no duplicate entries", () => {
      const set = new Set(OUTPUT2_OPTIONS);
      expect(set.size).toBe(OUTPUT2_OPTIONS.length);
    });

    it("contains only strings", () => {
      OUTPUT2_OPTIONS.forEach((opt) => {
        expect(typeof opt).toBe("string");
      });
    });
  });
});
