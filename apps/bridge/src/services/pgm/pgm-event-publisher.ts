import type { PgmStatusT } from "@broadify/protocol";

import { getBridgeContext } from "../bridge-context.js";

/** Publishes the live program status as `bridge_event pgm_status` (best effort: the relay fan-out is machine-local). */
export function publishPgmStatusEvent(reason: string, status: PgmStatusT): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }
  getBridgeContext().logger.debug?.(`[PGM] Publish status: ${reason}`);
  publishBridgeEvent({ event: "pgm_status", data: { reason, at: Date.now(), status } });
}

export function publishPgmErrorEvent(code: string, message: string): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }
  getBridgeContext().logger.warn(`[PGM] ${code}: ${message}`);
  publishBridgeEvent({ event: "pgm_error", data: { code, message, at: Date.now() } });
}
