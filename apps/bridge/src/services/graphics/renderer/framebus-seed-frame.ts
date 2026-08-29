/**
 * Pure decision logic for seeding a freshly created FrameBus writer.
 *
 * The init frame used to be hard zeros unconditionally. A writer swap does not
 * only happen on an idle renderer though: a geometry change or the meeting
 * reattach recreates the writer mid-show. A blank frame there drops key/fill to
 * key=0 and robs a downstream chroma keyer of its key colour, so instead of
 * disappearing cleanly the black frame is what goes to air. Re-publishing the
 * retained frame keeps the picture up until the next paint lands.
 *
 * Extracted so the decision is unit-testable without spawning the Electron
 * renderer process.
 */

/**
 * Pick the buffer that seeds a new FrameBus writer.
 *
 * @param retainedFrame Last frame written to the previous writer, if any.
 * @param width Target frame width in pixels.
 * @param height Target frame height in pixels.
 * @returns The frame to re-publish, or null when the caller must fall back to a
 * blank frame (nothing retained, or the retained frame predates a geometry
 * change and would be rejected by the writer as a size mismatch).
 */
export function selectFrameBusSeedFrame(
  retainedFrame: Buffer | null | undefined,
  width: number,
  height: number,
): Buffer | null {
  if (!retainedFrame) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return retainedFrame.length === width * height * 4 ? retainedFrame : null;
}
