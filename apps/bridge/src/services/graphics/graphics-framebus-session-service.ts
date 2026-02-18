import { getBridgeContext } from "../bridge-context.js";
import type { GraphicsOutputConfigT } from "./graphics-schemas.js";
import {
  applyFrameBusEnv,
  buildFrameBusConfig,
  type FrameBusConfigT,
} from "./framebus/framebus-config.js";

/**
 * Resolve FrameBus config for an output session.
 *
 * @param config Target output configuration.
 * @param previous Previous FrameBus config.
 * @returns Resolved FrameBus config.
 */
export function resolveFrameBusConfig(
  config: GraphicsOutputConfigT,
  previous: FrameBusConfigT | null
): FrameBusConfigT {
  const requestedPixelFormat =
    process.env.BRIDGE_FRAME_PIXEL_FORMAT ??
    process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT;
  if (requestedPixelFormat && requestedPixelFormat !== "1") {
    getBridgeContext().logger.warn(
      `[Graphics] FrameBus pixel format ${requestedPixelFormat} not supported; enforcing RGBA8`
    );
  }

  return buildFrameBusConfig(config, previous);
}

/**
 * Log FrameBus config changes once they differ from the previous config.
 *
 * @param previous Previous FrameBus config.
 * @param next Next FrameBus config.
 */
export function logFrameBusConfigChange(
  previous: FrameBusConfigT | null,
  next: FrameBusConfigT
): void {
  const changed =
    !previous ||
    previous.name !== next.name ||
    previous.slotCount !== next.slotCount ||
    previous.pixelFormat !== next.pixelFormat ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.fps !== next.fps;

  if (!changed) {
    return;
  }

  getBridgeContext().logger.info(
    `[Graphics] FrameBus config ${JSON.stringify({
      name: next.name,
      slotCount: next.slotCount,
      pixelFormat: next.pixelFormat,
      width: next.width,
      height: next.height,
      fps: next.fps,
      size: next.size,
    })}`
  );
}

/**
 * Resolve and apply FrameBus environment variables for a session.
 *
 * @param config Target output configuration.
 * @param previous Previous FrameBus config.
 * @returns Applied FrameBus config.
 */
export function applyFrameBusSessionConfig(
  config: GraphicsOutputConfigT,
  previous: FrameBusConfigT | null
): FrameBusConfigT {
  const next = resolveFrameBusConfig(config, previous);
  applyFrameBusEnv(next);
  logFrameBusConfigChange(previous, next);
  return next;
}
