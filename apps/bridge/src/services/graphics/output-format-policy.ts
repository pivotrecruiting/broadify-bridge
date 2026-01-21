/**
 * Pixel format priorities for DeckLink output.
 */
export const VIDEO_PIXEL_FORMAT_PRIORITY = [
  "10bit_yuv",
  "8bit_yuv",
] as const;

/**
 * Pixel format priorities for DeckLink key/fill output.
 */
export const KEY_FILL_PIXEL_FORMAT_PRIORITY = [
  "8bit_argb",
  "8bit_bgra",
] as const;

/**
 * Check whether any of the preferred pixel formats is supported.
 */
export const supportsAnyPixelFormat = (
  supportedFormats: string[],
  preferredFormats: readonly string[]
): boolean => {
  return preferredFormats.some((format) => supportedFormats.includes(format));
};
