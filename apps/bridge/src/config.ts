import { z } from "zod";

/**
 * Bridge configuration schema
 */
const ConfigSchema = z.object({
  host: z.string().ip({ version: "v4", message: "Invalid IPv4 address" }),
  port: z.number().int().min(1).max(65535),
  mode: z.enum(["lan", "local"]),
  bridgeId: z.string().uuid().optional(),
  relayUrl: z.string().url().optional(),
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
    bridgeId?: string;
    relayUrl?: string;
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
    } else if (arg === "--relay-url" && nextArg) {
      config.relayUrl = nextArg;
      i++; // Skip next argument as it's the value
    }
  }

  // Load from environment variables if not provided via CLI
  if (!config.bridgeId && process.env.BRIDGE_ID) {
    config.bridgeId = process.env.BRIDGE_ID;
  }
  if (!config.relayUrl && process.env.RELAY_URL) {
    config.relayUrl = process.env.RELAY_URL;
  } else if (!config.relayUrl) {
    // Default relay URL if not provided
    config.relayUrl = "wss://broadify-relay.fly.dev";
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
