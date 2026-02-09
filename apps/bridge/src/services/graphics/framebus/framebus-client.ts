import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type FrameBusPixelFormatT = 1 | 2 | 3;

export type FrameBusHeaderT = {
  magic: number;
  version: number;
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

export type FrameBusModuleT = {
  createWriter(options: {
    name: string;
    width: number;
    height: number;
    fps: number;
    pixelFormat: FrameBusPixelFormatT;
    slotCount: number;
  }): FrameBusWriterT;
  openReader(options: { name: string }): FrameBusReaderT;
};

const FRAMEBUS_ENV_FLAG = "BRIDGE_GRAPHICS_FRAMEBUS";
const FRAMEBUS_NATIVE_PATH_ENV = "BRIDGE_FRAMEBUS_NATIVE_PATH";

const resolveBridgeRoot = (): string => {
  const currentFile = fileURLToPath(import.meta.url);
  const baseDir = path.dirname(currentFile);
  return path.resolve(baseDir, "../../../../");
};

const resolveNativeCandidates = (): string[] => {
  const candidates: string[] = [];
  const envPath = process.env[FRAMEBUS_NATIVE_PATH_ENV];
  if (envPath) {
    candidates.push(envPath);
  }

  const bridgeRoot = resolveBridgeRoot();
  candidates.push(
    path.join(bridgeRoot, "native", "framebus", "build", "Release", "framebus.node")
  );
  candidates.push(
    path.join(bridgeRoot, "native", "framebus", "build", "Debug", "framebus.node")
  );

  if (process.resourcesPath) {
    candidates.push(
      path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "apps",
        "bridge",
        "native",
        "framebus",
        "build",
        "Release",
        "framebus.node"
      )
    );
  }

  return candidates;
};

const findNativeAddonPath = (): string | null => {
  for (const candidate of resolveNativeCandidates()) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * Check whether the FrameBus feature flag is enabled.
 */
export const isFrameBusEnabled = (): boolean => {
  return process.env[FRAMEBUS_ENV_FLAG] === "1";
};

/**
 * Load the native FrameBus addon when enabled.
 */
export const loadFrameBusModule = (): FrameBusModuleT | null => {
  if (!isFrameBusEnabled()) {
    return null;
  }

  const addonPath = findNativeAddonPath();
  if (!addonPath) {
    throw new Error("FrameBus addon not found (BRIDGE_FRAMEBUS_NATIVE_PATH)");
  }

  const requireFn = createRequire(import.meta.url);
  return requireFn(addonPath) as FrameBusModuleT;
};
