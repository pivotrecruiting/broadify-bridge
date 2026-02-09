import { randomBytes } from "node:crypto";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import type { FrameBusPixelFormatT } from "./framebus-client.js";

export type FrameBusConfigT = {
  name: string;
  slotCount: number;
  pixelFormat: FrameBusPixelFormatT;
  width: number;
  height: number;
  fps: number;
};

// TODO: Tune slot count per hardware/output if drops persist.
const DEFAULT_SLOT_COUNT = 2;
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
  if (parsed === 1 || parsed === 2 || parsed === 3) {
    return parsed;
  }
  return null;
};

const buildFrameBusName = (): string => {
  return `broadify-framebus-${randomBytes(6).toString("hex")}`;
};

export const isFrameBusEnabled = (): boolean => {
  return process.env.BRIDGE_GRAPHICS_FRAMEBUS === "1";
};

export const isFrameBusOutputEnabled = (): boolean => {
  return (
    process.env.BRIDGE_GRAPHICS_OUTPUT_HELPER_FRAMEBUS === "1" &&
    process.env.BRIDGE_GRAPHICS_FRAMEBUS === "1" &&
    Boolean(process.env.BRIDGE_FRAMEBUS_NAME)
  );
};

export const buildFrameBusConfig = (
  outputConfig: GraphicsOutputConfigT,
  previous: FrameBusConfigT | null
): FrameBusConfigT => {
  const name =
    process.env.BRIDGE_FRAMEBUS_NAME?.trim() ||
    previous?.name ||
    buildFrameBusName();
  const slotCount =
    parseSlotCount(process.env.BRIDGE_FRAMEBUS_SLOT_COUNT) ??
    previous?.slotCount ??
    DEFAULT_SLOT_COUNT;
  const pixelFormat =
    parsePixelFormat(process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT) ??
    previous?.pixelFormat ??
    DEFAULT_PIXEL_FORMAT;

  return {
    name,
    slotCount,
    pixelFormat,
    width: outputConfig.format.width,
    height: outputConfig.format.height,
    fps: outputConfig.format.fps,
  };
};

export const applyFrameBusEnv = (config: FrameBusConfigT): void => {
  process.env.BRIDGE_FRAMEBUS_NAME = config.name;
  process.env.BRIDGE_FRAMEBUS_SLOT_COUNT = String(config.slotCount);
  process.env.BRIDGE_FRAMEBUS_PIXEL_FORMAT = String(config.pixelFormat);
};
