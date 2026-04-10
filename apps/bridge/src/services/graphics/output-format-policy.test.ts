import {
  VIDEO_PIXEL_FORMAT_PRIORITY,
  KEY_FILL_PIXEL_FORMAT_PRIORITY,
  supportsAnyPixelFormat,
} from "./output-format-policy.js";

describe("output-format-policy", () => {
  describe("VIDEO_PIXEL_FORMAT_PRIORITY", () => {
    it("includes 10bit_yuv and 8bit_yuv", () => {
      expect(VIDEO_PIXEL_FORMAT_PRIORITY).toContain("10bit_yuv");
      expect(VIDEO_PIXEL_FORMAT_PRIORITY).toContain("8bit_yuv");
    });
  });

  describe("KEY_FILL_PIXEL_FORMAT_PRIORITY", () => {
    it("includes 8bit_argb", () => {
      expect(KEY_FILL_PIXEL_FORMAT_PRIORITY).toContain("8bit_argb");
    });
  });

  describe("supportsAnyPixelFormat", () => {
    it("returns true when supported list contains a preferred format", () => {
      expect(
        supportsAnyPixelFormat(["8bit_yuv", "8bit_rgb"], VIDEO_PIXEL_FORMAT_PRIORITY)
      ).toBe(true);
    });

    it("returns true when first preferred format is supported", () => {
      expect(
        supportsAnyPixelFormat(["10bit_yuv"], VIDEO_PIXEL_FORMAT_PRIORITY)
      ).toBe(true);
    });

    it("returns false when no preferred format is supported", () => {
      expect(
        supportsAnyPixelFormat(["8bit_rgb", "12bit_yuv"], VIDEO_PIXEL_FORMAT_PRIORITY)
      ).toBe(false);
    });

    it("returns false when supported list is empty", () => {
      expect(
        supportsAnyPixelFormat([], VIDEO_PIXEL_FORMAT_PRIORITY)
      ).toBe(false);
    });
  });
});
