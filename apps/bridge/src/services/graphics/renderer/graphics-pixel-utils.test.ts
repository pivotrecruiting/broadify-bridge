import { bgraToRgba } from "./graphics-pixel-utils.js";

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
});
