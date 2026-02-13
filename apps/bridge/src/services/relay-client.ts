import { WebSocket } from "ws";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { commandRouter, isRelayCommand } from "./command-router.js";
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RelayCommand } from "./command-router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_RELAY_MESSAGE_BYTES = 2 * 1024 * 1024;
const RELAY_COMMAND_TTL_SECONDS = 30;
const RELAY_COMMAND_SKEW_SECONDS = 60;
const MAX_JTI_CACHE_SIZE = 5000;

const RELAY_PUBLIC_KEY_PEM =
  process.env.BRIDGE_RELAY_SIGNING_PUBLIC_KEY ||
  process.env.RELAY_SIGNING_PUBLIC_KEY;
const RELAY_PUBLIC_KEY_KID =
  process.env.BRIDGE_RELAY_SIGNING_KID || process.env.RELAY_SIGNING_KID;
const RELAY_JWKS_URL =
  process.env.BRIDGE_RELAY_JWKS_URL || process.env.RELAY_JWKS_URL;

const isPrivateIpv4 = (ip: string): boolean => {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
};

const isPrivateIpv6 = (ip: string): boolean => {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) {
      return isPrivateIpv4(mapped);
    }
  }
  return false;
};

const isPrivateAddress = (ip: string): boolean => {
  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    return isPrivateIpv4(ip);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(ip);
  }
  return true;
};

const validateJwksUrl = async (): Promise<URL> => {
  if (!RELAY_JWKS_URL) {
    throw new Error("JWKS URL not configured");
  }
  let url: URL;
  try {
    url = new URL(RELAY_JWKS_URL);
  } catch {
    throw new Error("Invalid JWKS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("JWKS URL must use https");
  }
  if (url.username || url.password) {
    throw new Error("JWKS URL must not include credentials");
  }
  const host = url.hostname;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error("JWKS URL resolves to private address");
    }
    return url;
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) {
    throw new Error("JWKS URL DNS lookup failed");
  }
  for (const record of addresses) {
    if (isPrivateAddress(record.address)) {
      throw new Error("JWKS URL resolves to private address");
    }
  }
  return url;
};

/**
 * Get version from package.json
 */
function getVersion(): string {
  try {
    const packagePath = join(__dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

const getRelayMessageByteLength = (data: WebSocket.Data): number => {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf-8");
  }
  if (Buffer.isBuffer(data)) {
    return data.length;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }
  return 0;
};

const relayMessageToString = (data: WebSocket.Data): string => {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf-8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }
  return "";
};

/**
 * Relay message types
 */
/**
 * Sent to the relay upon connection to announce bridge identity/version.
 */
interface BridgeHelloMessage {
  type: "bridge_hello";
  bridgeId: string;
  version: string;
  bridgeName?: string;
}

interface BridgeEventMessage {
  type: "bridge_event";
  bridgeId: string;
  event: string;
  data?: unknown;
  timestamp: number;
}

/**
 * Command payload received from relay.
 */
interface RelayCommandMessage {
  type: "command";
  requestId: string;
  command: string;
  payload?: Record<string, unknown>;
  meta?: RelayCommandMeta;
  signature?: string;
}

/**
 * Command result response sent back to relay.
 */
interface CommandResultMessage {
  type: "command_result";
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type RelayMessage = BridgeHelloMessage | RelayCommandMessage;

type RelayCommandMeta = {
  bridgeId: string;
  orgId: string;
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
  kid: string;
};

type PublicKeyCacheEntry = {
  kid: string;
  key: ReturnType<typeof createPublicKey>;
};

const publicKeyCache = new Map<string, PublicKeyCacheEntry>();
let jwksRefreshInFlight: Promise<void> | null = null;
const seenJti = new Map<string, number>();

const base64UrlDecode = (value: string): Buffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const normalized = padded + "=".repeat(padLength);
  return Buffer.from(normalized, "base64");
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  );
  return `{${entries.join(",")}}`;
};

const registerPublicKey = (
  kid: string,
  key: ReturnType<typeof createPublicKey>,
) => {
  publicKeyCache.set(kid, { kid, key });
};

const loadPublicKeyFromEnv = () => {
  if (!RELAY_PUBLIC_KEY_PEM || !RELAY_PUBLIC_KEY_KID) {
    return;
  }
  if (!publicKeyCache.has(RELAY_PUBLIC_KEY_KID)) {
    const key = createPublicKey(RELAY_PUBLIC_KEY_PEM);
    registerPublicKey(RELAY_PUBLIC_KEY_KID, key);
  }
};

const refreshJwks = async () => {
  if (!RELAY_JWKS_URL) {
    return;
  }
  if (jwksRefreshInFlight) {
    await jwksRefreshInFlight;
    return;
  }
  jwksRefreshInFlight = (async () => {
    const jwksUrl = await validateJwksUrl();
    const response = await fetch(jwksUrl.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      keys?: Record<string, unknown>[];
    };
    if (!Array.isArray(data.keys)) {
      throw new Error("JWKS response missing keys");
    }
    for (const key of data.keys) {
      if (typeof key?.kid !== "string") {
        continue;
      }
      try {
        const publicKey = createPublicKey({ key, format: "jwk" });
        registerPublicKey(key.kid, publicKey);
      } catch {
        // ignore invalid keys
      }
    }
  })();
  try {
    await jwksRefreshInFlight;
  } finally {
    jwksRefreshInFlight = null;
  }
};

const getPublicKey = async (kid: string) => {
  loadPublicKeyFromEnv();
  const cached = publicKeyCache.get(kid);
  if (cached) {
    return cached.key;
  }
  if (RELAY_JWKS_URL) {
    await refreshJwks();
    return publicKeyCache.get(kid)?.key;
  }
  return undefined;
};

const pruneJtiCache = (nowSec: number) => {
  for (const [jti, exp] of seenJti.entries()) {
    if (exp <= nowSec) {
      seenJti.delete(jti);
    }
  }
  while (seenJti.size > MAX_JTI_CACHE_SIZE) {
    const oldest = seenJti.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    seenJti.delete(oldest);
  }
};

/**
 * Relay Client Service
 *
 * Manages outbound WebSocket connection to Relay Server.
 * Handles bridge registration, command reception, and result sending.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private bridgeId: string;
  private relayUrl: string;
  private bridgeName?: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 60000; // Max 60 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isShuttingDown = false;
  private lastSeen: Date | null = null;
  private logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
  };

  /**
   * Create a relay client instance.
   *
   * @param bridgeId Bridge identifier.
   * @param relayUrl Relay WebSocket URL.
   * @param logger Optional logger implementation.
   * @param bridgeName Optional bridge display name.
   */
  constructor(
    bridgeId: string,
    relayUrl: string,
    logger?: {
      info: (msg: string) => void;
      error: (msg: string) => void;
      warn: (msg: string) => void;
    },
    bridgeName?: string,
  ) {
    this.bridgeId = bridgeId;
    this.relayUrl = relayUrl;
    this.bridgeName = bridgeName;
    this.logger = logger || {
      info: (msg: string) => console.log(`[RelayClient] ${msg}`),
      error: (msg: string) => console.error(`[RelayClient] ${msg}`),
      warn: (msg: string) => console.warn(`[RelayClient] ${msg}`),
      debug: (msg: string) => console.debug(`[RelayClient] ${msg}`),
    };
  }

  /**
   * Publish bridge event to relay subscribers.
   *
   * @param payload Event payload (type + data).
   */
  sendBridgeEvent(payload: { event: string; data?: unknown }): void {
    if (!this.isConnected()) {
      this.logger.warn("Cannot send bridge event: not connected to relay");
      return;
    }
    const message: BridgeEventMessage = {
      type: "bridge_event",
      bridgeId: this.bridgeId,
      event: payload.event,
      data: payload.data,
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * Check if connected to relay
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get last seen timestamp
   */
  getLastSeen(): Date | null {
    return this.lastSeen;
  }

  /**
   * Connect to relay server.
   *
   * @returns Promise resolved when connection attempt is initiated.
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isShuttingDown) {
      return;
    }

    if (this.isConnected()) {
      this.logger.debug?.("Already connected to relay");
      return;
    }

    this.isConnecting = true;

    try {
      this.logger.info(`Connecting to relay at ${this.relayUrl}...`);

      this.ws = new WebSocket(this.relayUrl);

      this.ws.on("open", () => {
        this.logger.info("Connected to relay server");
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.lastSeen = new Date();

        // Send bridge_hello message
        this.sendHello();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on("close", () => {
        this.logger.warn("Disconnected from relay server");
        this.ws = null;
        this.isConnecting = false;
        this.lastSeen = null;

        // Attempt reconnect if not shutting down
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (error: Error) => {
        this.logger.error(`WebSocket error: ${error.message}`);
        this.isConnecting = false;
      });
    } catch (error: unknown) {
      this.isConnecting = false;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to create WebSocket connection: ${errorMessage}`,
      );

      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Send bridge_hello message
   */
  private sendHello(): void {
    if (!this.isConnected()) {
      return;
    }

    const message: BridgeHelloMessage = {
      type: "bridge_hello",
      bridgeId: this.bridgeId,
      version: getVersion(),
    };
    if (this.bridgeName) {
      message.bridgeName = this.bridgeName;
    }

    this.send(message);
    this.logger.debug?.(`Sent bridge_hello with bridgeId: ${this.bridgeId}`);
  }

  /**
   * Handle incoming message from relay.
   *
   * Relay data is untrusted and must be validated downstream.
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const messageSize = getRelayMessageByteLength(data);
      if (messageSize > MAX_RELAY_MESSAGE_BYTES) {
        this.logger.warn(
          `Dropped relay message exceeding size limit (${messageSize} bytes)`,
        );
        return;
      }
      const messageText = relayMessageToString(data);
      if (!messageText) {
        this.logger.warn("Dropped relay message: empty payload");
        return;
      }
      const message: RelayMessage = JSON.parse(messageText);
      this.lastSeen = new Date();

      if (message.type === "command") {
        await this.handleCommand(message);
      } else {
        this.logger.warn(
          `Unknown message type: ${(message as { type: string }).type}`,
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Error handling message: ${errorMessage}`);
    }
  }

  /**
   * Handle command from relay.
   *
   * @param message Untrusted relay command message.
   */
  private async handleCommand(message: RelayCommandMessage): Promise<void> {
    try {
      await this.verifySignedCommand(message);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Invalid relay signature";
      this.logger.warn(
        `Rejected relay command (requestId: ${message.requestId}): ${errorMessage}`,
      );
      this.send({
        type: "command_result",
        requestId: message.requestId,
        success: false,
        error: errorMessage,
      });
      return;
    }

    if (!isRelayCommand(message.command)) {
      this.logger.warn(`Rejected unknown command: ${String(message.command)}`);
      this.send({
        type: "command_result",
        requestId: message.requestId,
        success: false,
        error: "Unknown command",
      });
      return;
    }

    const command = message.command as RelayCommand;
    this.logger.debug?.(
      `Received relay command: ${command} (requestId: ${message.requestId})`,
    );

    try {
      const result = await commandRouter.handleCommand(
        command,
        message.payload,
      );

      // Send result back to relay
      const resultMessage: CommandResultMessage = {
        type: "command_result",
        requestId: message.requestId,
        success: result.success,
        data: result.data,
        error: result.error,
      };

      this.send(resultMessage);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Send error result
      const resultMessage: CommandResultMessage = {
        type: "command_result",
        requestId: message.requestId,
        success: false,
        error: errorMessage,
      };

      this.send(resultMessage);
    }
  }

  /**
   * Send message to relay
   */
  private send(message: unknown): void {
    if (!this.isConnected() || !this.ws) {
      this.logger.warn("Cannot send message: not connected to relay");
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Error sending message: ${errorMessage}`);
    }
  }

  private async verifySignedCommand(
    message: RelayCommandMessage,
  ): Promise<void> {
    if (!message.meta || !message.signature) {
      throw new Error("Missing command signature");
    }

    const meta = message.meta;
    if (
      typeof meta.bridgeId !== "string" ||
      typeof meta.orgId !== "string" ||
      !Array.isArray(meta.scope) ||
      typeof meta.iat !== "number" ||
      typeof meta.exp !== "number" ||
      typeof meta.jti !== "string" ||
      typeof meta.kid !== "string"
    ) {
      throw new Error("Invalid command metadata");
    }

    if (meta.bridgeId !== this.bridgeId) {
      throw new Error("Bridge ID mismatch");
    }

    const scopeToken = `command:${message.command}`;
    if (!meta.scope.includes(scopeToken) && !meta.scope.includes("*")) {
      throw new Error("Scope mismatch");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (meta.exp + RELAY_COMMAND_SKEW_SECONDS < nowSec) {
      throw new Error("Command expired");
    }
    if (meta.iat - RELAY_COMMAND_SKEW_SECONDS > nowSec) {
      throw new Error("Command timestamp invalid");
    }

    pruneJtiCache(nowSec);
    const existing = seenJti.get(meta.jti);
    if (existing && existing > nowSec) {
      throw new Error("Replay detected");
    }

    const publicKey = await getPublicKey(meta.kid);
    if (!publicKey) {
      throw new Error("Signing key not found");
    }

    const signingPayload = {
      requestId: message.requestId,
      command: message.command,
      payload: message.payload ?? null,
      meta,
    };
    const data = Buffer.from(stableStringify(signingPayload));
    const signature = base64UrlDecode(message.signature);
    const valid = verifySignature(null, data, publicKey, signature);
    if (!valid) {
      throw new Error("Invalid signature");
    }

    seenJti.set(meta.jti, meta.exp || nowSec + RELAY_COMMAND_TTL_SECONDS);
  }

  /**
   * Schedule reconnect with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.isShuttingDown) {
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );

    this.logger.debug?.(
      `Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Disconnect from relay
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.logger.info("Disconnected from relay");
  }
}
