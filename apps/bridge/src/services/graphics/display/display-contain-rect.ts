export type ContainRectT = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Largest rectangle with the source aspect ratio that fits centred inside the
 * destination (letterbox / pillarbox). Origin is the top-left corner.
 *
 * Self-contained on purpose: the display window embeds the source of this
 * function into its page script, so it must not reference anything outside
 * its own body.
 *
 * @param sourceWidth Frame width in pixels.
 * @param sourceHeight Frame height in pixels.
 * @param destWidth Canvas width in pixels.
 * @param destHeight Canvas height in pixels.
 * @returns Integer rectangle inside the destination; the full destination
 *   when any dimension is not a positive finite number.
 */
export function computeContainRect(
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
): ContainRectT {
  const valid = [sourceWidth, sourceHeight, destWidth, destHeight].every(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (!valid) {
    return {
      x: 0,
      y: 0,
      width: Math.max(0, Math.floor(Number(destWidth) || 0)),
      height: Math.max(0, Math.floor(Number(destHeight) || 0)),
    };
  }
  const scale = Math.min(destWidth / sourceWidth, destHeight / sourceHeight);
  const width = Math.max(1, Math.min(destWidth, Math.round(sourceWidth * scale)));
  const height = Math.max(1, Math.min(destHeight, Math.round(sourceHeight * scale)));
  return {
    x: Math.floor((destWidth - width) / 2),
    y: Math.floor((destHeight - height) / 2),
    width,
    height,
  };
}
