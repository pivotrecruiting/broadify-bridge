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
    // Not an integer downscale — e.g. a Windows offscreen capture clamped to
    // the work area (1920x1032) that must still reach 1920x1080. The integer
    // box filter can't express this ratio; fall back to a general bilinear
    // resample instead of throwing (which dropped the frame and flooded the
    // log every frame, leaving the graphics/background layer black).
    return resampleRgbaBilinear(
      buffer,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
    );
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

/**
 * General-purpose bilinear RGBA resample to an arbitrary target size. Used as
 * the fallback when the source is not an integer multiple of the target (e.g.
 * a Windows offscreen capture short by the taskbar height). Handles up- and
 * down-scaling and non-integer ratios.
 */
export function resampleRgbaBilinear(
  buffer: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Buffer {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return buffer;
  }

  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  const xRatio =
    targetWidth > 1 ? (sourceWidth - 1) / (targetWidth - 1) : 0;
  const yRatio =
    targetHeight > 1 ? (sourceHeight - 1) / (targetHeight - 1) : 0;

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const srcYf = targetY * yRatio;
    const y0 = Math.floor(srcYf);
    const y1 = Math.min(y0 + 1, sourceHeight - 1);
    const wy = srcYf - y0;
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const srcXf = targetX * xRatio;
      const x0 = Math.floor(srcXf);
      const x1 = Math.min(x0 + 1, sourceWidth - 1);
      const wx = srcXf - x0;

      const o00 = (y0 * sourceWidth + x0) * 4;
      const o01 = (y0 * sourceWidth + x1) * 4;
      const o10 = (y1 * sourceWidth + x0) * 4;
      const o11 = (y1 * sourceWidth + x1) * 4;
      const writeOffset = (targetY * targetWidth + targetX) * 4;

      for (let channel = 0; channel < 4; channel += 1) {
        const top =
          (buffer[o00 + channel] ?? 0) * (1 - wx) +
          (buffer[o01 + channel] ?? 0) * wx;
        const bottom =
          (buffer[o10 + channel] ?? 0) * (1 - wx) +
          (buffer[o11 + channel] ?? 0) * wx;
        output[writeOffset + channel] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return output;
}
