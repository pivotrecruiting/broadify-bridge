import type { FrameBusHeaderT, FrameBusPixelFormatT } from "./framebus-client.js";

export type FrameBusLayoutT = {
  headerSize: number;
  frameSize: number;
  slotStride: number;
  size: number;
};

const FRAMEBUS_HEADER_SIZE = 128;

const BYTES_PER_PIXEL: Record<FrameBusPixelFormatT, number> = {
  1: 4,
  2: 4,
  3: 4,
};

export const getFrameBusBytesPerPixel = (pixelFormat: FrameBusPixelFormatT): number => {
  const value = BYTES_PER_PIXEL[pixelFormat];
  if (!value) {
    throw new Error(`Unsupported FrameBus pixel format: ${pixelFormat}`);
  }
  return value;
};

export const buildFrameBusLayout = (params: {
  width: number;
  height: number;
  pixelFormat: FrameBusPixelFormatT;
  slotCount: number;
  headerSize?: number;
}): FrameBusLayoutT => {
  const { width, height, pixelFormat, slotCount } = params;
  const headerSize = params.headerSize ?? FRAMEBUS_HEADER_SIZE;

  const bytesPerPixel = getFrameBusBytesPerPixel(pixelFormat);
  const frameSize = width * height * bytesPerPixel;
  const slotStride = frameSize;
  const size = headerSize + slotStride * slotCount;

  return {
    headerSize,
    frameSize,
    slotStride,
    size,
  };
};

export const getExpectedFrameBusSizeFromHeader = (header: FrameBusHeaderT): number => {
  return header.headerSize + header.slotStride * header.slotCount;
};

export const FRAMEBUS_HEADER_SIZE_BYTES = FRAMEBUS_HEADER_SIZE;
