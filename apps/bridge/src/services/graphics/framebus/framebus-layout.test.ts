import {
  getFrameBusBytesPerPixel,
  buildFrameBusLayout,
  getExpectedFrameBusSizeFromHeader,
  FRAMEBUS_HEADER_SIZE_BYTES,
} from "./framebus-layout.js";
import type { FrameBusHeaderT } from "./framebus-client.js";

describe("framebus-layout", () => {
  describe("getFrameBusBytesPerPixel", () => {
    it("returns 4 for pixel format 1", () => {
      expect(getFrameBusBytesPerPixel(1)).toBe(4);
    });

    it("returns 4 for pixel format 2", () => {
      expect(getFrameBusBytesPerPixel(2)).toBe(4);
    });

    it("returns 4 for pixel format 3", () => {
      expect(getFrameBusBytesPerPixel(3)).toBe(4);
    });

    it("throws for unsupported pixel format", () => {
      expect(() => getFrameBusBytesPerPixel(0 as 1)).toThrow(
        "Unsupported FrameBus pixel format"
      );
      expect(() => getFrameBusBytesPerPixel(4 as 1)).toThrow(
        "Unsupported FrameBus pixel format"
      );
    });
  });

  describe("buildFrameBusLayout", () => {
    it("computes layout for 1920x1080 RGBA", () => {
      const layout = buildFrameBusLayout({
        width: 1920,
        height: 1080,
        pixelFormat: 1,
        slotCount: 2,
      });
      expect(layout.frameSize).toBe(1920 * 1080 * 4);
      expect(layout.slotStride).toBe(layout.frameSize);
      expect(layout.headerSize).toBe(FRAMEBUS_HEADER_SIZE_BYTES);
      expect(layout.size).toBe(
        layout.headerSize + layout.slotStride * 2
      );
    });

    it("uses custom headerSize when provided", () => {
      const layout = buildFrameBusLayout({
        width: 100,
        height: 100,
        pixelFormat: 1,
        slotCount: 1,
        headerSize: 256,
      });
      expect(layout.headerSize).toBe(256);
      expect(layout.size).toBe(256 + 100 * 100 * 4);
    });

    it("computes correct size for multiple slots", () => {
      const layout = buildFrameBusLayout({
        width: 10,
        height: 10,
        pixelFormat: 1,
        slotCount: 4,
      });
      const frameSize = 10 * 10 * 4;
      expect(layout.frameSize).toBe(frameSize);
      expect(layout.size).toBe(128 + frameSize * 4);
    });
  });

  describe("getExpectedFrameBusSizeFromHeader", () => {
    it("returns headerSize + slotStride * slotCount", () => {
      const header: FrameBusHeaderT = {
        magic: 0,
        version: 1,
        flags: 0,
        headerSize: 128,
        width: 1920,
        height: 1080,
        fps: 30,
        pixelFormat: 1,
        frameSize: 1920 * 1080 * 4,
        slotCount: 2,
        slotStride: 1920 * 1080 * 4,
        seq: 0n,
        lastWriteNs: 0n,
      };
      const expected = getExpectedFrameBusSizeFromHeader(header);
      expect(expected).toBe(128 + header.slotStride * 2);
    });
  });
});
