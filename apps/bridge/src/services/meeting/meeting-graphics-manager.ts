import { GraphicsManager } from "../graphics/graphics-manager.js";

const MEETING_GRAPHICS_LAYER_PREFIX = "meeting-";

/**
 * Dedicated graphics renderer instance for layers consumed by the native
 * meeting compositor through the meeting graphics FrameBus.
 */
export const meetingGraphicsManager = new GraphicsManager();

/**
 * Check whether a graphics command targets the meeting compositor.
 */
export function isMeetingGraphicsLayerPayload(
  payload: Record<string, unknown> | undefined,
): boolean {
  return (
    typeof payload?.layerId === "string" &&
    payload.layerId.startsWith(MEETING_GRAPHICS_LAYER_PREFIX)
  );
}
