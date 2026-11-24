import { z } from "zod";
import { parseGuardedUrl } from "./services/meeting/media-download.js";

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
  /** Web-app base URL for post-production uploads (session logs); unset = keep logs local only. */
  postproApiUrl: z.string().url().optional(),
  /**
   * Platform (web app) base URL the recording upload talks to (ADR-0011);
   * see `resolvePlatformApiUrl`. Unset = no recording upload on this bridge.
   */
  platformApiUrl: z.string().url().optional(),
  /**
   * True when `platformApiUrl` came from the release-managed key: requests to
   * it then go through the URL guard (https, port 443, public address).
   */
  platformApiUrlGuarded: z.boolean().optional(),
});

export type BridgeConfigT = z.infer<typeof ConfigSchema>;

/**
 * Normalize the optional post-production URL (`--postpro-api-url` /
 * `POSTPRO_API_URL`). The value only switches an optional feature on
 * (session log, ADR-0008), so a malformed one must never stop the bridge
 * from starting: it is dropped with a warning instead of failing the schema.
 *
 * @param raw Raw CLI/env value.
 * @returns Trimmed http(s) URL, or undefined when empty or invalid.
 */
export function normalizePostproApiUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  try {
    const protocol = new URL(value).protocol;
    if (protocol === "http:" || protocol === "https:") {
      return value;
    }
  } catch {
    // fall through to the warning
  }
  // Fixed text: the value may carry credentials and must not reach the log.
  console.warn("[Config] Ignoring invalid post-production URL (expected an http(s) URL); session log stays off");
  return undefined;
}

/**
 * Release-managed key that carries the web app address of the release
 * channel (written into the packaged `.env`, wins over `userData/.env`; see
 * `RELEASE_MANAGED_ENV_KEYS` in the desktop app's env loader).
 */
export const RELEASE_PLATFORM_URL_ENV_KEY = "PRODUCTION_STUDIO_CONTROL_WEBAPP_URL";

export type PlatformApiUrlT = { url: string; guarded: boolean };

/**
 * Address of the platform for the recording upload (ADR-0011). Two sources
 * and no other: the operator override (`--postpro-api-url` /
 * `POSTPRO_API_URL`, already normalized; may be http or loopback for a local
 * web app) and, without it, the release-managed web app address of the
 * channel. The release value must pass the URL guard and is dropped with a
 * fixed warning otherwise. Never taken from a relay command.
 *
 * @param postproApiUrl Normalized operator override, if any.
 * @param releaseUrl Raw value of the release-managed key.
 * @returns The address and whether requests to it must be guarded.
 */
export function resolvePlatformApiUrl(
  postproApiUrl: string | undefined,
  releaseUrl: string | undefined = process.env[RELEASE_PLATFORM_URL_ENV_KEY],
): PlatformApiUrlT | undefined {
  if (postproApiUrl) {
    return { url: postproApiUrl, guarded: false };
  }
  const value = releaseUrl?.trim();
  if (!value) {
    return undefined;
  }
  try {
    parseGuardedUrl(value);
    return { url: value, guarded: true };
  } catch {
    // Fixed text: never the value.
    console.warn("[Config] Ignoring the release web app URL for the recording upload (expected a public https URL)");
    return undefined;
  }
}

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
    postproApiUrl?: string;
    platformApiUrl?: string;
    platformApiUrlGuarded?: boolean;
  }> = {
    host: "127.0.0.1",
    port: 8787,
  };

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === "--postpro-api-url" && nextArg) {
      config.postproApiUrl = nextArg;
      i++;
    } else if (arg === "--host" && nextArg) {
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
  // CLI first; a malformed CLI value falls back to the environment.
  config.postproApiUrl =
    normalizePostproApiUrl(config.postproApiUrl) ?? normalizePostproApiUrl(process.env.POSTPRO_API_URL);
  const platformApi = resolvePlatformApiUrl(config.postproApiUrl);
  config.platformApiUrl = platformApi?.url;
  config.platformApiUrlGuarded = platformApi?.guarded;

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
