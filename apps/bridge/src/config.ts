import { z } from "zod";

/**
 * Bridge configuration schema
 */
const ConfigSchema = z.object({
  host: z.string().ip({ version: "v4", message: "Invalid IPv4 address" }),
  port: z.number().int().min(1).max(65535),
  mode: z.enum(["lan", "local"]),
  relayEnabled: z.boolean().optional(),
  bridgeId: z.string().uuid().optional(),
  bridgeName: z.string().min(1).max(64).optional(),
  relayUrl: z.string().url().optional(),
  pairingCode: z.string().min(4).max(32).optional(),
  pairingExpiresAt: z.number().int().positive().optional(),
  userDataDir: z.string().min(1).optional(),
});

export type BridgeConfigT = z.infer<typeof ConfigSchema>;

/**
 * Parse CLI arguments and return validated configuration
 */
export function parseConfig(args: string[]): BridgeConfigT {
  const config: Partial<{
    host: string;
    port: number;
    mode: "lan" | "local";
    relayEnabled?: boolean;
    bridgeId?: string;
    bridgeName?: string;
    relayUrl?: string;
    pairingCode?: string;
    pairingExpiresAt?: number;
    userDataDir?: string;
  }> = {
    host: "127.0.0.1",
    port: 8787,
  };

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === "--host" && nextArg) {
      config.host = nextArg;
      i++; // Skip next argument as it's the value
    } else if (arg === "--port" && nextArg) {
      const port = parseInt(nextArg, 10);
      if (!isNaN(port)) {
        config.port = port;
      }
      i++; // Skip next argument as it's the value
    } else if (arg === "--bridge-id" && nextArg) {
      config.bridgeId = nextArg;
      i++; // Skip next argument as it's the value
    } else if (arg === "--bridge-name" && nextArg) {
      config.bridgeName = nextArg;
      i++; // Skip next argument as it's the value
    } else if (arg === "--relay-enabled") {
      config.relayEnabled = true;
    } else if (arg === "--relay-url" && nextArg) {
      config.relayUrl = nextArg;
      i++; // Skip next argument as it's the value
    } else if (arg === "--pairing-code" && nextArg) {
      config.pairingCode = nextArg;
      i++; // Skip next argument as it's the value
    } else if (arg === "--pairing-expires-at" && nextArg) {
      const expiresAt = parseInt(nextArg, 10);
      if (!isNaN(expiresAt)) {
        config.pairingExpiresAt = expiresAt;
      }
      i++; // Skip next argument as it's the value
    } else if (arg === "--user-data-dir" && nextArg) {
      config.userDataDir = nextArg;
      i++; // Skip next argument as it's the value
    }
  }

  const normalizeBoolean = (value: string | undefined): boolean => {
    if (!value) {
      return false;
    }
    const normalized = value.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized);
  };

  if (typeof config.relayEnabled !== "boolean") {
    config.relayEnabled = normalizeBoolean(
      process.env.BRIDGE_RELAY_ENABLED || process.env.RELAY_ENABLED
    );
  }

  // Load from environment variables if not provided via CLI
  if (config.relayEnabled && !config.bridgeId && process.env.BRIDGE_ID) {
    config.bridgeId = process.env.BRIDGE_ID;
  }
  if (!config.bridgeName && process.env.BRIDGE_NAME) {
    config.bridgeName = process.env.BRIDGE_NAME;
  }
  if (config.relayEnabled && !config.relayUrl && process.env.RELAY_URL) {
    config.relayUrl = process.env.RELAY_URL;
  } else if (config.relayEnabled && !config.relayUrl) {
    // Default relay URL if not provided
    config.relayUrl = "wss://broadify-relay.fly.dev";
  }
  if (!config.pairingCode && process.env.PAIRING_CODE) {
    config.pairingCode = process.env.PAIRING_CODE;
  }
  if (
    !config.pairingExpiresAt &&
    process.env.PAIRING_EXPIRES_AT &&
    !isNaN(parseInt(process.env.PAIRING_EXPIRES_AT, 10))
  ) {
    config.pairingExpiresAt = parseInt(process.env.PAIRING_EXPIRES_AT, 10);
  }

  if (!config.userDataDir && process.env.BRIDGE_USER_DATA_DIR) {
    config.userDataDir = process.env.BRIDGE_USER_DATA_DIR;
  }

  if (!config.relayEnabled) {
    config.bridgeId = undefined;
    config.relayUrl = undefined;
    config.pairingCode = undefined;
    config.pairingExpiresAt = undefined;
  }

  // Derive mode from host
  if (config.host === "0.0.0.0") {
    config.mode = "lan";
  } else if (config.host === "127.0.0.1") {
    config.mode = "local";
  } else {
    // For other IPs, assume LAN mode
    config.mode = "lan";
  }

  // Validate with Zod
  return ConfigSchema.parse(config);
}
