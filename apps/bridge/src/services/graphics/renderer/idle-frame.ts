/**
 * Pure helpers for the idle frame: the picture the FrameBus must carry while
 * no graphics layer is live.
 *
 * This used to be hard zeros, produced by capturing the renderer page. Both
 * were wrong for an opaque output: zeros are black, which a downstream chroma
 * keyer cannot key, and a capture returns whatever background the LAST layer
 * happened to set - so the colour of one graphic stayed on air after it was
 * removed. The idle frame is derived from the session background instead,
 * which belongs to the output, and is built without touching the page at all.
 */

export type IdleFrameColorT = { r: number; g: number; b: number; a: number };

const TRANSPARENT: IdleFrameColorT = { r: 0, g: 0, b: 0, a: 0 };

// Must match resolveBackgroundColor() in the renderer DOM runtime, otherwise
// the page and the idle frame would disagree on the key colour.
const BACKGROUND_MODE_COLORS: Record<string, IdleFrameColorT> = {
  green: { r: 0, g: 255, b: 0, a: 255 },
  black: { r: 0, g: 0, b: 0, a: 255 },
  white: { r: 255, g: 255, b: 255, a: 255 },
  transparent: TRANSPARENT,
};

const clampChannel = (value: number): number =>
  Math.max(0, Math.min(255, Math.round(value)));

/**
 * Resolve the RGBA colour of the idle frame.
 *
 * @param backgroundMode Session background mode from renderer_configure.
 * @param clearColor Explicit clear colour, which wins over the mode.
 * @returns Colour to fill an empty frame with.
 */
export function resolveIdleFrameColor(
  backgroundMode: string | null | undefined,
  clearColor: { r: number; g: number; b: number; a: number } | null | undefined,
): IdleFrameColorT {
  if (clearColor) {
    const { r, g, b, a } = clearColor;
    if ([r, g, b, a].every((value) => Number.isFinite(value))) {
      return {
        r: clampChannel(r),
        g: clampChannel(g),
        b: clampChannel(b),
        // The clear colour carries alpha as 0..1 (CSS rgba), the frame as 0..255.
        a: clampChannel(Math.max(0, Math.min(1, a)) * 255),
      };
    }
  }

  if (!backgroundMode) {
    return TRANSPARENT;
  }

  return BACKGROUND_MODE_COLORS[backgroundMode] ?? TRANSPARENT;
}

/**
 * Build an RGBA8 frame filled with a single colour.
 *
 * @param width Frame width in pixels.
 * @param height Frame height in pixels.
 * @param color Fill colour.
 * @returns Frame buffer of width * height * 4 bytes.
 */
export function buildIdleFrameBuffer(
  width: number,
  height: number,
  color: IdleFrameColorT,
): Buffer {
  const byteLength = Math.max(0, width * height * 4);
  // A fully transparent frame is all zeros, so the fast path also keeps the
  // pre-existing byte-for-byte behaviour for key/fill and the meeting planes.
  if (color.a === 0 && color.r === 0 && color.g === 0 && color.b === 0) {
    return Buffer.alloc(byteLength, 0);
  }

  const buffer = Buffer.allocUnsafe(byteLength);
  for (let index = 0; index < byteLength; index += 4) {
    buffer[index] = color.r;
    buffer[index + 1] = color.g;
    buffer[index + 2] = color.b;
    buffer[index + 3] = color.a;
  }
  return buffer;
}
