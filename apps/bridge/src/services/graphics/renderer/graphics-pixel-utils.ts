/**
 * Pixel format conversion utilities for graphics rendering.
 */

/**
 * Convert BGRA buffer to RGBA in-place (swap R and B channels).
 *
 * @param buffer RGBA-sized buffer (length must be multiple of 4).
 * @returns The same buffer, mutated.
 */
export function bgraToRgba(buffer: Buffer): Buffer {
  for (let i = 0; i < buffer.length; i += 4) {
    const blue = buffer[i];
    buffer[i] = buffer[i + 2];
    buffer[i + 2] = blue;
  }
  return buffer;
}
