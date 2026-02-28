import { WebSocket } from "ws";
import { createPublicKey } from "node:crypto";
import {
  isRelayCommand,
  type RelayCommand,
} from "./relay-command-allowlist.js";
import {
  type RelayCommandMetaT,
  verifySignedRelayCommand,
} from "./relay-command-security.js";
import {
  getRelayBridgeEnrollmentPublicKey,
  signRelayBridgeAuthChallenge,
} from "./relay-bridge-identity.js";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { getRuntimeAppVersion } from "./runtime-app-version.js";

const MAX_RELAY_MESSAGE_BYTES = 2 * 1024 * 1024;
const RELAY_COMMAND_TTL_SECONDS = 30;
const RELAY_COMMAND_SKEW_SECONDS = 60;
const MAX_JTI_CACHE_SIZE = 5000;
const RELAY_WS_IDLE_TIMEOUT_MS =
  Number(process.env.BRIDGE_RELAY_WS_IDLE_TIMEOUT_MS) || 90000;

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
  auth?: {
    bridgeKeyId: string;
    algorithm: "ed25519";
  };
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
  meta?: RelayCommandMetaT;
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

interface RelayBridgeAuthChallengeMessage {
  type: "bridge_auth_challenge";
  bridgeId: string;
  challengeId: string;
  nonce: string;
  iat: number;
  exp: number;
  bridgeKeyId: string;
  algorithm: "ed25519";
}

interface RelayBridgeAuthOkMessage {
  type: "bridge_auth_ok";
  bridgeId: string;
}

interface RelayBridgeAuthErrorMessage {
  type: "bridge_auth_error";
  bridgeId?: string;
  error: string;
}

interface BridgeAuthResponseMessage {
  type: "bridge_auth_response";
  bridgeId: string;
  challengeId: string;
  bridgeKeyId: string;
  algorithm: "ed25519";
  signature: string;
}

type RelayMessage =
  | RelayCommandMessage
  | RelayBridgeAuthChallengeMessage
  | RelayBridgeAuthOkMessage
  | RelayBridgeAuthErrorMessage;

type PublicKeyCacheEntry = {
  kid: string;
  key: ReturnType<typeof createPublicKey>;
};

type RelaySocketLikeT = {
  readyState: number;
  on: (event: string, listener: (...args: any[]) => void) => void;
  send: (data: string) => void;
  close: () => void;
  terminate: () => void;
};

type RelayClientDepsT = {
  createWebSocket?: (url: string) => RelaySocketLikeT;
  getVersion?: () => string;
  getEnrollmentPublicKey?: typeof getRelayBridgeEnrollmentPublicKey;
  signAuthChallenge?: typeof signRelayBridgeAuthChallenge;
  verifySignedCommand?: (message: RelayCommandMessage) => Promise<void>;
  isRelayCommand?: (command: string) => boolean;
  handleCommand?: (
    command: RelayCommand,
    payload?: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>;
  now?: () => Date;
  relayIdleTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

const publicKeyCache = new Map<string, PublicKeyCacheEntry>();
let jwksRefreshInFlight: Promise<void> | null = null;
const seenJti = new Map<string, number>();

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

const defaultHandleCommand = async (
  command: RelayCommand,
  payload?: Record<string, unknown>,
) => {
  const { commandRouter } = await import("./command-router.js");
  return commandRouter.handleCommand(command, payload);
};

/**
 * Relay Client Service
 *
 * Manages outbound WebSocket connection to Relay Server.
 * Handles bridge registration, command reception, and result sending.
 */
export class RelayClient {
  private ws: RelaySocketLikeT | null = null;
  private bridgeId: string;
  private relayUrl: string;
  private bridgeName?: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 60000; // Max 60 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private relayLivenessTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isShuttingDown = false;
  private lastSeen: Date | null = null;
  private logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  private readonly deps: RelayClientDepsT;

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
      debug?: (msg: string) => void;
    },
    bridgeName?: string,
    deps: RelayClientDepsT = {},
  ) {
    this.bridgeId = bridgeId;
    this.relayUrl = relayUrl;
    this.bridgeName = bridgeName;
    this.deps = deps;
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

  private markRelayActivity(source: string): void {
    this.lastSeen = (this.deps.now ?? (() => new Date()))();
    this.resetRelayLivenessWatchdog();
    this.logger.debug?.(`[RelayClient] Relay activity: ${source}`);
  }

  private resetRelayLivenessWatchdog(): void {
    if (this.relayLivenessTimer) {
      clearTimeout(this.relayLivenessTimer);
      this.relayLivenessTimer = null;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.isShuttingDown) {
      return;
    }

    const relayIdleTimeoutMs =
      this.deps.relayIdleTimeoutMs ?? RELAY_WS_IDLE_TIMEOUT_MS;
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout;
    this.relayLivenessTimer = setTimeoutFn(() => {
      this.relayLivenessTimer = null;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      this.logger.warn(
        `Relay connection idle for >${relayIdleTimeoutMs}ms, terminating socket`
      );
      try {
        this.ws.terminate();
      } catch {
        // Ignore terminate errors; close handler will drive reconnect.
      }
    }, relayIdleTimeoutMs);
    this.relayLivenessTimer.unref?.();
  }

  private clearRelayLivenessWatchdog(): void {
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout;
    if (this.relayLivenessTimer) {
      clearTimeoutFn(this.relayLivenessTimer);
      this.relayLivenessTimer = null;
    }
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

      this.ws = (this.deps.createWebSocket ?? ((url) => new WebSocket(url)))(
        this.relayUrl,
      );

      this.ws.on("open", () => {
        this.logger.info("Connected to relay server");
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.markRelayActivity("open");

        // Send bridge_hello message
        this.sendHello();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.markRelayActivity("message");
        this.handleMessage(data);
      });

      this.ws.on("ping", () => {
        this.markRelayActivity("ping");
      });

      this.ws.on("pong", () => {
        this.markRelayActivity("pong");
      });

      this.ws.on("close", () => {
        this.logger.warn("Disconnected from relay server");
        this.clearRelayLivenessWatchdog();
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
        this.clearRelayLivenessWatchdog();
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
      version: getRuntimeAppVersion(),
    };
    if (this.bridgeName) {
      message.bridgeName = this.bridgeName;
    }
    const getEnrollmentPublicKey =
      this.deps.getEnrollmentPublicKey ?? getRelayBridgeEnrollmentPublicKey;
    const getVersionValue = this.deps.getVersion ?? getRuntimeAppVersion;
    message.version = getVersionValue();
    void getEnrollmentPublicKey()
      .then((identity) => {
        message.auth = {
          bridgeKeyId: identity.keyId,
          algorithm: identity.algorithm,
        };
      })
      .catch(() => {
        // Best-effort capability advertisement; relay can still fall back during rollout.
      })
      .finally(() => {
        this.send(message);
        this.logger.debug?.(`Sent bridge_hello with bridgeId: ${this.bridgeId}`);
      });
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
      this.lastSeen = (this.deps.now ?? (() => new Date()))();

      if (message.type === "bridge_auth_challenge") {
        await this.handleBridgeAuthChallenge(message);
      } else if (message.type === "bridge_auth_ok") {
        this.logger.info("Relay bridge auth successful");
      } else if (message.type === "bridge_auth_error") {
        this.logger.warn(`Relay bridge auth failed: ${message.error}`);
        this.ws?.close();
      } else if (message.type === "command") {
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

  private async handleBridgeAuthChallenge(
    message: RelayBridgeAuthChallengeMessage,
  ): Promise<void> {
    if (message.bridgeId !== this.bridgeId) {
      this.logger.warn("Ignored bridge auth challenge for different bridgeId");
      return;
    }

    try {
      const signAuthChallenge =
        this.deps.signAuthChallenge ?? signRelayBridgeAuthChallenge;
      const { bridgeKeyId, algorithm, signature } =
        await signAuthChallenge({
          bridgeId: message.bridgeId,
          challengeId: message.challengeId,
          nonce: message.nonce,
          iat: message.iat,
          exp: message.exp,
          bridgeKeyId: message.bridgeKeyId,
          algorithm: message.algorithm,
        });

      const response: BridgeAuthResponseMessage = {
        type: "bridge_auth_response",
        bridgeId: message.bridgeId,
        challengeId: message.challengeId,
        bridgeKeyId,
        algorithm,
        signature,
      };
      this.send(response);
      this.logger.debug?.("Sent bridge_auth_response");
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Bridge auth signing failed";
      this.logger.warn(`Failed to sign bridge auth challenge: ${errorMessage}`);
      this.ws?.close();
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

    const isKnownRelayCommand = this.deps.isRelayCommand ?? isRelayCommand;
    if (!isKnownRelayCommand(message.command)) {
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
      const handleCommand = this.deps.handleCommand ?? defaultHandleCommand;
      const result = await handleCommand(command, message.payload);

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
    if (this.deps.verifySignedCommand) {
      await this.deps.verifySignedCommand(message);
      return;
    }
    await verifySignedRelayCommand({
      message,
      bridgeId: this.bridgeId,
      getPublicKey,
      seenJti,
      relayCommandSkewSeconds: RELAY_COMMAND_SKEW_SECONDS,
      relayCommandTtlSeconds: RELAY_COMMAND_TTL_SECONDS,
      maxJtiCacheSize: MAX_JTI_CACHE_SIZE,
    });
  }

  /**
   * Schedule reconnect with exponential backoff
   */
  private scheduleReconnect(): void {
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout;
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout;
    if (this.reconnectTimer) {
      clearTimeoutFn(this.reconnectTimer);
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

    this.reconnectTimer = setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Disconnect from relay
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.clearRelayLivenessWatchdog();

    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout;
    if (this.reconnectTimer) {
      clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.logger.info("Disconnected from relay");
  }
}
