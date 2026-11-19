import * as path from "path";
import type { BridgeConfig, BridgeStatus } from "../types.js";

/**
 * Upper bound for waiting on a previous instance of the SAME bridge to
 * release its port before the start is rejected.
 */
export const SAME_BRIDGE_PORT_RELEASE_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for that port to free up. */
export const SAME_BRIDGE_PORT_POLL_MS = 500;

export type BusyPortOccupantT = "same_bridge" | "foreign";

/**
 * Classify who holds a busy bridge port.
 *
 * `occupant` is the health answer of the busy port (`checkBridgeHealth`): its
 * `bridgeId` is read from the bridge's `/relay/status` route, which every
 * bridge started by the desktop app serves (the id is passed as
 * `--bridge-id`). A reachable bridge reporting OUR bridge id is a previous
 * instance of this bridge that is still shutting down (it keeps the port
 * until its HTTP server closes last). It must be waited for, never bypassed
 * via port+1, or the relay/web app would see two bridges with one identity.
 * Anything else (another bridge, a non-bridge service, no JSON answer, an
 * unknown id on either side) is "foreign" and gets the existing fallback.
 */
export function classifyBusyPortOccupant(params: {
  occupant: Pick<BridgeStatus, "reachable" | "bridgeId"> | null;
  bridgeId: string | undefined;
}): BusyPortOccupantT {
  const { occupant, bridgeId } = params;
  if (!occupant?.reachable || !bridgeId || !occupant.bridgeId) {
    return "foreign";
  }
  return occupant.bridgeId === bridgeId ? "same_bridge" : "foreign";
}

export type BridgeStartConfigResultT =
  | {
      success: true;
      config: BridgeConfig;
      actualPort?: number;
    }
  | {
      success: false;
      error: string;
    };

/**
 * Resolve effective bridge config for start, including optional port fallback.
 */
export function resolveBridgeStartConfig(params: {
  config: BridgeConfig;
  portAvailable: boolean;
  autoFindPort: boolean;
  availablePort: number | null;
}): BridgeStartConfigResultT {
  const { config, portAvailable, autoFindPort, availablePort } = params;
  if (portAvailable) {
    return { success: true, config };
  }

  if (!autoFindPort) {
    return {
      success: false,
      error: `Port ${config.port} is already in use. Please choose a different port.`,
    };
  }

  if (!availablePort) {
    return {
      success: false,
      error: `Port ${
        config.port
      } is not available and no alternative port found in range ${
        config.port
      }-${config.port + 10}`,
    };
  }

  return {
    success: true,
    config: { ...config, port: availablePort },
    actualPort: availablePort,
  };
}

/**
 * Build bridge process args for dev/prod runtime.
 */
export function buildBridgeProcessArgs(params: {
  isDev: boolean;
  appPath: string;
  resourcesPath: string;
  config: BridgeConfig;
  bridgeId?: string;
  relayUrl?: string;
  bridgeName?: string;
  relayEnabled?: boolean;
}): string[] {
  const {
    isDev,
    appPath,
    resourcesPath,
    config,
    bridgeId,
    relayUrl,
    bridgeName,
    relayEnabled = false,
  } = params;

  const args: string[] = [];
  if (isDev) {
    args.push("tsx");
    args.push(path.join(appPath, "apps/bridge/src/index.ts"));
  } else {
    args.push(path.join(resourcesPath, "bridge", "dist", "index.js"));
  }

  args.push("--host", config.host);
  args.push("--port", config.port.toString());

  if (config.userDataDir) {
    args.push("--user-data-dir", config.userDataDir);
  }
  if (bridgeId) {
    args.push("--bridge-id", bridgeId);
  }
  if (bridgeName) {
    args.push("--bridge-name", bridgeName);
  }
  if (relayEnabled) {
    args.push("--relay-enabled");
  }
  if (relayUrl) {
    args.push("--relay-url", relayUrl);
  }

  return args;
}

/**
 * Build bridge child-process environment.
 */
export function buildBridgeSpawnEnv(params: {
  processEnv: NodeJS.ProcessEnv;
  isDev: boolean;
  relayEnabled: boolean;
  appVersion: string;
  pairingCode?: string;
  pairingExpiresAt?: number;
}): Record<string, string> {
  const {
    processEnv,
    isDev,
    relayEnabled,
    appVersion,
    pairingCode,
    pairingExpiresAt,
  } =
    params;

  const env: Record<string, string> = {
    ...processEnv,
    NODE_ENV: isDev ? "development" : "production",
    BROADIFY_DESKTOP_APP_VERSION: appVersion,
    // Lets the bridge server detect a dead desktop app and exit instead of
    // surviving as a detached orphan (the bridge spawns with detached: true).
    BRIDGE_PARENT_PID: String(process.pid),
  } as Record<string, string>;

  if (relayEnabled) {
    env.BRIDGE_RELAY_ENABLED = "true";
  }
  if (pairingCode) {
    env.PAIRING_CODE = pairingCode;
  }
  if (typeof pairingExpiresAt === "number") {
    env.PAIRING_EXPIRES_AT = pairingExpiresAt.toString();
  }
  if (!isDev) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  // Node.js only trusts its bundled CA list. Enterprise networks that
  // inspect TLS re-sign the relay connection with a private root CA that is
  // rolled out via the OS trust store, so opt the bridge into that store
  // (honoured by Node >= 22.19, ignored by older runtimes). An explicit
  // value in the parent environment (e.g. an IT policy) is left untouched.
  if (processEnv.NODE_USE_SYSTEM_CA === undefined) {
    env.NODE_USE_SYSTEM_CA = "1";
  }

  return env;
}
