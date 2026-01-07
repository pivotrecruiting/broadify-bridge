export type CompositeLayerT = {
  buffer: Buffer;
  width: number;
  height: number;
};

const CHANNELS = 4;

/**
 * Composite multiple RGBA layers into a single RGBA buffer.
 */
export function compositeLayers(
  layers: CompositeLayerT[],
  width: number,
  height: number
): Buffer {
  const output = Buffer.alloc(width * height * CHANNELS, 0);

  for (const layer of layers) {
    if (layer.width !== width || layer.height !== height) {
      continue;
    }

    for (let i = 0; i < output.length; i += CHANNELS) {
      const srcA = layer.buffer[i + 3] / 255;
      if (srcA <= 0) {
        continue;
      }

      const dstA = output[i + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);

      if (outA <= 0) {
        continue;
      }

      const srcR = layer.buffer[i];
      const srcG = layer.buffer[i + 1];
      const srcB = layer.buffer[i + 2];

      const dstR = output[i];
      const dstG = output[i + 1];
      const dstB = output[i + 2];

      const outR = (srcR * srcA + dstR * dstA * (1 - srcA)) / outA;
      const outG = (srcG * srcA + dstG * dstA * (1 - srcA)) / outA;
      const outB = (srcB * srcA + dstB * dstA * (1 - srcA)) / outA;

      output[i] = Math.round(outR);
      output[i + 1] = Math.round(outG);
      output[i + 2] = Math.round(outB);
      output[i + 3] = Math.round(outA * 255);
    }
  }

  return output;
}

/**
 * Apply a solid background to an RGBA buffer.
 */
export function applyBackground(
  buffer: Buffer,
  color: { r: number; g: number; b: number }
): Buffer {
  for (let i = 0; i < buffer.length; i += CHANNELS) {
    const alpha = buffer[i + 3] / 255;
    if (alpha >= 1) {
      continue;
    }

    const invAlpha = 1 - alpha;
    buffer[i] = Math.round(buffer[i] * alpha + color.r * invAlpha);
    buffer[i + 1] = Math.round(buffer[i + 1] * alpha + color.g * invAlpha);
    buffer[i + 2] = Math.round(buffer[i + 2] * alpha + color.b * invAlpha);
    buffer[i + 3] = 255;
  }

  return buffer;
}
