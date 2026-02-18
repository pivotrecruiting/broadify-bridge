import path from "node:path";
import type { BridgeConfigT } from "../config.js";

export type LoggerLikeT = {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type BridgeEventPayloadT = {
  event: string;
  data?: unknown;
};

export type BridgeContextT = {
  userDataDir: string;
  logger: LoggerLikeT;
  logPath: string;
  bridgeId?: string;
  bridgeName?: string;
  pairingCode?: string;
  pairingExpiresAt?: number;
  publishBridgeEvent?: (payload: BridgeEventPayloadT) => void;
};

let bridgeContext: BridgeContextT | null = null;

/**
 * Resolve the bridge user data directory.
 *
 * @param config Bridge startup config.
 * @returns Resolved user data directory path.
 */
export function resolveUserDataDir(config: BridgeConfigT): string {
  if (config.userDataDir) {
    return config.userDataDir;
  }

  return path.join(process.cwd(), ".bridge-data");
}

/**
 * Store shared bridge context (paths, logger).
 *
 * @param context Bridge context object.
 */
export function setBridgeContext(context: BridgeContextT): void {
  bridgeContext = context;
}

/**
 * Read shared bridge context.
 *
 * @returns Current bridge context.
 */
export function getBridgeContext(): BridgeContextT {
  if (!bridgeContext) {
    throw new Error("Bridge context not initialized");
  }
  return bridgeContext;
}
