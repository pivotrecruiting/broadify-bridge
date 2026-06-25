import { GraphicsManager } from "../graphics/graphics-manager.js";
import type {
  GraphicsCategoryT,
  MeetingGraphicsPlaneT,
} from "../graphics/graphics-schemas.js";

const MEETING_GRAPHICS_LAYER_PREFIX = "meeting-";
const MEETING_CONTENT_LAYER_ID = "meeting-content-template";

export const MEETING_GRAPHICS_BACK_FRAMEBUS_NAME = "bfy-meet-gfx-back";
export const MEETING_GRAPHICS_FRONT_FRAMEBUS_NAME = "bfy-meet-gfx-front";

const layerPlaneById = new Map<string, MeetingGraphicsPlaneT>();

function getPayloadLayerId(payload: Record<string, unknown> | undefined): string | null {
  return typeof payload?.layerId === "string" ? payload.layerId : null;
}

function getPayloadCategory(
  payload: Record<string, unknown> | undefined,
): GraphicsCategoryT | null {
  const category = payload?.category;
  if (
    category === "backgrounds" ||
    category === "lower-thirds" ||
    category === "overlays" ||
    category === "slides"
  ) {
    return category;
  }
  return null;
}

function getExplicitMeetingPlane(
  payload: Record<string, unknown> | undefined,
): MeetingGraphicsPlaneT | null {
  const plane = payload?.meetingPlane;
  if (plane === "back" || plane === "front") {
    return plane;
  }
  return null;
}

/**
 * Resolve the semantic meeting compositor plane for a layer payload.
 */
export function resolveMeetingGraphicsPlane(
  payload: Record<string, unknown> | undefined,
): MeetingGraphicsPlaneT {
  const explicitPlane = getExplicitMeetingPlane(payload);
  if (explicitPlane) {
    return explicitPlane;
  }

  const layerId = getPayloadLayerId(payload);
  if (layerId) {
    const knownPlane = layerPlaneById.get(layerId);
    if (knownPlane) {
      return knownPlane;
    }
    if (layerId === MEETING_CONTENT_LAYER_ID) {
      return "back";
    }
  }

  const category = getPayloadCategory(payload);
  if (category === "backgrounds" || category === "slides") {
    return "back";
  }
  return "front";
}

/**
 * Dedicated graphics renderer instances for layers consumed by the native
 * meeting compositor through semantic back/front graphics FrameBus planes.
 */
export const meetingBackGraphicsManager = new GraphicsManager();
export const meetingFrontGraphicsManager = new GraphicsManager();

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

/**
 * Resolve the graphics manager that owns the given meeting layer payload.
 */
export function resolveMeetingGraphicsManager(
  payload: Record<string, unknown> | undefined,
): GraphicsManager {
  const plane = resolveMeetingGraphicsPlane(payload);
  return plane === "back" ? meetingBackGraphicsManager : meetingFrontGraphicsManager;
}

/**
 * Remember the plane selected for a layer so updates/removes route consistently.
 */
export function rememberMeetingGraphicsPlane(payload: Record<string, unknown>): void {
  const layerId = getPayloadLayerId(payload);
  if (!layerId) {
    return;
  }
  layerPlaneById.set(layerId, resolveMeetingGraphicsPlane(payload));
}

/**
 * Forget the plane mapping when a layer is removed.
 */
export function forgetMeetingGraphicsPlane(payload: Record<string, unknown>): void {
  const layerId = getPayloadLayerId(payload);
  if (!layerId) {
    return;
  }
  layerPlaneById.delete(layerId);
}
