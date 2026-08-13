/**
 * Pure decision helpers for FrameBus writer reuse in the renderer entry.
 *
 * Extracted so the reuse decision is unit-testable without spawning the
 * Electron renderer process. The historical bug this guards against: the
 * entry compared ONLY geometry (width/height/fps/slotCount/pixelFormat), so a
 * renderer child holding a writer for one meeting bus (e.g.
 * "/bfy-meet-gfx-back") silently no-op'ed a configure that targeted the OTHER
 * meeting bus with identical geometry ("bfy-meet-gfx-front"). The ready ack
 * then carried the stale bus name, the client gate dropped it, and
 * meeting_graphics_configure_outputs timed out forever ("Renderer config
 * ready timed out").
 */

export type FrameBusWriterHeaderT = {
  width: number;
  height: number;
  fps: number;
  slotCount: number;
  pixelFormat: number;
};

/**
 * Normalize a FrameBus name for comparison. Native writers report the POSIX
 * form ("/bfy-meet-gfx-back") or the Windows form ("Local\\name") while the
 * bridge configures the bare name, so the compare must tolerate the platform
 * prefixes. Mirrors the ready-ack gate in electron-renderer-client.ts.
 */
export const normalizeFrameBusNameForCompare = (name: string): string =>
  name
    .trim()
    .replace(/^\/+/, "")
    .replace(/^(?:local|global)\\+/i, "");

/**
 * Decide whether an existing FrameBus writer can be reused for the target
 * configuration. Geometry AND bus name must match; a same-geometry writer on
 * a different bus must be closed and recreated (Studio note: the Studio
 * single-renderer path never changes the bus name mid-session, so the name
 * clause is a no-op there — only the dual meeting renderers alternate names).
 */
export function frameBusWriterMatchesTarget(params: {
  header: FrameBusWriterHeaderT;
  /** Name the existing writer reports (POSIX/Windows form tolerated). */
  writerName: string | undefined;
  /** Bus name the current renderer config targets. */
  targetName: string;
  width: number;
  height: number;
  fps: number;
  slotCount: number;
  pixelFormat: number;
}): boolean {
  const { header } = params;
  const geometryMatches =
    header.width === params.width &&
    header.height === params.height &&
    header.fps === params.fps &&
    header.slotCount === params.slotCount &&
    header.pixelFormat === params.pixelFormat;
  if (!geometryMatches) {
    return false;
  }
  const nameMatches =
    normalizeFrameBusNameForCompare(params.writerName ?? "") ===
    normalizeFrameBusNameForCompare(params.targetName);
  return nameMatches;
}
