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

/**
 * Bilinear RGBA resampler for captures whose size does not match the target
 * by an integer factor. Windows clamps even offscreen windows to the work
 * area (a 1080-tall window captures only 1032 rows next to a taskbar), which
 * made the integer box downsample throw on every frame — graphics then never
 * reached the FrameBus. Interpolation happens on premultiplied components so
 * transparent edges do not bleed color.
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
  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;
  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceY = Math.min(
      sourceHeight - 1,
      Math.max(0, (targetY + 0.5) * scaleY - 0.5),
    );
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const weightY = sourceY - y0;
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceX = Math.min(
        sourceWidth - 1,
        Math.max(0, (targetX + 0.5) * scaleX - 0.5),
      );
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const weightX = sourceX - x0;

      let premulR = 0;
      let premulG = 0;
      let premulB = 0;
      let alphaAcc = 0;
      const corners: Array<[number, number, number]> = [
        [x0, y0, (1 - weightX) * (1 - weightY)],
        [x1, y0, weightX * (1 - weightY)],
        [x0, y1, (1 - weightX) * weightY],
        [x1, y1, weightX * weightY],
      ];
      for (const [cornerX, cornerY, weight] of corners) {
        const offset = (cornerY * sourceWidth + cornerX) * 4;
        const alpha = buffer[offset + 3];
        premulR += buffer[offset] * alpha * weight;
        premulG += buffer[offset + 1] * alpha * weight;
        premulB += buffer[offset + 2] * alpha * weight;
        alphaAcc += alpha * weight;
      }
      const outOffset = (targetY * targetWidth + targetX) * 4;
      if (alphaAcc > 0.0001) {
        output[outOffset] = Math.min(255, Math.round(premulR / alphaAcc));
        output[outOffset + 1] = Math.min(255, Math.round(premulG / alphaAcc));
        output[outOffset + 2] = Math.min(255, Math.round(premulB / alphaAcc));
        output[outOffset + 3] = Math.min(255, Math.round(alphaAcc));
      }
    }
  }
  return output;
}
