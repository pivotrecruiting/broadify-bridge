import { verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";

export interface RelayCommandMetaT {
  bridgeId: string;
  orgId: string;
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}

export interface SignedRelayCommandMessageT {
  requestId: string;
  command: string;
  payload?: Record<string, unknown>;
  meta?: RelayCommandMetaT;
  signature?: string;
}

export interface VerifySignedRelayCommandParamsT {
  message: SignedRelayCommandMessageT;
  bridgeId: string;
  getPublicKey: (kid: string) => Promise<KeyObject | undefined>;
  seenJti: Map<string, number>;
  nowSec?: number;
  relayCommandSkewSeconds?: number;
  relayCommandTtlSeconds?: number;
  maxJtiCacheSize?: number;
  /**
   * Returns true when the caller already holds a cached or in-flight result for
   * this requestId. Only consulted after the signature has been verified; it
   * lets an identical relay redelivery be served from that result instead of
   * being rejected as a replay.
   */
  isKnownRequestId?: (requestId: string) => boolean;
}

export interface VerifySignedRelayCommandResultT {
  /**
   * True when the (validly signed) command carries a jti that was already
   * accepted and the caller knows its requestId, i.e. a relay redelivery.
   */
  replayedJti: boolean;
}

/**
 * Decode URL-safe base64 data.
 */
export const base64UrlDecode = (value: string): Buffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const normalized = padded + "=".repeat(padLength);
  return Buffer.from(normalized, "base64");
};

/**
 * Encode buffer to URL-safe base64 (no padding).
 */
export const base64UrlEncode = (value: Buffer): string => {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

/**
 * Create canonical JSON output with stable key ordering.
 */
export const stableStringify = (value: unknown): string => {
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

/**
 * Remove expired JTI entries and cap cache size.
 */
export const pruneJtiCache = (
  seenJti: Map<string, number>,
  nowSec: number,
  maxSize: number,
): void => {
  for (const [jti, exp] of seenJti.entries()) {
    if (exp <= nowSec) {
      seenJti.delete(jti);
    }
  }
  while (seenJti.size > maxSize) {
    const oldest = seenJti.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    seenJti.delete(oldest);
  }
};

/**
 * Verify signed relay command metadata, scope, time window, signature and
 * anti-replay, in that order. The jti check runs only on authenticated input
 * (after a valid signature) so an observed jti cannot be used to block a
 * legitimate command. A seen jti is tolerated only when the caller already
 * knows the requestId (redelivery); otherwise it is rejected as a replay.
 */
export const verifySignedRelayCommand = async (
  params: VerifySignedRelayCommandParamsT,
): Promise<VerifySignedRelayCommandResultT> => {
  const {
    message,
    bridgeId,
    getPublicKey,
    seenJti,
    nowSec = Math.floor(Date.now() / 1000),
    relayCommandSkewSeconds = 60,
    maxJtiCacheSize = 5000,
    isKnownRequestId,
  } = params;

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

  if (meta.bridgeId !== bridgeId) {
    throw new Error("Bridge ID mismatch");
  }

  const scopeToken = `command:${message.command}`;
  if (!meta.scope.includes(scopeToken) && !meta.scope.includes("*")) {
    throw new Error("Scope mismatch");
  }

  if (meta.exp + relayCommandSkewSeconds < nowSec) {
    throw new Error("Command expired");
  }
  if (meta.iat - relayCommandSkewSeconds > nowSec) {
    throw new Error("Command timestamp invalid");
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

  // Anti-replay runs only on authenticated input.
  pruneJtiCache(seenJti, nowSec, maxJtiCacheSize);
  const existing = seenJti.get(meta.jti);
  if (existing && existing > nowSec) {
    if (isKnownRequestId?.(message.requestId) === true) {
      return { replayedJti: true };
    }
    throw new Error("Replay detected");
  }

  // Remember the jti for the whole acceptance window (exp + skew), otherwise
  // the same signed command would be accepted again between exp and exp+skew.
  seenJti.set(meta.jti, meta.exp + relayCommandSkewSeconds);
  return { replayedJti: false };
};
