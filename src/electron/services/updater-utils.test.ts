import {
  sanitizeUpdaterErrorMessage,
  parseIntervalMs,
} from "./updater-utils.js";

describe("updater-utils", () => {
  describe("sanitizeUpdaterErrorMessage", () => {
    it("redacts bearer tokens", () => {
      expect(
        sanitizeUpdaterErrorMessage("Bearer abc123xyz")
      ).toBe("Bearer [REDACTED]");
    });

    it("redacts authorization headers", () => {
      expect(
        sanitizeUpdaterErrorMessage("Authorization: token secret_key_123")
      ).toBe("Authorization: token [REDACTED]");
    });

    it("redacts GitHub tokens", () => {
      expect(
        sanitizeUpdaterErrorMessage("Error: ghp_abc123def456")
      ).toBe("Error: [REDACTED_GITHUB_TOKEN]");
    });

    it("leaves non-secret messages unchanged", () => {
      expect(sanitizeUpdaterErrorMessage("Network error")).toBe("Network error");
    });
  });

  describe("parseIntervalMs", () => {
    it("returns fallback when value is undefined", () => {
      expect(parseIntervalMs(undefined, 3600000)).toBe(3600000);
    });

    it("returns fallback when value is empty string", () => {
      expect(parseIntervalMs("", 3600000)).toBe(3600000);
    });

    it("parses valid integer", () => {
      expect(parseIntervalMs("60000", 3600000)).toBe(60000);
    });

    it("returns fallback for invalid number", () => {
      expect(parseIntervalMs("abc", 3600000)).toBe(3600000);
    });

    it("returns fallback for zero", () => {
      expect(parseIntervalMs("0", 3600000)).toBe(3600000);
    });

    it("returns fallback for negative", () => {
      expect(parseIntervalMs("-100", 3600000)).toBe(3600000);
    });
  });
});
