/**
 * Pure decision logic for the FrameBus writer heartbeat.
 *
 * When the renderer shows static content (or only ever wrote its init
 * frame), no paint events fire and the FrameBus seq parks. Downstream
 * readers (the meeting helper's GraphicsFrameBusReader) treat a parked seq
 * as a stale mapping and cycle through close/reopen every 2 seconds. The
 * heartbeat re-publishes the last written frame once per second so the seq
 * keeps advancing. Re-publishing keeps the ORIGINAL capture timestamp:
 * consumers detect new frames by timestamp, so an unchanged timestamp
 * advances seq without triggering extra renders.
 */

export const FRAMEBUS_HEARTBEAT_INTERVAL_MS = 1000;

/**
 * Decide whether the heartbeat tick should re-publish the last frame.
 *
 * @param hasWriter A FrameBus writer currently exists.
 * @param hasLastFrame A previously written frame buffer is retained.
 * @param nowMs Current wall clock (Date.now()).
 * @param lastWrittenAtMs Wall clock of the most recent FrameBus write.
 */
export function shouldRepublishHeartbeatFrame(
  hasWriter: boolean,
  hasLastFrame: boolean,
  nowMs: number,
  lastWrittenAtMs: number,
): boolean {
  return (
    hasWriter &&
    hasLastFrame &&
    nowMs - lastWrittenAtMs >= FRAMEBUS_HEARTBEAT_INTERVAL_MS
  );
}
