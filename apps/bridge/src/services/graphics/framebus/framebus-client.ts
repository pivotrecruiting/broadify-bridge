import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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

export class InvalidHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHeaderError";
  }
}

export class FrameSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameSizeError";
  }
}

export class OpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenError";
  }
}

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

const mapFrameBusError = (error: unknown): Error => {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const message = error.message || "FrameBus error";
  if (
    message.includes("Invalid FrameBus header") ||
    message.includes("Invalid header")
  ) {
    return new InvalidHeaderError(message);
  }
  if (message.includes("Frame size mismatch") || message.includes("size too large")) {
    return new FrameSizeError(message);
  }
  if (
    message.includes("openReader") ||
    message.includes("createWriter") ||
    message.includes("FrameBus name is required") ||
    message.includes("not implemented")
  ) {
    return new OpenError(message);
  }
  return error;
};

const wrapWriter = (writer: FrameBusWriterT): FrameBusWriterT => {
  return {
    ...writer,
    writeFrame(buffer: Buffer, timestampNs?: bigint): void {
      try {
        writer.writeFrame(buffer, timestampNs);
      } catch (error) {
        throw mapFrameBusError(error);
      }
    },
    close(): void {
      writer.close();
    },
  };
};

const wrapReader = (reader: FrameBusReaderT): FrameBusReaderT => {
  return {
    ...reader,
    readLatest(): { buffer: Buffer; timestampNs: bigint; seq: bigint } | null {
      try {
        return reader.readLatest();
      } catch (error) {
        throw mapFrameBusError(error);
      }
    },
    close(): void {
      reader.close();
    },
  };
};

const wrapModule = (module: FrameBusModuleT): FrameBusModuleT => {
  return {
    createWriter(options) {
      try {
        return wrapWriter(module.createWriter(options));
      } catch (error) {
        throw mapFrameBusError(error);
      }
    },
    openReader(options) {
      try {
        return wrapReader(module.openReader(options));
      } catch (error) {
        throw mapFrameBusError(error);
      }
    },
  };
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
  return wrapModule(requireFn(addonPath) as FrameBusModuleT);
};
