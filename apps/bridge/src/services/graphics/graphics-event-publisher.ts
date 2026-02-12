import { getBridgeContext } from "../bridge-context.js";
import type { GraphicsStatusSnapshotT } from "./graphics-manager-types.js";

/**
 * Publish current graphics status over bridge events.
 *
 * @param reason Status update reason.
 * @param status Current status snapshot.
 */
export function publishGraphicsStatusEvent(
  reason: string,
  status: GraphicsStatusSnapshotT
): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }
  getBridgeContext().logger.info(`[Graphics] Publish status: ${reason}`);
  publishBridgeEvent({
    event: "graphics_status",
    data: {
      reason,
      activePreset: status.activePreset,
      activePresets: status.activePresets,
    },
  });
}

/**
 * Publish graphics error over bridge events.
 *
 * @param code Error code.
 * @param message Error message.
 */
export function publishGraphicsErrorEvent(code: string, message: string): void {
  const publishBridgeEvent = getBridgeContext().publishBridgeEvent;
  if (!publishBridgeEvent) {
    return;
  }
  getBridgeContext().logger.error(`[Graphics] Error reported: ${code} ${message}`);
  publishBridgeEvent({
    event: "graphics_error",
    data: {
      code,
      message,
    },
  });
}
