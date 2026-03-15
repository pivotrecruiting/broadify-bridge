/**
 * Internal FrameBus client logic, extracted for testability.
 * The main framebus-client.ts uses import.meta.url which Jest does not transform.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  FrameBusModuleT,
  FrameBusWriterT,
  FrameBusReaderT,
} from "./framebus-client.js";
import {
  InvalidHeaderError,
  FrameSizeError,
  OpenError,
} from "./framebus-errors.js";

const FRAMEBUS_NATIVE_PATH_ENV = "BRIDGE_FRAMEBUS_NATIVE_PATH";

/**
 * Resolve all possible native addon paths in lookup order.
 *
 * @param bridgeRoot Resolved bridge root directory (e.g. apps/bridge).
 * @returns Candidate paths for framebus.node.
 */
export const resolveFrameBusNativeCandidates = (bridgeRoot: string): string[] => {
  const candidates: string[] = [];
  const envPath = process.env[FRAMEBUS_NATIVE_PATH_ENV];
  if (envPath) {
    candidates.push(envPath);
  }

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

/**
 * Find first existing addon path from candidates.
 */
export const findNativeAddonPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * Map native FrameBus errors to typed error classes.
 */
export const mapFrameBusError = (error: unknown): Error => {
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

/**
 * Wrap native module with error mapping.
 */
export const wrapModule = (module: FrameBusModuleT): FrameBusModuleT => {
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
