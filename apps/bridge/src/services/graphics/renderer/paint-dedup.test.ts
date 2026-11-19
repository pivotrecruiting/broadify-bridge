import { shouldSkipIdenticalPaint } from "./paint-dedup.js";

describe("paint-dedup", () => {
  it("skips an identical paint within the window", () => {
    const buffer = Buffer.from([1, 2, 3, 4]);
    const lastWritten = Buffer.from(buffer);

    expect(
      shouldSkipIdenticalPaint({
        buffer,
        lastWritten,
        nowMs: 1_500,
        lastWrittenAtMs: 1_000,
        windowMs: 1_000,
      })
    ).toBe(true);
  });

  it("writes an identical paint after the window", () => {
    const buffer = Buffer.from([1, 2, 3, 4]);
    const lastWritten = Buffer.from(buffer);

    expect(
      shouldSkipIdenticalPaint({
        buffer,
        lastWritten,
        nowMs: 2_000,
        lastWrittenAtMs: 1_000,
        windowMs: 1_000,
      })
    ).toBe(false);
  });

  it("writes a paint that differs by one byte outside the old stride raster", () => {
    const buffer = Buffer.alloc(8_192, 0x11);
    const lastWritten = Buffer.from(buffer);
    buffer[1] = 0x22;

    expect(
      shouldSkipIdenticalPaint({
        buffer,
        lastWritten,
        nowMs: 1_500,
        lastWrittenAtMs: 1_000,
        windowMs: 1_000,
      })
    ).toBe(false);
  });
});
