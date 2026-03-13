import * as path from "path";
import type { BridgeConfig } from "../types.js";

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

  return env;
}
