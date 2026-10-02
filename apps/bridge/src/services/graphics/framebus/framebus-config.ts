import { randomBytes } from "node:crypto";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import type { FrameBusPixelFormatT } from "./framebus-client.js";
import { buildFrameBusLayout } from "./framebus-layout.js";

export type FrameBusConfigT = {
  name: string;
  slotCount: number;
  pixelFormat: FrameBusPixelFormatT;
  width: number;
  height: number;
  fps: number;
  frameSize: number;
  slotStride: number;
  headerSize: number;
  size: number;
};

const DEFAULT_SLOT_COUNT = 3;
const DEFAULT_PIXEL_FORMAT: FrameBusPixelFormatT = 1;

const parseSlotCount = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 2) {
    return null;
  }
  return Math.floor(parsed);
};

const parsePixelFormat = (value: string | undefined): FrameBusPixelFormatT | null => {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (parsed === 1) {
    return parsed;
  }
  return null;
};

const buildFrameBusName = (): string => {
  return `broadify-framebus-${randomBytes(6).toString("hex")}`;
};

/**
 * Explicit per-manager FrameBus overrides. Name and slot count resolve as
 * overrides -> previous -> env -> generated/default because BRIDGE_FRAMEBUS_*
 * is process-wide state shared by all managers. A Studio supervisor retry
 * during a meeting must keep its existing Studio bus instead of inheriting the
 * meeting front bus from the ambient env.
 */
export type FrameBusOverridesT = {
  name?: string;
  slotCount?: number;
};

const normalizeOverrideSlotCount = (value: number | undefined): number | null => {
  if (value === undefined || !Number.isFinite(value) || value < 2) {
    return null;
  }
  return Math.floor(value);
};

export const buildFrameBusConfig = (
  outputConfig: GraphicsOutputConfigT,
  previous: FrameBusConfigT | null,
  overrides?: FrameBusOverridesT
): FrameBusConfigT => {
  const name =
    overrides?.name?.trim() ||
    previous?.name ||
    process.env.BRIDGE_FRAMEBUS_NAME?.trim() ||
    buildFrameBusName();
  const slotCount =
    normalizeOverrideSlotCount(overrides?.slotCount) ??
    previous?.slotCount ??
    parseSlotCount(process.env.BRIDGE_FRAMEBUS_SLOT_COUNT) ??
    DEFAULT_SLOT_COUNT;
  const pixelFormat =
    parsePixelFormat(
      process.env.BRIDGE_FRAME_PIXEL_FORMAT ?? process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT
    ) ??
    previous?.pixelFormat ??
    DEFAULT_PIXEL_FORMAT;
  const layout = buildFrameBusLayout({
    width: outputConfig.format.width,
    height: outputConfig.format.height,
    pixelFormat,
    slotCount,
  });

  return {
    name,
    slotCount,
    pixelFormat,
    width: outputConfig.format.width,
    height: outputConfig.format.height,
    fps: outputConfig.format.fps,
    frameSize: layout.frameSize,
    slotStride: layout.slotStride,
    headerSize: layout.headerSize,
    size: layout.size,
  };
};

export const applyFrameBusEnv = (config: FrameBusConfigT): void => {
  process.env.BRIDGE_FRAMEBUS_NAME = config.name;
  process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = String(config.slotCount);
  process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = String(config.pixelFormat);
  process.env.BRIDGE_FRAMEBUS_SIZE = String(config.size);
  process.env.BRIDGE_FRAME_WIDTH = String(config.width);
  process.env.BRIDGE_FRAME_HEIGHT = String(config.height);
  process.env.BRIDGE_FRAME_FPS = String(config.fps);
  process.env.BRIDGE_FRAME_PIXEL_FORMAT = String(config.pixelFormat);
};

export const clearFrameBusEnv = (): void => {
  delete process.env.BRIDGE_FRAMEBUS_NAME;
  delete process.env.BRIDGE_FRAMEBUS_SLOT_COUNT;
  delete process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT;
  delete process.env.BRIDGE_FRAMEBUS_SIZE;
  delete process.env.BRIDGE_FRAME_WIDTH;
  delete process.env.BRIDGE_FRAME_HEIGHT;
  delete process.env.BRIDGE_FRAME_FPS;
  delete process.env.BRIDGE_FRAME_PIXEL_FORMAT;
};
