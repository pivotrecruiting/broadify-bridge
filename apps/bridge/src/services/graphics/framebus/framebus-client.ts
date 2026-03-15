import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  resolveFrameBusNativeCandidates as resolveCandidatesInternal,
  findNativeAddonPath,
  wrapModule,
} from "./framebus-client-internal.js";

export type FrameBusPixelFormatT = 1 | 2 | 3;

export type FrameBusHeaderT = {
  magic: number;
  version: number;
  flags: number;
  headerSize: number;
  width: number;
  height: number;
  fps: number;
  pixelFormat: FrameBusPixelFormatT;
  frameSize: number;
  slotCount: number;
  slotStride: number;
  seq: bigint;
  lastWriteNs: bigint;
};

export type FrameBusWriterT = {
  name: string;
  size: number;
  header: FrameBusHeaderT;
  writeFrame(buffer: Buffer, timestampNs?: bigint): void;
  close(): void;
};

export type FrameBusReaderT = {
  name: string;
  header: FrameBusHeaderT;
  readLatest(): { buffer: Buffer; timestampNs: bigint; seq: bigint } | null;
  close(): void;
};

import {
  InvalidHeaderError,
  FrameSizeError,
  OpenError,
} from "./framebus-errors.js";

export { InvalidHeaderError, FrameSizeError, OpenError };

export type FrameBusModuleT = {
  createWriter(options: {
    name: string;
    width: number;
    height: number;
    fps: number;
    pixelFormat: FrameBusPixelFormatT;
    slotCount: number;
    forceRecreate?: boolean;
  }): FrameBusWriterT;
  openReader(options: { name: string }): FrameBusReaderT;
};

const resolveBridgeRoot = (): string => {
  const currentFile = fileURLToPath(import.meta.url);
  const baseDir = path.dirname(currentFile);
  return path.resolve(baseDir, "../../../../");
};

/**
 * Resolve all possible native addon paths in lookup order.
 *
 * @returns Candidate paths for framebus.node.
 */
export const resolveFrameBusNativeCandidates = (): string[] => {
  return resolveCandidatesInternal(resolveBridgeRoot());
};

/**
 * Load the native FrameBus addon. FrameBus is always used for graphics output.
 */
export const loadFrameBusModule = (): FrameBusModuleT | null => {
  const candidates = resolveFrameBusNativeCandidates();
  const addonPath = findNativeAddonPath(candidates);
  if (!addonPath) {
    throw new Error("FrameBus addon not found (BRIDGE_FRAMEBUS_NATIVE_PATH)");
  }

  const requireFn = createRequire(import.meta.url);
  return wrapModule(requireFn(addonPath) as FrameBusModuleT);
};
