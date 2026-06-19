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

/**
 * Downsample an RGBA buffer with an integer box filter.
 *
 * @param buffer Source RGBA buffer.
 * @param sourceWidth Source width in pixels.
 * @param sourceHeight Source height in pixels.
 * @param targetWidth Target width in pixels.
 * @param targetHeight Target height in pixels.
 * @returns Downsampled RGBA buffer.
 */
export function downsampleRgbaBox(
  buffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Buffer {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return buffer;
  }

  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;
  if (
    !Number.isInteger(scaleX) ||
    !Number.isInteger(scaleY) ||
    scaleX < 1 ||
    scaleY < 1
  ) {
    throw new Error("Downsample dimensions must use positive integer scale factors.");
  }

  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const samples = scaleX * scaleY;
  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sourceY = 0; sourceY < scaleY; sourceY += 1) {
        for (let sourceX = 0; sourceX < scaleX; sourceX += 1) {
          const readX = targetX * scaleX + sourceX;
          const readY = targetY * scaleY + sourceY;
          const readOffset = (readY * sourceWidth + readX) * 4;
          r += buffer[readOffset + 0] ?? 0;
          g += buffer[readOffset + 1] ?? 0;
          b += buffer[readOffset + 2] ?? 0;
          a += buffer[readOffset + 3] ?? 0;
        }
      }
      const writeOffset = (targetY * targetWidth + targetX) * 4;
      output[writeOffset + 0] = Math.round(r / samples);
      output[writeOffset + 1] = Math.round(g / samples);
      output[writeOffset + 2] = Math.round(b / samples);
      output[writeOffset + 3] = Math.round(a / samples);
    }
  }
  return output;
}
