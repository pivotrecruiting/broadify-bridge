import { getBridgeContext } from "../bridge-context.js";

/**
 * Publish a meeting status snapshot as bridge_event over the relay.
 *
 * @param reason Trigger reason for diagnostics.
 * @param status Meeting status snapshot (manager + engine state).
 */
export function publishMeetingStatusEvent(
  reason: string,
  status: Record<string, unknown>,
): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }

  getBridgeContext().logger.debug?.(`[Meeting] Publish status: ${reason}`);
  publishBridgeEvent({
    event: "meeting_status",
    data: {
      reason,
      at: Date.now(),
      status,
    },
  });
}

/**
 * Publish a meeting error as bridge_event over the relay.
 *
 * @param code Stable error code.
 * @param message Human readable error message.
 */
export function publishMeetingErrorEvent(code: string, message: string): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }

  getBridgeContext().logger.error(`[Meeting] Error reported: ${code} ${message}`);
  publishBridgeEvent({
    event: "meeting_error",
    data: {
      code,
      message,
      at: Date.now(),
    },
  });
}
