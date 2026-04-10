import {
  LOG_LEVELS,
  normalizeLevel,
  clampMaxLevel,
} from "./log-level-utils.js";

describe("log-level-utils", () => {
  describe("LOG_LEVELS", () => {
    it("contains standard pino levels", () => {
      expect(LOG_LEVELS.trace).toBe(10);
      expect(LOG_LEVELS.info).toBe(30);
      expect(LOG_LEVELS.error).toBe(50);
    });
  });

  describe("normalizeLevel", () => {
    it("returns fallback when value is undefined", () => {
      expect(normalizeLevel(undefined, "info")).toBe("info");
    });

    it("returns fallback when value is empty", () => {
      expect(normalizeLevel("", "warn")).toBe("warn");
    });

    it("returns lowercase valid level", () => {
      expect(normalizeLevel("DEBUG", "info")).toBe("debug");
    });

    it("returns fallback for invalid level", () => {
      expect(normalizeLevel("invalid", "info")).toBe("info");
    });
  });

  describe("clampMaxLevel", () => {
    it("returns value when value is less verbose than max (within range)", () => {
      expect(clampMaxLevel("warn", "info")).toBe("warn");
    });

    it("returns maxLevel when value is more verbose than max", () => {
      expect(clampMaxLevel("debug", "info")).toBe("info");
    });

    it("returns value when equal to max", () => {
      expect(clampMaxLevel("info", "info")).toBe("info");
    });
  });
});
