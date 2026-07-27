import { bgraToRgba, downsampleRgbaBox, resampleRgbaBilinear } from "./graphics-pixel-utils.js";

describe("graphics-pixel-utils", () => {
  describe("bgraToRgba", () => {
    it("swaps R and B channels in-place", () => {
      // BGRA: B=0, G=1, R=2, A=3
      const buffer = Buffer.from([100, 150, 200, 255, 10, 20, 30, 40]);
      const result = bgraToRgba(buffer);
      expect(result).toBe(buffer);
      // First pixel: was B=100, G=150, R=200 -> becomes R=200, G=150, B=100
      expect(buffer[0]).toBe(200);
      expect(buffer[1]).toBe(150);
      expect(buffer[2]).toBe(100);
      expect(buffer[3]).toBe(255);
      // Second pixel: was B=10, G=20, R=30 -> becomes R=30, G=20, B=10
      expect(buffer[4]).toBe(30);
      expect(buffer[5]).toBe(20);
      expect(buffer[6]).toBe(10);
      expect(buffer[7]).toBe(40);
    });

    it("handles empty buffer", () => {
      const buffer = Buffer.alloc(0);
      const result = bgraToRgba(buffer);
      expect(result).toBe(buffer);
      expect(buffer.length).toBe(0);
    });

    it("handles single pixel", () => {
      const buffer = Buffer.from([255, 0, 0, 128]); // B=255, G=0, R=0
      bgraToRgba(buffer);
      expect(buffer[0]).toBe(0); // R
      expect(buffer[1]).toBe(0); // G
      expect(buffer[2]).toBe(255); // B
      expect(buffer[3]).toBe(128); // A
    });
  });

  describe("downsampleRgbaBox", () => {
    it("averages an integer source block into one target pixel", () => {
      const source = Buffer.from([
        0, 0, 0, 255,
        20, 40, 60, 255,
        40, 80, 120, 255,
        60, 120, 180, 255,
      ]);

      expect(downsampleRgbaBox(source, 2, 2, 1, 1)).toEqual(
        Buffer.from([30, 60, 90, 255])
      );
    });

    it("returns the original buffer when dimensions match", () => {
      const source = Buffer.from([1, 2, 3, 4]);

      expect(downsampleRgbaBox(source, 1, 1, 1, 1)).toBe(source);
    });

    it("rejects non-integer scale factors", () => {
      expect(() =>
        downsampleRgbaBox(Buffer.alloc(3 * 2 * 4), 3, 2, 2, 1)
      ).toThrow("positive integer scale factors");
    });
  });
});

describe("resampleRgbaBilinear", () => {
  it("resamples the Windows work-area capture (1920x1032) to 1080p with visible pixels", () => {
    const sourceWidth = 1920;
    const sourceHeight = 1032;
    const source = Buffer.alloc(sourceWidth * sourceHeight * 4);
    // Solid red, fully opaque.
    for (let offset = 0; offset < source.length; offset += 4) {
      source[offset] = 200;
      source[offset + 3] = 255;
    }
    const output = resampleRgbaBilinear(source, sourceWidth, sourceHeight, 1920, 1080);
    expect(output.length).toBe(1920 * 1080 * 4);
    const middle = (540 * 1920 + 960) * 4;
    expect(output[middle]).toBe(200);
    expect(output[middle + 3]).toBe(255);
  });

  it("keeps fully transparent frames transparent", () => {
    const source = Buffer.alloc(64 * 60 * 4);
    const output = resampleRgbaBilinear(source, 64, 60, 64, 64);
    expect(output.every((value) => value === 0)).toBe(true);
  });
});
